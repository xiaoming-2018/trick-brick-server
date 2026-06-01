// 难度分析聚合:从 run / level_attempt 计算每关指标、漏斗与调参建议(Postgres,异步)。
// 注意:pg 默认把 COUNT/SUM 的 bigint、numeric 当字符串返回,故 SQL 里统一 ::int / ::float8 转型。
import { pool, DEFAULT_LEVELS } from './db.js';

// 关卡名(优先用配置表里的 name,回退默认)
async function levelNames() {
  const { rows } = await pool.query('SELECT level_index, name, time_seconds FROM level_config ORDER BY level_index');
  const map = {};
  rows.forEach((r) => { map[r.level_index] = { name: r.name, time: r.time_seconds }; });
  DEFAULT_LEVELS.forEach((l) => { if (!map[l.index]) map[l.index] = { name: l.name, time: l.time }; });
  return map;
}

// 难度分(0~100,越高越难):综合通关率/重试/时间紧张/流失
function difficultyScore(m) {
  const passRate = m.runs_attempted ? m.runs_won / m.runs_attempted : 0;
  const attemptsExtra = Math.min(Math.max((m.avg_attempts || 1) - 1, 0), 3) / 3; // 0~1
  const timePressure = 1 - Math.min(Math.max(m.avg_time_left_ratio || 0, 0), 1);  // 剩余越少越紧
  const churn = m.reached ? (m.reached - m.runs_won) / m.reached : 0;
  const score = (1 - passRate) * 40 + attemptsExtra * 25 + timePressure * 20 + churn * 15;
  return Math.round(Math.min(100, Math.max(0, score)));
}

// 调参建议
function suggestion(m) {
  if (m.attempts_total < 5) return { level: 'info', text: '样本不足,建议积累更多数据后再判断' };
  const passRate = m.runs_attempted ? m.runs_won / m.runs_attempted : 0;
  const tl = m.avg_time_left_ratio || 0;
  const fail = m.avg_fail_completion || 0;
  if (passRate >= 0.8 && tl > 0.5) {
    const cut = Math.round((m.allotted || 0) * Math.min(tl - 0.2, 0.4));
    return { level: 'loose', text: `时长偏松(平均剩余 ${Math.round(tl * 100)}%),可考虑下调约 ${cut}s` };
  }
  if (passRate < 0.5 && tl < 0.12 && fail >= 65) {
    return { level: 'tight', text: `玩家常差一点(失败平均完成 ${Math.round(fail)}%、几乎用尽时间),建议加时` };
  }
  if (passRate < 0.5 && fail < 45) {
    return { level: 'hard', text: `机制偏难(失败平均完成仅 ${Math.round(fail)}%),加时收效有限,考虑降低难度` };
  }
  return { level: 'ok', text: '难度与时长大致合理' };
}

