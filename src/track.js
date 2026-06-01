// 埋点接收与持久化:把前端上报的事件写入 run / level_attempt 表
import './env.js';
import crypto from 'node:crypto';
import { db } from './db.js';

const IP_SALT = process.env.IP_SALT || 'dev-salt';
const INSECURE_IP_SALT_VALUES = new Set(['', 'dev-salt', 'please-change-this-salt']);

if (process.env.NODE_ENV === 'production' && INSECURE_IP_SALT_VALUES.has(IP_SALT)) {
  throw new Error('[config] IP_SALT must be set to a secure value in production');
}

// IP 不落明文:加盐 sha256 后取前 32 hex,仅用于去重/防刷/统计
export function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '') + IP_SALT).digest('hex').slice(0, 32);
}

// ---------- 预编译语句 ----------
const ensureRun = db.prepare(
  `INSERT OR IGNORE INTO run (run_id, ip_hash, user_agent, started_at, last_seen_at, max_level_reached, ended_reason)
   VALUES (@run_id, @ip_hash, @ua, @now, @now, 0, NULL)`
);
const touchRun = db.prepare(
  `UPDATE run SET last_seen_at = @now,
                  max_level_reached = MAX(max_level_reached, @lvl)
   WHERE run_id = @run_id`
);
const endRun = db.prepare(
  `UPDATE run SET last_seen_at = @now,
                  ended_reason = @reason,
                  max_level_reached = MAX(max_level_reached, @lvl)
   WHERE run_id = @run_id`
);
const insAttempt = db.prepare(
  `INSERT INTO level_attempt
     (run_id, level_index, attempt_no, allotted_time, outcome, duration_ms, time_left_ms, completion_pct, started_at, ended_at)
   VALUES
     (@run_id, @level_index, @attempt_no, @allotted_time, @outcome, @duration_ms, @time_left_ms, @completion_pct, @started_at, @now)`
);

// ---------- 校验工具 ----------
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
function int(v, lo, hi, dflt = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.round(n);
  if (lo != null && i < lo) return lo;
  if (hi != null && i > hi) return hi;
  return i;
}

// 处理单个事件。ip 由调用方(app.js)从请求获取并传入,前端不可伪造。
export function recordEvent(ev, ip, ua) {
  if (!ev || !isStr(ev.run_id)) return false;
  const now = new Date().toISOString();
  const run_id = ev.run_id;
  const ip_hash = hashIp(ip);

  // 任何事件都先确保 run 行存在(防 game_start beacon 丢失导致孤儿尝试)
  ensureRun.run({ run_id, ip_hash, ua: (ua || '').slice(0, 300), now });

  switch (ev.type) {
    case 'game_start':
      // run 行已由 ensureRun 建好,无需额外操作
      return true;

    case 'level_start': {
      const lvl = int(ev.level_index, 0, 999, 0);
      touchRun.run({ run_id, now, lvl });
      return true;
    }

    case 'level_win':
    case 'level_lose': {
      const lvl = int(ev.level_index, 0, 999, 0);
      const outcome = ev.type === 'level_win' ? 'win' : 'lose';
      insAttempt.run({
        run_id,
        level_index: lvl,
        attempt_no: int(ev.attempt_no, 1, 9999, 1),
        allotted_time: int(ev.allotted_time, 0, 100000, 0),
        outcome,
        duration_ms: int(ev.duration_ms, 0, 36000000, 0),
        time_left_ms: int(ev.time_left_ms, 0, 36000000, outcome === 'win' ? 0 : 0),
        completion_pct: int(ev.completion_pct, 0, 100, outcome === 'win' ? 100 : 0),
        started_at: isStr(ev.started_at) ? ev.started_at : null,
        now,
      });
      touchRun.run({ run_id, now, lvl });
      return true;
    }

    case 'run_quit': {
      const reason = ev.reason === 'cleared' ? 'cleared' : 'quit';
      const lvl = int(ev.max_level_reached, 0, 999, 0);
      endRun.run({ run_id, now, reason, lvl });
      return true;
    }

    default:
      return false; // 未知事件类型,忽略
  }
}
