// 埋点接收与持久化：把前端事件写入 run / level_attempt。原 src/track.js 的逐条同步写入
// 改为收集 D1 prepared statements 后一次 DB.batch() 提交（减少往返、且具事务语义）。
// ip 在调用方已哈希为 ipHash 传入，前端不可伪造明文 IP。

const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
function int(v, lo, hi, dflt = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.round(n);
  if (lo != null && i < lo) return lo;
  if (hi != null && i > hi) return hi;
  return i;
}

// 接收单事件或事件数组，批量入库。
export async function recordEvents(DB, body, ipHash, ua) {
  const events = Array.isArray(body) ? body : [body];
  const now = new Date().toISOString();
  const safeUa = (ua || '').slice(0, 300);
  const stmts = [];
  for (const ev of events.slice(0, 50)) {
    collectStatements(DB, stmts, ev, ipHash, safeUa, now);
  }
  if (stmts.length) await DB.batch(stmts);
}

// 任何事件先确保 run 行存在（防 game_start beacon 丢失导致孤儿尝试）
function ensureRun(DB, run_id, ipHash, ua, now) {
  return DB.prepare(
    `INSERT OR IGNORE INTO run (run_id, ip_hash, user_agent, started_at, last_seen_at, max_level_reached, ended_reason)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`
  ).bind(run_id, ipHash, ua, now, now);
}
function touchRun(DB, run_id, now, lvl) {
  return DB.prepare(
    `UPDATE run SET last_seen_at = ?, max_level_reached = MAX(max_level_reached, ?) WHERE run_id = ?`
  ).bind(now, lvl, run_id);
}

function collectStatements(DB, stmts, ev, ipHash, ua, now) {
  if (!ev || !isStr(ev.run_id)) return;
  const run_id = ev.run_id;
  stmts.push(ensureRun(DB, run_id, ipHash, ua, now));

  switch (ev.type) {
    case 'game_start':
      // run 行已由 ensureRun 建好
      return;

    case 'level_start': {
      const lvl = int(ev.level_index, 0, 999, 0);
      stmts.push(touchRun(DB, run_id, now, lvl));
      return;
    }

    case 'level_win':
    case 'level_lose': {
      const lvl = int(ev.level_index, 0, 999, 0);
      const outcome = ev.type === 'level_win' ? 'win' : 'lose';
      stmts.push(DB.prepare(
        `INSERT INTO level_attempt
           (run_id, level_index, attempt_no, allotted_time, outcome, duration_ms, time_left_ms, completion_pct, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        run_id,
        lvl,
        int(ev.attempt_no, 1, 9999, 1),
        int(ev.allotted_time, 0, 100000, 0),
        outcome,
        int(ev.duration_ms, 0, 36000000, 0),
        int(ev.time_left_ms, 0, 36000000, 0),
        int(ev.completion_pct, 0, 100, outcome === 'win' ? 100 : 0),
        isStr(ev.started_at) ? ev.started_at : null,
        now
      ));
      stmts.push(touchRun(DB, run_id, now, lvl));
      return;
    }

    case 'run_quit': {
      const reason = ev.reason === 'cleared' ? 'cleared' : 'quit';
      const lvl = int(ev.max_level_reached, 0, 999, 0);
      stmts.push(DB.prepare(
        `UPDATE run SET last_seen_at = ?, ended_reason = ?, max_level_reached = MAX(max_level_reached, ?) WHERE run_id = ?`
      ).bind(now, reason, lvl, run_id));
      return;
    }

    default:
      return; // 未知事件类型，忽略
  }
}