export async function computeStats(range = {}) {
  const { from, to } = range;
  // 时间范围过滤(作用于 level_attempt.ended_at / run.started_at),位置参数 $n 按入数组顺序
  const aWhere = [], aP = [];
  if (from) { aP.push(from); aWhere.push(`ended_at >= $${aP.length}`); }
  if (to) { aP.push(to); aWhere.push(`ended_at <= $${aP.length}`); }
  const aClause = aWhere.length ? 'WHERE ' + aWhere.join(' AND ') : '';

  const rWhere = [], rP = [];
  if (from) { rP.push(from); rWhere.push(`started_at >= $${rP.length}`); }
  if (to) { rP.push(to); rWhere.push(`started_at <= $${rP.length}`); }
  const rClause = rWhere.length ? 'WHERE ' + rWhere.join(' AND ') : '';

  const names = await levelNames();

  // 每关聚合
  const { rows } = await pool.query(`
    SELECT level_index,
      COUNT(*)::int                                                       AS attempts_total,
      SUM(CASE WHEN outcome='win'  THEN 1 ELSE 0 END)::int                AS wins,
      SUM(CASE WHEN outcome='lose' THEN 1 ELSE 0 END)::int                AS loses,
      COUNT(DISTINCT run_id)::int                                         AS runs_attempted,
      COUNT(DISTINCT CASE WHEN outcome='win' THEN run_id END)::int        AS runs_won,
      SUM(CASE WHEN attempt_no=1 THEN 1 ELSE 0 END)::int                  AS first_attempts,
      SUM(CASE WHEN attempt_no=1 AND outcome='win' THEN 1 ELSE 0 END)::int AS first_wins,
      AVG(CASE WHEN outcome='win'  THEN duration_ms END)::float8          AS avg_win_duration,
      AVG(CASE WHEN outcome='win' AND allotted_time>0
               THEN 1.0*time_left_ms/(allotted_time*1000.0) END)::float8  AS avg_time_left_ratio,
      AVG(CASE WHEN outcome='lose' THEN completion_pct END)::float8       AS avg_fail_completion
    FROM level_attempt
    ${aClause}
    GROUP BY level_index
  `, aP);
  const byLevel = {};
  rows.forEach((r) => { byLevel[r.level_index] = r; });

  // 漏斗:到达人数(run.max_level_reached >= level) 与 通过人数(该关有 win 的 run)
  // 同时取 ip_hash 用于独立访客(UV)去重
  const { rows: reachedRows } = await pool.query(`
    SELECT max_level_reached, ip_hash FROM run ${rClause}
  `, rP);

  const totalRuns = reachedRows.length;
  // 独立访客:按 ip_hash 去重(近似 UV;同网络多人会偏少、跨网络同人会偏多)
  const uniqueVisitors = new Set(reachedRows.map((x) => x.ip_hash).filter(Boolean)).size;
  const { rows: clearedRows } = await pool.query(`
    SELECT COUNT(*)::int AS c FROM run ${rClause ? rClause + ' AND' : 'WHERE'} ended_reason='cleared'
  `, rP);
  const clearedRuns = clearedRows[0].c;

  const levelCount = Math.max(
    DEFAULT_LEVELS.length,
    rows.length ? Math.max(...rows.map((r) => r.level_index)) + 1 : 0
  );

  const levels = [];
  for (let i = 0; i < levelCount; i++) {
    const r = byLevel[i] || {};
    const reached = reachedRows.filter((x) => x.max_level_reached >= i).length;
    const m = {
      level_index: i,
      name: names[i] ? names[i].name : '第' + (i + 1) + '关',
      allotted: names[i] ? names[i].time : null,
      attempts_total: r.attempts_total || 0,
      wins: r.wins || 0,
      loses: r.loses || 0,
      runs_attempted: r.runs_attempted || 0,
      runs_won: r.runs_won || 0,
      reached,
      first_try_pass_rate: r.first_attempts ? r.first_wins / r.first_attempts : null,
      avg_attempts: r.runs_attempted ? r.attempts_total / r.runs_attempted : null,
      pass_rate: r.runs_attempted ? r.runs_won / r.runs_attempted : null,
      avg_win_duration: r.avg_win_duration != null ? Math.round(r.avg_win_duration) : null,
      avg_time_left_ratio: r.avg_time_left_ratio != null ? r.avg_time_left_ratio : null,
      avg_fail_completion: r.avg_fail_completion != null ? r.avg_fail_completion : null,
      churn_rate: reached ? (reached - (r.runs_won || 0)) / reached : null,
    };
    m.difficulty = difficultyScore(m);
    m.suggestion = suggestion(m);
    levels.push(m);
  }

  return {
    range: { from: from || null, to: to || null },
    overview: {
      unique_visitors: uniqueVisitors,
      total_runs: totalRuns,
      cleared_runs: clearedRuns,
      total_attempts: rows.reduce((s, r) => s + (r.attempts_total || 0), 0),
    },
    levels,
  };
}
