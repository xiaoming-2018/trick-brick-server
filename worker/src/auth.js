// 管理后台鉴权 + IP 哈希。原 src/middleware/auth.js + track.js 的 node:crypto 实现，
// 改用 Web Crypto（Workers 无 Node 原生 crypto，且全部为异步）。
// 无状态 HMAC token，存 HttpOnly Cookie；只要 JWT_SECRET 不变，重启/多实例都有效。

const enc = new TextEncoder();

export const TOKEN_TTL_MS = 12 * 3600 * 1000; // 12 小时
export const COOKIE_NAME = 'tb_admin';

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(String(msg))));
}

async function sha256Bytes(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

// 等长常量时间比较，避免时序泄露
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function issueToken(secret) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return exp + '.' + (await hmacHex(secret, exp));
}

export async function verifyToken(secret, tok) {
  if (typeof tok !== 'string') return false;
  const dot = tok.indexOf('.');
  if (dot < 0) return false;
  const exp = tok.slice(0, dot), sig = tok.slice(dot + 1);
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expect = await hmacHex(secret, exp);
  return timingSafeEqualStr(sig, expect);
}

// 口令校验：sha256 等长后常量时间比较
export async function checkPassword(pw, adminPassword) {
  if (typeof pw !== 'string') return false;
  const [a, b] = await Promise.all([sha256Bytes(pw), sha256Bytes(String(adminPassword))]);
  return timingSafeEqualBytes(a, b);
}

// IP 不落明文：加盐 sha256 后取前 32 hex，仅用于去重/防刷/统计
export async function hashIp(ip, salt) {
  const h = await sha256Bytes(String(ip || '') + String(salt || ''));
  return toHex(h).slice(0, 32);
}
