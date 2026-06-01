// 管理 API:登录 / 登出 / 读改关卡时长。除 login 外均需鉴权。
import express from 'express';
import { db, DEFAULT_LEVELS } from '../db.js';
import { computeStats } from '../stats.js';
import {
  issueToken, requireAuth, checkPassword, isAuthed,
  COOKIE_NAME, TOKEN_TTL_MS,
} from '../middleware/auth.js';

const router = express.Router();

const cookieOpts = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
  maxAge: TOKEN_TTL_MS,
};

function cookieOptionsFor(req) {
  return {
    ...cookieOpts,
    secure: process.env.COOKIE_SECURE === 'true' ||
      req.secure ||
      req.get('x-forwarded-proto') === 'https',
  };
}

// 当前登录状态(页面用来决定显示登录框还是看板)
router.get('/me', (req, res) => res.json({ authed: isAuthed(req) }));

// 登录:校验单口令 → 下发 HttpOnly Cookie
router.post('/login', (req, res) => {
  const pw = req.body && req.body.password;
  if (!checkPassword(pw)) return res.status(401).json({ error: '口令错误' });
  res.cookie(COOKIE_NAME, issueToken(), cookieOptionsFor(req));
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptionsFor(req));
  res.json({ ok: true });
});

// 读全部关卡配置(含默认时长,便于页面展示与"恢复默认")
router.get('/levels', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT level_index, time_seconds, name, updated_at, updated_by FROM level_config ORDER BY level_index')
    .all();
  const defaults = Object.fromEntries(DEFAULT_LEVELS.map((l) => [l.index, l.time]));
  res.json({
    levels: rows.map((r) => ({ ...r, default_time: defaults[r.level_index] ?? null })),
  });
});

// 改单关时长
router.put('/levels/:idx', requireAuth, (req, res) => {
  const idx = Number(req.params.idx);
  const t = Number(req.body && req.body.time_seconds);
  if (!Number.isInteger(idx)) return res.status(400).json({ error: '关卡序号非法' });
  if (!Number.isFinite(t) || t < 1 || t > 100000) {
    return res.status(400).json({ error: '时长需为 1~100000 的整数(秒)' });
  }
  const info = db
    .prepare('UPDATE level_config SET time_seconds = ?, updated_at = ?, updated_by = ? WHERE level_index = ?')
    .run(Math.round(t), new Date().toISOString(), 'admin', idx);
  if (info.changes === 0) return res.status(404).json({ error: '关卡不存在' });
  res.json({ ok: true, level_index: idx, time_seconds: Math.round(t) });
});

// 难度分析统计(可选 from/to 时间范围,ISO 字符串)
router.get('/stats', requireAuth, (req, res) => {
  const { from, to } = req.query;
  try {
    res.json(computeStats({ from: from || null, to: to || null }));
  } catch (e) {
    console.error('[stats] error:', e.message);
    res.status(500).json({ error: '统计失败' });
  }
});

export default router;
