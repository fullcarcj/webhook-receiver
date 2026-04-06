const _windows = new Map();

function rateLimit({ maxRequests = 10, windowMs = 60_000 } = {}) {
  return function check(ip, endpoint) {
    const key = `${ip}|${endpoint}`;
    const now = Date.now();
    const win = _windows.get(key);
    if (!win || now > win.resetAt) {
      _windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }
    if (win.count >= maxRequests) {
      return { allowed: false, retryAfterMs: win.resetAt - now };
    }
    win.count++;
    return { allowed: true };
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _windows) {
    if (now > v.resetAt) _windows.delete(k);
  }
}, 5 * 60_000);

module.exports = {
  rateLimit,
};

