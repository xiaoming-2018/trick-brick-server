// SQLite 连接 + 建表 + 默认时长灌入
import './env.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.cwd(), process.env.DATA_DIR)
  : join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

// ---------- 默认过关时长 ----------
// 与游戏 trick-brick/index.html 中 LEVELS[i].time 保持一致，作为后端初始值。
// 这是「权威默认」：前端读不到后端时仍用自身代码里的同一组值，二者一致即天然 fallback。
export const DEFAULT_LEVELS = [
  { index: 0, time: 8,  name: '❤ 爱心(新手引导)' },
  { index: 1, time: 34, name: '🟧 回字方块' },
  { index: 2, time: 30, name: '🐸 青蛙 · 认识黑砖' },
  { index: 3, time: 22, name: '🌱 带茎花 · 认识绿砖' },
  { index: 4, time: 25, name: '🧩 拼图' },
  { index: 5, time: 51, name: '🟩 方块' },
  { index: 6, time: 55, name: '🔥 能量反应堆 · 综合挑战' },
];

// ---------- 建表 ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS level_config (
    level_index   INTEGER PRIMARY KEY,
    time_seconds  INTEGER NOT NULL,
    name          TEXT,
    updated_at    TEXT,
    updated_by    TEXT DEFAULT 'system'
  );

  -- 一次「从头开始玩」= 一个 run（P2 起写入）
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

  -- 每关每次尝试一条（P2 起写入）
  CREATE TABLE IF NOT EXISTS level_attempt (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
`);

// ---------- 灌入默认时长（仅当该关尚不存在，已有配置不覆盖）----------
const seedStmt = db.prepare(
  `INSERT OR IGNORE INTO level_config (level_index, time_seconds, name, updated_at, updated_by)
   VALUES (@index, @time, @name, @now, 'system')`
);
const now = new Date().toISOString();
const seedAll = db.transaction((levels) => {
  for (const lv of levels) seedStmt.run({ ...lv, now });
});
seedAll(DEFAULT_LEVELS);

// ---------- 查询封装 ----------
export function getLevelConfig() {
  return db
    .prepare('SELECT level_index, time_seconds FROM level_config ORDER BY level_index')
    .all();
}
