// 极简内存限流:按 key(默认客户端 IP)在滑动窗口内限制请求数,防埋点刷量。
// 单实例够用;多实例部署需换 Redis 之类的共享存储。
export function rateLimit({ windowMs = 60000, max = 120, keyFn } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  // 定期清理过期键,避免内存无限增长
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    rec.count++;
    if (rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.resetAt - now) / 1000));
      return res.sendStatus(429);
    }
    next();
  };
}
