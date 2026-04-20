"use strict";

/**
 * Bloque 4 · Whitelist de números operativos
 *
 * Números registrados aquí son ignorados por el hub omnicanal:
 * no se crea crm_chat ni crm_message para mensajes de esos números.
 *
 * Endpoints (auth: requireAdminOrPermission 'settings'):
 *   GET    /api/inbox/whitelist
 *   POST   /api/inbox/whitelist
 *   DELETE /api/inbox/whitelist/:id
 *   POST   /api/inbox/whitelist/check   (consulta puntual, útil para debug)
 */

const { pool } = require("../../db");
const { requireAdminOrPermission } = require("../utils/authMiddleware");

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** Normaliza el número a +58XXXXXXXXX (si aplica) o lo devuelve como vino. */
function normalizePhone(raw) {
  const s = String(raw || "").trim().replace(/\s/g, "");
  if (!s) return null;
  return s;
}

async function handleWhitelistRequest(req, res, _user, pathname) {
  if (!pathname.startsWith("/api/inbox/whitelist")) return false;

  // Autenticación: rol admin o permiso 'settings'
  const user = await requireAdminOrPermission(req, res, "settings");
  if (!user) return true;

  const uid = user.userId != null ? Number(user.userId) : null;

  // ── GET /api/inbox/whitelist ────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/inbox/whitelist") {
    const { rows } = await pool.query(
      `SELECT id, phone, label, created_by, created_at
       FROM operational_phone_whitelist
       ORDER BY created_at DESC`
    );
    writeJson(res, 200, { items: rows, total: rows.length });
    return true;
  }

  // ── POST /api/inbox/whitelist/check ────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/inbox/whitelist/check") {
    let body;
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const phone = normalizePhone(body.phone);
    if (!phone) {
      writeJson(res, 400, { error: "bad_request", message: "phone requerido." }); return true;
    }
    const { rows } = await pool.query(
      `SELECT id, phone, label FROM operational_phone_whitelist WHERE phone = $1`,
      [phone]
    );
    writeJson(res, 200, { is_whitelisted: rows.length > 0, entry: rows[0] || null });
    return true;
  }

  // ── POST /api/inbox/whitelist ───────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/inbox/whitelist") {
    let body;
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const phone = normalizePhone(body.phone);
    if (!phone) {
      writeJson(res, 400, { error: "bad_request", message: "phone requerido." }); return true;
    }
    const label = body.label ? String(body.label).trim().slice(0, 200) : null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO operational_phone_whitelist (phone, label, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET label = EXCLUDED.label
         RETURNING id, phone, label, created_at`,
        [phone, label, uid]
      );
      writeJson(res, 201, { ok: true, entry: rows[0] });
    } catch (err) {
      writeJson(res, 500, { error: "db_error", message: err.message });
    }
    return true;
  }

  // ── DELETE /api/inbox/whitelist/:id ────────────────────────────────────────
  const delM = pathname.match(/^\/api\/inbox\/whitelist\/(\d+)$/);
  if (delM && req.method === "DELETE") {
    const entryId = Number(delM[1]);
    const { rowCount } = await pool.query(
      `DELETE FROM operational_phone_whitelist WHERE id = $1`, [entryId]
    );
    if (!rowCount) {
      writeJson(res, 404, { error: "not_found" }); return true;
    }
    writeJson(res, 200, { ok: true, deleted_id: entryId });
    return true;
  }

  return false;
}

/**
 * Verificación rápida en memoria con caché de 60 s para no golpear la BD
 * en cada mensaje entrante.
 *
 * Uso:
 *   const { isPhoneWhitelisted } = require('./inboxWhitelistHandler');
 *   if (await isPhoneWhitelisted(phone)) return;   // ignorar
 */
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 60_000;

async function isPhoneWhitelisted(phone) {
  const now = Date.now();
  if (!_cache || now - _cacheTs > CACHE_TTL_MS) {
    try {
      const { rows } = await pool.query(
        `SELECT phone FROM operational_phone_whitelist`
      );
      _cache = new Set(rows.map((r) => r.phone));
      _cacheTs = now;
    } catch (_) {
      // Si falla la BD, no bloquear (fail-open)
      return false;
    }
  }
  return _cache.has(phone);
}

/** Invalida el caché de whitelist (llamar tras POST/DELETE en el handler). */
function invalidateWhitelistCache() {
  _cache = null;
}

module.exports = { handleWhitelistRequest, isPhoneWhitelisted, invalidateWhitelistCache };
