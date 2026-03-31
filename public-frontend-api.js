/**
 * API pública para el frontend (Vite / Static Site): prefijo /api/v1.
 * Autenticación: FRONTEND_API_KEY en cabecera X-API-KEY (no ADMIN_SECRET).
 * CORS: FRONTEND_CORS_ORIGINS + http://localhost:5173 por defecto.
 */

const crypto = require("crypto");
const pkg = require("./package.json");
const { listProductosCatalogPublic } = require("./db");

function parseOrigins() {
  const raw = process.env.FRONTEND_CORS_ORIGINS;
  const fromEnv =
    raw != null && String(raw).trim() !== ""
      ? String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const defaults = ["http://localhost:5173"];
  return [...new Set([...defaults, ...fromEnv])];
}

function originAllowed(origin) {
  if (!origin) return true;
  return parseOrigins().some((o) => o === origin);
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff && String(xff).trim() !== "") {
    return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "private, no-store");
}

function applyPublicCors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-API-KEY, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) {
    const pad = Buffer.alloc(32);
    crypto.timingSafeEqual(pad, pad);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function parseRateLimit() {
  const rawMax = process.env.FRONTEND_RATE_LIMIT_MAX;
  const rawWin = process.env.FRONTEND_RATE_LIMIT_WINDOW_MS;
  const max =
    rawMax === undefined || rawMax === "" ? 120 : Math.max(0, parseInt(String(rawMax), 10) || 0);
  const windowMs =
    rawWin === undefined || rawWin === ""
      ? 60_000
      : Math.max(1000, parseInt(String(rawWin), 10) || 60_000);
  return { max, windowMs, disabled: max === 0 };
}

const rateBuckets = new Map();

function rateLimitAllow(ip, routeKey) {
  const { max, windowMs, disabled } = parseRateLimit();
  if (disabled) return { ok: true };
  if (rateBuckets.size > 10_000) {
    const t = Date.now();
    for (const [k, v] of rateBuckets) {
      if (t >= v.reset) rateBuckets.delete(k);
    }
  }
  const key = `${ip}|${routeKey}`;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
  }
  return { ok: true };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function validatePublicAccess(req) {
  const expected = process.env.FRONTEND_API_KEY;
  if (!expected || String(expected).trim() === "") {
    return {
      ok: false,
      status: 503,
      json: { ok: false, error: "catalog_unavailable", detail: "FRONTEND_API_KEY no configurada" },
    };
  }
  const provided = req.headers["x-api-key"];
  if (provided == null || !timingSafeEqualStr(provided, expected)) {
    return { ok: false, status: 403, json: { ok: false, error: "forbidden" } };
  }
  return { ok: true };
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

/** true solo para /api/v1 o /api/v1/... (no /api/v1fake) */
function isUnderPublicApiV1(pathname) {
  const p = normalizePathname(pathname);
  return p === "/api/v1" || p.startsWith("/api/v1/");
}

function isPublicApiV1Path(pathname) {
  return isUnderPublicApiV1(pathname);
}

function isPublicCatalogPath(pathname) {
  const p = normalizePathname(pathname);
  return p === "/api/v1/catalog";
}

/**
 * Rutas bajo /api/v1 con CORS y cabeceras de seguridad.
 * @returns {Promise<boolean>} true si la petición fue atendida (incluye OPTIONS y 404 dentro del prefijo).
 */
async function handlePublicFrontendRequest(req, res, url) {
  const pathname = normalizePathname(url.pathname);
  if (!isUnderPublicApiV1(pathname)) return false;

  applySecurityHeaders(res);
  applyPublicCors(req, res);

  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    json(res, 403, { ok: false, error: "origin_not_allowed" });
    return true;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (pathname === "/api/v1") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    json(res, 200, {
      ok: true,
      public_api: "v1",
      endpoints: {
        health: "/api/v1/health",
        catalog: "/api/v1/catalog",
      },
    });
    return true;
  }

  if (pathname === "/api/v1/health") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    json(res, 200, {
      ok: true,
      service: "webhook-receiver",
      version: pkg.version,
      public_api: "v1",
    });
    return true;
  }

  if (pathname === "/api/v1/catalog") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }

    const ip = clientIp(req);
    const rl = rateLimitAllow(ip, "catalog");
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      json(res, 429, { ok: false, error: "rate_limited", retry_after_seconds: rl.retryAfterSec });
      return true;
    }

    const auth = validatePublicAccess(req);
    if (!auth.ok) {
      json(res, auth.status, auth.json);
      return true;
    }

    const search = url.searchParams.get("search") || "";
    const limit = url.searchParams.get("limit");
    const offset = url.searchParams.get("offset");

    try {
      const result = await listProductosCatalogPublic({ search, limit, offset });
      json(res, 200, {
        ok: true,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        items: result.items,
      });
    } catch (e) {
      console.error("[catalog public]", e);
      json(res, 500, { ok: false, error: "internal_error" });
    }
    return true;
  }

  json(res, 404, { ok: false, error: "not_found", path: pathname });
  return true;
}

module.exports = {
  handlePublicFrontendRequest,
  validatePublicAccess,
  originAllowed,
  isPublicApiV1Path,
  isPublicCatalogPath,
  /** Compatibilidad con nombre anterior */
  handlePublicCatalogRequest: handlePublicFrontendRequest,
};
