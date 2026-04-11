'use strict';

// Ventana deslizante en memoria (Map global por proceso).
// En Render/single-instance esto es suficiente.
// Si en el futuro escala horizontalmente → migrar a Redis.
const _windows = new Map();

/**
 * Extrae la IP real del request.
 * Respeta X-Forwarded-For (Render, proxies inversos).
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Crea un limitador de tasa en memoria.
 *
 * @param {object} opts
 * @param {number} [opts.maxRequests=10]     Máximo de peticiones en la ventana
 * @param {number} [opts.windowMs=60_000]    Tamaño de la ventana (ms)
 *
 * @returns {function(ip: string, key: string): {allowed: boolean, retryAfterMs?: number, retryAfterSec?: number, remaining?: number}}
 */
function rateLimit({ maxRequests = 10, windowMs = 60_000 } = {}) {
  return function check(ip, endpoint) {
    const key = `${ip}|${endpoint}`;
    const now = Date.now();
    const win = _windows.get(key);
    if (!win || now > win.resetAt) {
      _windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: maxRequests - 1 };
    }
    if (win.count >= maxRequests) {
      const retryAfterMs = win.resetAt - now;
      return {
        allowed:       false,
        retryAfterMs,
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
        remaining:     0,
      };
    }
    win.count++;
    return { allowed: true, remaining: maxRequests - win.count };
  };
}

// Limpiar entradas expiradas cada 5 min para evitar memory leak.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _windows) {
    if (now > v.resetAt) _windows.delete(k);
  }
}, 5 * 60_000).unref();

// ─── Limitadores predefinidos ────────────────────────────────────────────────

/**
 * Admin general: 120 peticiones por IP por minuto.
 * Cubre tráfico legítimo de backoffice pero limita scrapers.
 */
const adminRequestLimiter = rateLimit({ maxRequests: 120, windowMs: 60_000 });

/**
 * Admin auth failures: 10 intentos fallidos por IP por 5 minutos.
 * Un atacante de fuerza bruta queda bloqueado rápido.
 */
const adminAuthFailLimiter = rateLimit({ maxRequests: 10, windowMs: 5 * 60_000 });

module.exports = {
  rateLimit,
  getClientIp,
  adminRequestLimiter,
  adminAuthFailLimiter,
};
