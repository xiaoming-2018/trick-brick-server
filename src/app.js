// Express 入口：托管游戏静态文件 + 公开 API（P1：关卡时长配置）
import './env.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getLevelConfig } from './db.js';
import { recordEvent } from './track.js';
import { rateLimit } from './middleware/rateLimit.js';
import adminRouter from './routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const GAME_DIR = process.env.GAME_DIR
  ? resolve(__dirname, '..', process.env.GAME_DIR)
  : null;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

const app = express();
app.set('trust proxy', true); // 云上经 Nginx/Caddy 反代，取 X-Forwarded-For 真实 IP
app.use(express.json({ limit: '32kb' })); // 埋点请求体小，限制大小防滥用

// ---------- CORS（游戏与后端跨域时启用）----------
app.use((req, res, next) => {
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 公开 API ----------
// 关卡时长配置：游戏启动时拉取，拉不到则用前端自带默认值（天然 fallback）
app.get('/api/levels/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ levels: getLevelConfig() });
});

// 埋点接收:持久化到 run / level_attempt。按 IP 限流防刷,IP 仅以哈希存储。
app.post('/api/track', rateLimit({ windowMs: 60000, max: 240 }), (req, res) => {
  const ua = req.get('user-agent') || '';
  const body = req.body;
  // 支持单事件或事件数组(便于前端批量上报)
  const events = Array.isArray(body) ? body : [body];
  try {
    for (const ev of events.slice(0, 50)) recordEvent(ev, req.ip, ua);
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

app.listen(PORT, () => {
  console.log(`[server] 监听 http://localhost:${PORT}`);
  console.log(`[api] GET /api/levels/config`);
});
