// A small in-memory rate limiter. Good for one dyno; if you ever run more
// than one, swap the store for Redis (the interface is the two functions at
// the bottom) rather than letting each dyno keep its own counts.
//
//   limit({ name, max, windowMs, key })  express middleware
//     key(req) -> string; defaults to the client IP (trust proxy is on, so
//     req.ip is the real address behind Heroku's router).

const buckets = new Map(); // `${name}:${key}` -> { count, resetAt }

function hit(name, key, max, windowMs) {
  const id = `${name}:${key}`;
  const now = Date.now();
  let b = buckets.get(id);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(id, b); }
  b.count += 1;
  return { allowed: b.count <= max, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), remaining: Math.max(0, max - b.count) };
}

function sweep() {
  const now = Date.now();
  for (const [id, b] of buckets) if (b.resetAt <= now) buckets.delete(id);
}
const sweeper = setInterval(sweep, 60_000);
if (sweeper.unref) sweeper.unref();

function limit({ name, max, windowMs, key = (req) => req.ip || 'unknown', message }) {
  return (req, res, next) => {
    const k = key(req);
    if (k == null) return next();
    const r = hit(name, String(k), max, windowMs);
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (r.allowed) return next();
    res.setHeader('Retry-After', String(r.retryAfter));
    res.status(429).json({ error: message || `Slow down. Try again in ${r.retryAfter >= 60 ? `${Math.ceil(r.retryAfter / 60)} minutes` : `${r.retryAfter} seconds`}.` });
  };
}

module.exports = { limit, hit, _buckets: buckets };
