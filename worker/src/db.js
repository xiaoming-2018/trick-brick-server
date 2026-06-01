// D1 查询封装。原 src/db.js 的同步 better-sqlite3 改为异步 D1。
// 建表与默认时长灌入已移到 schema.sql（部署时 wrangler d1 execute 执行）。

// 默认过关时长，仅 stats 在配置缺失时回退使用（与 schema.sql 的 seed 保持一致）。
export const DEFAULT_LEVELS = [
  { index: 0, time: 8,  name: '❤ 爱心(新手引导)' },
  { index: 1, time: 34, name: '🟧 回字方块' },
  { index: 2, time: 30, name: '🐸 青蛙 · 认识黑砖' },
  { index: 3, time: 22, name: '🌱 带茎花 · 认识绿砖' },
  { index: 4, time: 25, name: '🧩 拼图' },
  { index: 5, time: 51, name: '🟩 方块' },
  { index: 6, time: 55, name: '🔥 能量反应堆 · 综合挑战' },
];

// 公开 API：关卡时长配置
export async function getLevelConfig(DB) {
  const { results } = await DB.prepare(
    'SELECT level_index, time_seconds FROM level_config ORDER BY level_index'
  ).all();
  return results;
}

// 后台：读全部关卡配置（含名称、更新信息）
export async function getAdminLevels(DB) {
  const { results } = await DB.prepare(
    'SELECT level_index, time_seconds, name, updated_at, updated_by FROM level_config ORDER BY level_index'
  ).all();
  return results;
}

// 后台：改单关时长，返回受影响行数（0 表示该关不存在）
export async function updateLevel(DB, idx, timeSeconds) {
  const res = await DB.prepare(
    'UPDATE level_config SET time_seconds = ?, updated_at = ?, updated_by = ? WHERE level_index = ?'
  ).bind(Math.round(timeSeconds), new Date().toISOString(), 'admin', idx).run();
  return res.meta.changes;
}
