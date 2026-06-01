// Express 入口：托管游戏静态文件 + 公开 API（P1：关卡时长配置）
import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getLevelConfig, initDb } from './db.js';
import { recordEvent } from './track.js';
import { rateLimit } from './middleware/rateLimit.js';
import adminRouter from './routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const GAME_DIR = process.env.GAME_DIR
  ? resolve(__dirname, '..', process.env.GAME_DIR)
  : null;
// 允许跨域的来源：逗号分隔可填多个；填 * 允许任意来源（埋点/配置为公开接口，可放开）。
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CORS_ALLOW_ALL = CORS_ORIGINS.includes('*');

const app = express();
app.set('trust proxy', true); // 云上经 Nginx/Caddy 反代，取 X-Forwarded-For 真实 IP
app.use(express.json({ limit: '32kb' })); // 埋点请求体小，限制大小防滥用

// ---------- CORS（游戏与后端跨域时启用）----------
// 支持多来源白名单：回显命中的 Origin 并加 Vary，未命中则不发 CORS 头。
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (CORS_ALLOW_ALL || CORS_ORIGINS.includes(origin))) {
    // 回显具体 Origin(不能用 *),并允许携带凭证——sendBeacon 等带凭证请求否则会被浏览器拦截
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 公开 API ----------
// 关卡时长配置：游戏启动时拉取，拉不到则用前端自带默认值（天然 fallback）
app.get('/api/levels/config', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ levels: await getLevelConfig() });
  } catch (e) {
    // DB 暂不可用时返回空,前端会回退到自带默认时长
    console.error('[config] error:', e.message);
    res.json({ levels: [] });
  }
});

// 埋点接收:持久化到 run / level_attempt。按 IP 限流防刷,IP 仅以哈希存储。
app.post('/api/track', rateLimit({ windowMs: 60000, max: 240 }), async (req, res) => {
  const ua = req.get('user-agent') || '';
  const body = req.body;
  // 支持单事件或事件数组(便于前端批量上报)
  const events = Array.isArray(body) ? body : [body];
  try {
    for (const ev of events.slice(0, 50)) await recordEvent(ev, req.ip, ua);
  } catch (e) {
    // 单条坏数据不影响整体;埋点失败对玩家无感
    console.error('[track] error:', e.message);
  }
  res.sendStatus(204); // sendBeacon 不读响应体,返回 204 即可
});

// ---------- 管理后台 API + 页面 ----------
app.use('/api/admin', adminRouter);
app.use('/admin', express.static(join(__dirname, '..', 'public', 'admin')));
console.log(`[admin] 后台页面 http://localhost:${PORT}/admin/`);

// ---------- 托管游戏静态文件（可选）----------
if (GAME_DIR && existsSync(GAME_DIR)) {
  app.use('/game', express.static(GAME_DIR));
  console.log(`[static] 游戏托管于 http://localhost:${PORT}/game/  (来源 ${GAME_DIR})`);
}

app.get('/', (req, res) => res.send('trick-brick-server OK'));

// 先建表 + 灌默认时长,再开始监听(Postgres 需先初始化)
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] 监听 http://localhost:${PORT}`);
      console.log(`[api] GET /api/levels/config`);
    });
  })
  .catch((e) => {
    console.error('[db] 初始化失败,退出:', e.message);
    process.exit(1);
  });
