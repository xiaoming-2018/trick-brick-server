-- D1 表结构 + 默认关卡时长。与原 Express 版 src/db.js 的建表语句一致。
-- 初始化：wrangler d1 execute trick-brick --remote --file=schema.sql
-- 可重复执行（IF NOT EXISTS / INSERT OR IGNORE），不会覆盖已有配置与数据。

CREATE TABLE IF NOT EXISTS level_config (
  level_index   INTEGER PRIMARY KEY,
  time_seconds  INTEGER NOT NULL,
  name          TEXT,
  updated_at    TEXT,
  updated_by    TEXT DEFAULT 'system'
);

-- 一次「从头开始玩」= 一个 run
CREATE TABLE IF NOT EXISTS run (
  run_id            TEXT PRIMARY KEY,
  ip_hash           TEXT,
  geo               TEXT,
  user_agent        TEXT,
  visitor_id        TEXT,
  started_at        TEXT,
  last_seen_at      TEXT,
  max_level_reached INTEGER DEFAULT 0,
  ended_reason      TEXT
);

-- 每关每次尝试一条
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

-- 默认过关时长（与游戏 trick-brick/index.html 的 LEVELS[i].time 保持一致）。
-- 仅当该关尚不存在时灌入，已有配置不覆盖。
INSERT OR IGNORE INTO level_config (level_index, time_seconds, name, updated_at, updated_by) VALUES
  (0, 8,  '第一关 · 填充', '1970-01-01T00:00:00.000Z', 'system'),
  (1, 34, '第二关 · 毁灭', '1970-01-01T00:00:00.000Z', 'system'),
  (2, 30, '第三关 · 生长', '1970-01-01T00:00:00.000Z', 'system'),
  (3, 22, '第四关 · 协调', '1970-01-01T00:00:00.000Z', 'system'),
  (4, 25, '第五关 · 距离', '1970-01-01T00:00:00.000Z', 'system'),
  (5, 51, '第六关 · 抵抗', '1970-01-01T00:00:00.000Z', 'system'),
  (6, 55, '第七关 · 保护', '1970-01-01T00:00:00.000Z', 'system');
