"use strict";

const { timingSafeCompare } = require("../services/currencyService");
const { getClientIp, adminRequestLimiter, adminAuthFailLimiter } = require("../utils/rateLimiter");

/**
 * Autenticación admin: `X-Admin-Secret` y, si está habilitado, `?k=` / `?secret=` (mismo valor que ADMIN_SECRET).
 *
 * - **Monitor / pruebas en navegador:** `GET /api/crm/chats?k=TU_SECRETO` (o `&secret=`).
 * - **Cerrar query sin tocar código:** en Render (o `.env`) `ADMIN_SECRET_QUERY_AUTH=0` → solo cabecera.
 * - **Quitar soporte query del repo:** borrar la rama `if (adminQueryAuthEnabled() && url)` en este archivo
 *   o dejar `ADMIN_SECRET_QUERY_AUTH=0` fijo en producción.
 */
function adminQueryAuthEnabled() {
  const v = process.env.ADMIN_SECRET_QUERY_AUTH;
  if (v === undefined || v === null || String(v).trim() === "") return true;
  return !(v === "0" || /^false$/i.test(String(v)));
}

function writeJson(res, status, body, extraHeaders) {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...extraHeaders };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/**
 * Middleware de autenticación admin con rate limiting.
 *
 * Flujo:
 *   1. Límite de peticiones general por IP (120/min) → 429
 *   2. Verifica ADMIN_SECRET (timingSafeCompare) → 503/403
 *   3. Si falla la auth → incrementa contador de fallos por IP (10/5min) → 429 en exceso
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} [url]
 * @returns {boolean} true = auth OK, false = rechazado (ya respondió)
 */
function ensureAdmin(req, res, url) {
  const ip = getClientIp(req);

  // 1. Rate limiting general (todas las peticiones al endpoint, válidas o no)
  const generalCheck = adminRequestLimiter(ip, "admin_general");
  if (!generalCheck.allowed) {
    writeJson(
      res, 429,
      {
        error:             "rate_limit_exceeded",
        message:           "Demasiadas peticiones. Intenta más tarde.",
        retryAfterSeconds: generalCheck.retryAfterSec,
      },
      { "Retry-After": String(generalCheck.retryAfterSec) }
    );
    return false;
  }

  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    writeJson(res, 503, { error: "define ADMIN_SECRET en el servidor" });
    return false;
  }

  const fromHeader = req.headers["x-admin-secret"];
  if (timingSafeCompare(fromHeader, secret)) return true;

  if (adminQueryAuthEnabled() && url) {
    const fromQuery = url.searchParams.get("k") || url.searchParams.get("secret");
    if (timingSafeCompare(fromQuery, secret)) return true;
  }

  // 3. Auth fallida → incrementar contador de fallos
  const failCheck = adminAuthFailLimiter(ip, "admin_auth_fail");
  if (!failCheck.allowed) {
    writeJson(
      res, 429,
      {
        error:             "too_many_auth_failures",
        message:           "Demasiados intentos fallidos. IP bloqueada temporalmente.",
        retryAfterSeconds: failCheck.retryAfterSec,
      },
      { "Retry-After": String(failCheck.retryAfterSec) }
    );
    return false;
  }

  const hint = adminQueryAuthEnabled()
    ? "Cabecera X-Admin-Secret o query ?k= / ?secret= (ADMIN_SECRET). Sin query: ADMIN_SECRET_QUERY_AUTH=0"
    : "Cabecera X-Admin-Secret";
  writeJson(res, 403, { error: "forbidden", hint });
  return false;
}

module.exports = {
  ensureAdmin,
  adminQueryAuthEnabled,
};
