"use strict";

const { timingSafeCompare } = require("../services/currencyService");

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

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @returns {boolean}
 */
function ensureAdmin(req, res, url) {
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
