// 管理后台鉴权:单口令登录 → 签发无状态 HMAC token,存 HttpOnly Cookie。
// 无状态(不需服务端存 session),适合单/多实例;重启不失效(只要 JWT_SECRET 不变)。
import '../env.js';
import crypto from 'node:crypto';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const INSECURE_SECRET_VALUES = new Set(['', 'dev-secret-change-me', 'please-change-this-secret']);
const INSECURE_PASSWORD_VALUES = new Set(['', 'changeme']);
export const TOKEN_TTL_MS = 12 * 3600 * 1000; // 12 小时
export const COOKIE_NAME = 'tb_admin';

function requireSecureConfig(name, value, insecureValues) {
  if (process.env.NODE_ENV !== 'production') return;
  if (insecureValues.has(value)) {
    throw new Error(`[config] ${name} must be set to a secure value in production`);
  }
}

requireSecureConfig('JWT_SECRET', SECRET, INSECURE_SECRET_VALUES);
requireSecureConfig('ADMIN_PASSWORD', ADMIN_PASSWORD, INSECURE_PASSWORD_VALUES);

function sign(exp) {
  return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
}

export function issueToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  return exp + '.' + sign(exp);
}

export function verifyToken(tok) {
  if (typeof tok !== 'string') return false;
  const dot = tok.indexOf('.');
  if (dot < 0) return false;
  const exp = tok.slice(0, dot), sig = tok.slice(dot + 1);
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expect = sign(exp);
  try {
    return sig.length === expect.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch (e) { return false; }
}

// 口令校验:用 sha256 等长后再 timingSafeEqual,避免长度/时序泄露
export function checkPassword(pw) {
  if (typeof pw !== 'string') return false;
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// 极简 Cookie 解析(不引入 cookie-parser 依赖)
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

// 路由守卫:未登录返回 401
export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: '未登录或登录已过期' });
}
