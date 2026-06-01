// Cloudflare Workers 入口（Hono）。替代原 Express src/app.js + routes/admin.js + 中间件。
// 静态资源（/admin、/game）由 Workers Assets 直接托管，不进这里；本 Worker 只处理 /api/* 与 /。
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getLevelConfig, getAdminLevels, updateLevel, clearHistory, DEFAULT_LEVELS } from './db.js';
import { recordEvents } from './track.js';
import { computeStats } from './stats.js';
import {
  issueToken, verifyToken, checkPassword, hashIp, COOKIE_NAME, TOKEN_TTL_MS,
} from './auth.js';

const app = new Hono();

// ---------- 配置校验 ----------
const INSECURE = new Set(['', 'changeme', 'dev-secret-change-me', 'please-change-this-secret', 'please-change-this-salt', 'dev-salt']);
function missingSecrets(env) {
  const out = [];
  for (const k of ['ADMIN_PASSWORD', 'JWT_SECRET', 'IP_SALT']) {
    if (!env[k] || INSECURE.has(env[k])) out.push(k);
  }
  return out;
}

// ---------- CORS（游戏与后端跨域时启用）----------
app.use('/api/*', async (c, next) => {
  const origin = c.env.CORS_ORIGIN;
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Allow-Credentials', 'true');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

// ---------- 公开 API ----------
// 关卡时长配置：游戏启动时拉取，拉不到则用前端自带默认值（天然 fallback）
app.get('/api/levels/config', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ levels: await getLevelConfig(c.env.DB) });
});

// 埋点接收：按 IP 哈希限流防刷，IP 仅以哈希存储。
app.post('/api/track', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || '';
  const ipHash = await hashIp(ip, c.env.IP_SALT || 'dev-salt');

  if (c.env.TRACK_LIMITER) {
    const { success } = await c.env.TRACK_LIMITER.limit({ key: ipHash });
    if (!success) return c.body(null, 429);
  }

  let body;
  try { body = await c.req.json(); } catch { return c.body(null, 204); }
  const ua = c.req.header('user-agent') || '';
  try {
    await recordEvents(c.env.DB, body, ipHash, ua);
  } catch (e) {
    // 单次写入失败对玩家无感；埋点丢失可接受
    console.error('[track] error:', e.message);
  }
  return c.body(null, 204); // sendBeacon 不读响应体
});

// ---------- 管理后台 API ----------
const admin = new Hono();

function cookieOpts(c) {
  const secure = new URL(c.req.url).protocol === 'https:';
  return { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: Math.floor(TOKEN_TTL_MS / 1000), secure };
}

async function isAuthed(c) {
  if (!c.env.JWT_SECRET) return false;
  return verifyToken(c.env.JWT_SECRET, getCookie(c, COOKIE_NAME));
}

const requireAuth = async (c, next) => {
  if (await isAuthed(c)) return next();
  return c.json({ error: '未登录或登录已过期' }, 401);
};

// 当前登录状态
admin.get('/me', async (c) => c.json({ authed: await isAuthed(c) }));

// 登录：校验单口令 → 下发 HttpOnly Cookie
admin.post('/login', async (c) => {
  const miss = missingSecrets(c.env);
  if (miss.length) return c.json({ error: '服务未正确配置机密: ' + miss.join(', ') }, 500);
  const body = await c.req.json().catch(() => ({}));
  if (!(await checkPassword(body && body.password, c.env.ADMIN_PASSWORD))) {
    return c.json({ error: '口令错误' }, 401);
  }
  setCookie(c, COOKIE_NAME, await issueToken(c.env.JWT_SECRET), cookieOpts(c));
  return c.json({ ok: true });
});

admin.post('/logout', (c) => {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});

// 读全部关卡配置（含默认时长，便于页面展示与"恢复默认"）
admin.get('/levels', requireAuth, async (c) => {
  const rows = await getAdminLevels(c.env.DB);
  const defaults = Object.fromEntries(DEFAULT_LEVELS.map((l) => [l.index, l.time]));
  return c.json({
    levels: rows.map((r) => ({ ...r, default_time: defaults[r.level_index] ?? null })),
  });
});

// 改单关时长
admin.put('/levels/:idx', requireAuth, async (c) => {
  const idx = Number(c.req.param('idx'));
  const body = await c.req.json().catch(() => ({}));
  const t = Number(body && body.time_seconds);
  if (!Number.isInteger(idx)) return c.json({ error: '关卡序号非法' }, 400);
  if (!Number.isFinite(t) || t < 1 || t > 100000) {
    return c.json({ error: '时长需为 1~100000 的整数(秒)' }, 400);
  }
  const changes = await updateLevel(c.env.DB, idx, t);
  if (changes === 0) return c.json({ error: '关卡不存在' }, 404);
  return c.json({ ok: true, level_index: idx, time_seconds: Math.round(t) });
});

// 清除历史埋点数据（run / level_attempt），不影响关卡时长配置
admin.post('/data/clear', requireAuth, async (c) => {
  try {
    const deleted = await clearHistory(c.env.DB);
    return c.json({ ok: true, deleted });
  } catch (e) {
    console.error('[clear] error:', e.message);
    return c.json({ error: '清除失败' }, 500);
  }
});

// 难度分析统计（可选 from/to 时间范围，ISO 字符串）
admin.get('/stats', requireAuth, async (c) => {
  try {
    const from = c.req.query('from') || null;
    const to = c.req.query('to') || null;
    return c.json(await computeStats(c.env.DB, { from, to }));
  } catch (e) {
    console.error('[stats] error:', e.message);
    return c.json({ error: '统计失败' }, 500);
  }
});

app.route('/api/admin', admin);

// 根路径跳转到游戏
app.get('/', (c) => c.redirect('/game/'));

export default app;
