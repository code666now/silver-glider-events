function createRateLimiter({ windowMs, rules, now = () => Date.now() }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be positive');
  if (!Array.isArray(rules) || !rules.length) throw new Error('rules are required');

  const hits = new Map();

  function consume(context) {
    const timestamp = now();
    const active = rules.map(rule => {
      const rawKey = rule.key(context);
      if (!rawKey) return null;
      const key = `${rule.name}:${rawKey}`;
      const recent = (hits.get(key) || []).filter(value => timestamp - value < windowMs);
      return { key, max: rule.max, recent };
    }).filter(Boolean);

    const blocked = active.find(entry => entry.recent.length >= entry.max);
    if (blocked) {
      const oldest = blocked.recent[0] || timestamp;
      return {
        allowed: false,
        retryAfterMs: Math.max(1000, windowMs - (timestamp - oldest))
      };
    }

    active.forEach(entry => hits.set(entry.key, [...entry.recent, timestamp]));
    return { allowed: true, retryAfterMs: 0 };
  }

  function prune() {
    const timestamp = now();
    for (const [key, values] of hits) {
      const recent = values.filter(value => timestamp - value < windowMs);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }

  function reset() {
    hits.clear();
  }

  return { consume, prune, reset };
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

module.exports = { createRateLimiter, clientIp };
