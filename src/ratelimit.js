// 简单的内存限流：每个 IP 在窗口期内最多 N 次请求
export function rateLimit({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map();

  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, windowMs).unref();

  return function limiter(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const t = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt <= t) {
      rec = { count: 0, resetAt: t + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;
    if (rec.count > max) {
      res.status(429).json({ error: '操作太频繁了，请稍后再试' });
      return;
    }
    next();
  };
}
