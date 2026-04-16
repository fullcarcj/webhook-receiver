"use strict";

/**
 * CORS para rutas CRM / clientes consumibles desde front (Vite, etc.).
 * Origen: CRM_FRONTEND_ORIGIN o FRONTEND_ORIGIN, o primer valor de FRONTEND_CORS_ORIGINS,
 * o reflejo del header Origin si está en la lista (mismo criterio que public-frontend-api).
 */

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

function resolveAllowOrigin(req) {
  const fixed =
    process.env.CRM_FRONTEND_ORIGIN ||
    process.env.FRONTEND_ORIGIN ||
    (parseOrigins()[0] || "*");
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    return { value: origin, vary: true };
  }
  if (fixed === "*" || !origin) {
    return { value: fixed, vary: false };
  }
  return { value: fixed, vary: false };
}

function applyCrmApiCorsHeaders(req, res) {
  const { value, vary } = resolveAllowOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", value);
  if (vary) res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Admin-Secret, X-API-Key, Content-Type, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function corsCrmPath(pathname) {
  return (
    pathname.startsWith("/api/customers") ||
    pathname.startsWith("/api/sales") ||
    pathname.startsWith("/api/inbox") ||
    pathname === "/api/crm" ||
    pathname.startsWith("/api/crm/")
  );
}

/** Preflight OPTIONS: 204 + cabeceras. */
function handleCrmApiPreflight(req, res, url) {
  if (req.method !== "OPTIONS") return false;
  if (!corsCrmPath(url.pathname || "")) return false;
  applyCrmApiCorsHeaders(req, res);
  res.writeHead(204);
  res.end();
  return true;
}

module.exports = {
  applyCrmApiCorsHeaders,
  handleCrmApiPreflight,
  corsCrmPath,
};
