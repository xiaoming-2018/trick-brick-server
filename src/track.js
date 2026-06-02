// 埋点接收与持久化:把前端上报的事件写入 run / level_attempt 表(Postgres,异步)。
import './env.js';
import crypto from 'node:crypto';
import { pool } from './db.js';

const IP_SALT = process.env.IP_SALT || 'dev-salt';
const INSECURE_IP_SALT_VALUES = new Set(['', 'dev-salt', 'please-change-this-salt']);

if (process.env.NODE_ENV === 'production' && INSECURE_IP_SALT_VALUES.has(IP_SALT)) {
  throw new Error('[config] IP_SALT must be set to a secure value in production');
}

// IP 不落明文:加盐 sha256 后取前 32 hex,仅用于去重/防刷/统计
export function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '') + IP_SALT).digest('hex').slice(0, 32);
}

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

// 任何事件先确保 run 行存在(防 game_start beacon 丢失导致孤儿尝试)
// visitor_id 由前端 localStorage 生成并随每条事件上报;为空时用后续事件回填。
async function ensureRun(run_id, ip_hash, ua, visitor_id, now) {
  await pool.query(
    `INSERT INTO run (run_id, ip_hash, user_agent, visitor_id, started_at, last_seen_at, max_level_reached, ended_reason)
     VALUES ($1, $2, $3, $4, $5, $5, 0, NULL)
     ON CONFLICT (run_id) DO UPDATE SET visitor_id = COALESCE(run.visitor_id, EXCLUDED.visitor_id)`,
    [run_id, ip_hash, ua, visitor_id, now]
  );
}
async function touchRun(run_id, now, lvl) {
  await pool.query(
    `UPDATE run SET last_seen_at = $1, max_level_reached = GREATEST(max_level_reached, $2) WHERE run_id = $3`,
    [now, lvl, run_id]
  );
}

// 处理单个事件。ip 由调用方(app.js)从请求获取并传入,前端不可伪造。
export async function recordEvent(ev, ip, ua) {
  if (!ev || !isStr(ev.run_id)) return false;
  const now = new Date().toISOString();
  const run_id = ev.run_id;
  const ip_hash = hashIp(ip);
  const visitor_id = isStr(ev.visitor_id) ? ev.visitor_id : null;

  await ensureRun(run_id, ip_hash, (ua || '').slice(0, 300), visitor_id, now);

  switch (ev.type) {
    case 'game_start':
      return true;

    case 'level_start': {
      const lvl = int(ev.level_index, 0, 999, 0);
      await touchRun(run_id, now, lvl);
      return true;
    }

    case 'level_win':
    case 'level_lose': {
      const lvl = int(ev.level_index, 0, 999, 0);
      const outcome = ev.type === 'level_win' ? 'win' : 'lose';
      await pool.query(
        `INSERT INTO level_attempt
           (run_id, level_index, attempt_no, allotted_time, outcome, duration_ms, time_left_ms, completion_pct, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          run_id,
          lvl,
          int(ev.attempt_no, 1, 9999, 1),
          int(ev.allotted_time, 0, 100000, 0),
          outcome,
          int(ev.duration_ms, 0, 36000000, 0),
          int(ev.time_left_ms, 0, 36000000, 0),
          int(ev.completion_pct, 0, 100, outcome === 'win' ? 100 : 0),
          isStr(ev.started_at) ? ev.started_at : null,
          now,
        ]
      );
      await touchRun(run_id, now, lvl);
      return true;
    }

    case 'run_quit': {
      const reason = ev.reason === 'cleared' ? 'cleared' : 'quit';
      const lvl = int(ev.max_level_reached, 0, 999, 0);
      await pool.query(
        `UPDATE run SET last_seen_at = $1, ended_reason = $2, max_level_reached = GREATEST(max_level_reached, $3) WHERE run_id = $4`,
        [now, reason, lvl, run_id]
      );
      return true;
    }

    default:
      return false; // 未知事件类型,忽略
  }
}
