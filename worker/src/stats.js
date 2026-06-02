// 难度分析聚合。原 src/stats.js 的同步查询改为异步 D1，命名参数 @from/@to 改为位置参数 ?。
// 纯计算部分（难度分、调参建议）原样保留。
import { DEFAULT_LEVELS } from './db.js';

// 关卡名（优先用配置表里的 name，回退默认）
async function levelNames(DB) {
  const { results } = await DB.prepare(
    'SELECT level_index, name, time_seconds FROM level_config ORDER BY level_index'
  ).all();
  const map = {};
  results.forEach((r) => { map[r.level_index] = { name: r.name, time: r.time_seconds }; });
  DEFAULT_LEVELS.forEach((l) => { if (!map[l.index]) map[l.index] = { name: l.name, time: l.time }; });
  return map;
}

// 从 user_agent 归类平台(顺序有讲究:iPhone 的 UA 含 "Mac OS X")
function classifyPlatform(ua) {
  ua = ua || '';
  if (/OpenHarmony|HarmonyOS|ArkWeb/i.test(ua)) return 'HarmonyOS';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '其他';
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

export async function computeStats(DB, range = {}) {
  const { from, to } = range;
  // 时间范围过滤（作用于 level_attempt.ended_at / run.started_at），位置参数按顺序入数组
  const aWhere = [], aP = [];
  if (from) { aWhere.push('ended_at >= ?'); aP.push(from); }
  if (to) { aWhere.push('ended_at <= ?'); aP.push(to); }
  const aClause = aWhere.length ? 'WHERE ' + aWhere.join(' AND ') : '';

  const rWhere = [], rP = [];
  if (from) { rWhere.push('started_at >= ?'); rP.push(from); }
  if (to) { rWhere.push('started_at <= ?'); rP.push(to); }
  const rClause = rWhere.length ? 'WHERE ' + rWhere.join(' AND ') : '';

  const names = await levelNames(DB);

  // 每关聚合
  const { results: rows } = await DB.prepare(`
    SELECT level_index,
      COUNT(*)                                                          AS attempts_total,
      SUM(CASE WHEN outcome='win'  THEN 1 ELSE 0 END)                   AS wins,
      SUM(CASE WHEN outcome='lose' THEN 1 ELSE 0 END)                   AS loses,
      COUNT(DISTINCT run_id)                                            AS runs_attempted,
      COUNT(DISTINCT CASE WHEN outcome='win' THEN run_id END)           AS runs_won,
      SUM(CASE WHEN attempt_no=1 THEN 1 ELSE 0 END)                     AS first_attempts,
      SUM(CASE WHEN attempt_no=1 AND outcome='win' THEN 1 ELSE 0 END)   AS first_wins,
      AVG(CASE WHEN outcome='win'  THEN duration_ms END)                AS avg_win_duration,
      AVG(CASE WHEN outcome='win' AND allotted_time>0
               THEN 1.0*time_left_ms/(allotted_time*1000.0) END)        AS avg_time_left_ratio,
      AVG(CASE WHEN outcome='lose' THEN completion_pct END)             AS avg_fail_completion
    FROM level_attempt
    ${aClause}
    GROUP BY level_index
  `).bind(...aP).all();
  const byLevel = {};
  rows.forEach((r) => { byLevel[r.level_index] = r; });

  // 漏斗:到达人数(run.max_level_reached >= level) 与 通过人数(该关有 win 的 run)
  const { results: reachedRows } = await DB.prepare(`
    SELECT max_level_reached, ip_hash, user_agent, visitor_id, ended_reason FROM run ${rClause}
  `).bind(...rP).all();

  const visitorKey = (x) => x.visitor_id || (x.ip_hash ? x.ip_hash + '|' + (x.user_agent || '') : null);

  const totalRuns = reachedRows.length;
  const uniqueVisitors = new Set(reachedRows.map(visitorKey).filter(Boolean)).size;

  // 平台维度:按操作系统/设备聚合游玩量、独立访客、通关表现
  const platMap = {};
  reachedRows.forEach((r) => {
    const p = classifyPlatform(r.user_agent);
    const m = platMap[p] || (platMap[p] = { platform: p, runs: 0, cleared: 0, reachedSum: 0, visitors: new Set() });
    m.runs += 1;
    if (r.ended_reason === 'cleared') m.cleared += 1;
    m.reachedSum += r.max_level_reached || 0;
    const k = visitorKey(r);
    if (k) m.visitors.add(k);
  });
  const platforms = Object.values(platMap).map((m) => ({
    platform: m.platform,
    runs: m.runs,
    unique_visitors: m.visitors.size,
    cleared: m.cleared,
    cleared_rate: m.runs ? m.cleared / m.runs : 0,
    avg_max_level: m.runs ? m.reachedSum / m.runs : 0,
  })).sort((a, b) => b.runs - a.runs);

  // 每关 × 平台:关联 level_attempt 与 run 取平台,按 (平台,关) 统计 run 级通关率
  const { results: paRows } = await DB.prepare(`
    SELECT la.level_index AS level_index, la.outcome AS outcome, la.run_id AS run_id, r.user_agent AS user_agent
    FROM level_attempt la JOIN run r ON r.run_id = la.run_id
    ${aClause}
  `).bind(...aP).all();
  const plLevel = {}; // platform -> level_index -> { att:Set, won:Set }
  paRows.forEach((r) => {
    const p = classifyPlatform(r.user_agent);
    const byLv = plLevel[p] || (plLevel[p] = {});
    const cell = byLv[r.level_index] || (byLv[r.level_index] = { att: new Set(), won: new Set() });
    cell.att.add(r.run_id);
    if (r.outcome === 'win') cell.won.add(r.run_id);
  });

  const clearedRow = await DB.prepare(`
    SELECT COUNT(*) c FROM run ${rClause ? rClause + ' AND' : 'WHERE'} ended_reason='cleared'
  `).bind(...rP).first();
  const clearedRuns = clearedRow.c;

  const levelCount = Math.max(
    DEFAULT_LEVELS.length,
    rows.length ? Math.max(...rows.map((r) => r.level_index)) + 1 : 0
  );

  // 组装每平台的逐关通关率(run 级:该平台到达该关的 run 中通过的比例)
  const platformLevels = platforms.map((pf) => {
    const byLv = plLevel[pf.platform] || {};
    const lv = [];
    for (let i = 0; i < levelCount; i++) {
      const c = byLv[i];
      lv.push({
        level_index: i,
        attempts: c ? c.att.size : 0,
        pass_rate: c && c.att.size ? c.won.size / c.att.size : null,
      });
    }
    return { platform: pf.platform, levels: lv };
  });

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
    platforms,
    platformLevels,
    levels,
  };
}
