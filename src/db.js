// Postgres 连接 + 建表 + 默认时长灌入。
// 原 better-sqlite3(本地文件、同步)改为 pg(托管 Postgres、异步),数据可跨重启持久化。
import './env.js';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('[config] DATABASE_URL 未设置(Render Postgres 连接串)');
}

// 外部连接(.render.com / 含 sslmode=require)需 SSL;内部连接与本地无需。
const needSsl = /\.render\.com|sslmode=require|amazonaws\.com/.test(connectionString) ||
  process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString,
  ssl: needSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

// ---------- 默认过关时长 ----------
// 名称取自游戏 LEVEL_INTROS 主题名;time 与 trick-brick/index.html 的 LEVELS[i].time 一致。
export const DEFAULT_LEVELS = [
  { index: 0, time: 8,  name: '第一关 · 填充' },
  { index: 1, time: 34, name: '第二关 · 毁灭' },
  { index: 2, time: 30, name: '第三关 · 生长' },
  { index: 3, time: 22, name: '第四关 · 协调' },
  { index: 4, time: 25, name: '第五关 · 距离' },
  { index: 5, time: 51, name: '第六关 · 抵抗' },
  { index: 6, time: 55, name: '第七关 · 保护' },
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS level_config (
    level_index   INTEGER PRIMARY KEY,
    time_seconds  INTEGER NOT NULL,
    name          TEXT,
    updated_at    TEXT,
    updated_by    TEXT DEFAULT 'system'
  );

  CREATE TABLE IF NOT EXISTS run (
    run_id            TEXT PRIMARY KEY,
    ip_hash           TEXT,
    geo               TEXT,
    user_agent        TEXT,
    started_at        TEXT,
    last_seen_at      TEXT,
    max_level_reached INTEGER DEFAULT 0,
    ended_reason      TEXT
  );

  CREATE TABLE IF NOT EXISTS level_attempt (
    id             BIGSERIAL PRIMARY KEY,
    run_id         TEXT,
    level_index    INTEGER,
    attempt_no     INTEGER,
    allotted_time  INTEGER,
    outcome        TEXT,
    duration_ms    INTEGER,
    time_left_ms   INTEGER,
    completion_pct INTEGER,
    started_at     TEXT,
    ended_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_attempt_level ON level_attempt(level_index);
  CREATE INDEX IF NOT EXISTS idx_attempt_run   ON level_attempt(run_id);
`;

// 建表 + 灌默认时长(已存在则不覆盖)。带重试,容忍 DB 启动稍慢。
export async function initDb() {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      await pool.query(SCHEMA);
      const now = new Date().toISOString();
      for (const lv of DEFAULT_LEVELS) {
        await pool.query(
          `INSERT INTO level_config (level_index, time_seconds, name, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, 'system')
           ON CONFLICT (level_index) DO NOTHING`,
          [lv.index, lv.time, lv.name, now]
        );
      }
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[db] init 第 ${i + 1} 次失败: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

// ---------- 查询封装 ----------
export async function getLevelConfig() {
  const { rows } = await pool.query(
    'SELECT level_index, time_seconds FROM level_config ORDER BY level_index'
  );
  return rows;
}

export async function getAdminLevels() {
  const { rows } = await pool.query(
    'SELECT level_index, time_seconds, name, updated_at, updated_by FROM level_config ORDER BY level_index'
  );
  return rows;
}

// 改单关时长,返回受影响行数(0 表示该关不存在)
export async function updateLevel(idx, timeSeconds) {
  const r = await pool.query(
    'UPDATE level_config SET time_seconds = $1, updated_at = $2, updated_by = $3 WHERE level_index = $4',
    [Math.round(timeSeconds), new Date().toISOString(), 'admin', idx]
  );
  return r.rowCount;
}

// 清除历史埋点数据(run / level_attempt),事务保证两表同清,不影响关卡配置
export async function clearHistory() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query('DELETE FROM level_attempt');
    const r = await client.query('DELETE FROM run');
    await client.query('COMMIT');
    return { level_attempt: a.rowCount, run: r.rowCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
