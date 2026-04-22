"use strict";

/**
 * Bloque 4/5 · Whitelist de números operativos + chats internos (NO CLIENTE)
 *
 * Modos:
 *   ignore (default/previo) — el hub omnicanal ignora el número; no crea chat.
 *   muted                   — crea el chat pero lo marca is_operational=true.
 *                             Aparece en bandeja con etiqueta "NO CLIENTE" y sin pipeline.
 *
 * Endpoints (auth: requireAdminOrPermission 'settings'):
 *   GET    /api/inbox/whitelist
 *   POST   /api/inbox/whitelist                    body: { phone, label?, mode? }
 *   DELETE /api/inbox/whitelist/:id
 *   POST   /api/inbox/whitelist/check              body: { phone }
 *   POST   /api/inbox/whitelist/mark-chat          body: { chat_id, label? }  → mode=muted
 *   DELETE /api/inbox/whitelist/mark-chat/:chatId  → elimina de whitelist + desmarca
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

/** Evita violar FK operational_phone_whitelist_created_by_fkey si JWT userId no existe en users. */
async function resolveWhitelistCreatedBy(client, uid) {
  const id = uid != null ? Number(uid) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;
  const { rows } = await client.query(`SELECT 1 FROM users WHERE id = $1`, [id]);
  return rows.length ? id : null;
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

function normalizePhone(raw) {
  const s = String(raw || "").trim().replace(/\s/g, "");
  if (!s) return null;
  return s;
}

function validMode(raw) {
  const m = String(raw || "ignore").trim().toLowerCase();
  return m === "ignore" || m === "muted" ? m : "ignore";
}

async function handleWhitelistRequest(req, res, _user, pathname) {
  if (!pathname.startsWith("/api/inbox/whitelist")) return false;

  const user = await requireAdminOrPermission(req, res, "settings");
  if (!user) return true;

  const uid = user.userId != null ? Number(user.userId) : null;

  // ── GET /api/inbox/whitelist ────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/inbox/whitelist") {
    const { rows } = await pool.query(
      `SELECT id, phone, label, mode, created_by, created_at
       FROM operational_phone_whitelist
       ORDER BY mode DESC, created_at DESC`
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
      `SELECT id, phone, label, mode FROM operational_phone_whitelist WHERE phone = $1`,
      [phone]
    );
    writeJson(res, 200, { is_whitelisted: rows.length > 0, entry: rows[0] || null });
    return true;
  }

  // ── POST /api/inbox/whitelist/mark-chat ─────────────────────────────────────
  // Marca un chat existente como interno (NO CLIENTE) vía su chat_id.
  // Agrega el número a la whitelist con mode='muted' y actualiza crm_chats.
  if (req.method === "POST" && pathname === "/api/inbox/whitelist/mark-chat") {
    let body;
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const chatId = body.chat_id != null ? Number(body.chat_id) : NaN;
    if (!Number.isFinite(chatId) || chatId <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "chat_id requerido." }); return true;
    }
    const label = body.label ? String(body.label).trim().slice(0, 200) : null;

    const chatQ = await pool.query(
      `SELECT id, phone FROM crm_chats WHERE id = $1`, [chatId]
    );
    if (!chatQ.rows.length) {
      writeJson(res, 404, { error: "not_found", message: "Chat no encontrado." }); return true;
    }
    const phone = chatQ.rows[0].phone;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const createdById = await resolveWhitelistCreatedBy(client, uid);

      const { rows } = await client.query(
        `INSERT INTO operational_phone_whitelist (phone, label, mode, created_by)
         VALUES ($1, $2, 'muted', $3)
         ON CONFLICT (phone) DO UPDATE
           SET label = COALESCE(EXCLUDED.label, operational_phone_whitelist.label),
               mode  = 'muted'
         RETURNING id, phone, label, mode`,
        [phone, label, createdById]
      );

      // Marcar retroactivamente todos los chats con ese número
      await client.query(
        `UPDATE crm_chats SET is_operational = TRUE, updated_at = NOW()
         WHERE phone = $1`,
        [phone]
      );

      await client.query("COMMIT");
      invalidateWhitelistCache();
      writeJson(res, 200, { ok: true, entry: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      writeJson(res, 500, { error: "db_error", message: err.message });
    } finally {
      client.release();
    }
    return true;
  }

  // ── DELETE /api/inbox/whitelist/mark-chat/:chatId ──────────────────────────
  // Desmarca un chat de "interno": elimina de whitelist (si modo=muted) y pone is_operational=false.
  const unmarkM = pathname.match(/^\/api\/inbox\/whitelist\/mark-chat\/(\d+)$/);
  if (unmarkM && req.method === "DELETE") {
    const chatId = Number(unmarkM[1]);
    const chatQ = await pool.query(
      `SELECT id, phone FROM crm_chats WHERE id = $1`, [chatId]
    );
    if (!chatQ.rows.length) {
      writeJson(res, 404, { error: "not_found" }); return true;
    }
    const phone = chatQ.rows[0].phone;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Solo elimina si es mode=muted (no tocar los ignore activos)
      await client.query(
        `DELETE FROM operational_phone_whitelist WHERE phone = $1 AND mode = 'muted'`,
        [phone]
      );
      // Desmarcar todos los chats con ese número
      await client.query(
        `UPDATE crm_chats SET is_operational = FALSE, updated_at = NOW()
         WHERE phone = $1`,
        [phone]
      );

      await client.query("COMMIT");
      invalidateWhitelistCache();
      writeJson(res, 200, { ok: true, phone });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      writeJson(res, 500, { error: "db_error", message: err.message });
    } finally {
      client.release();
    }
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
    const mode  = validMode(body.mode);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const createdById = await resolveWhitelistCreatedBy(client, uid);

      const { rows } = await client.query(
        `INSERT INTO operational_phone_whitelist (phone, label, mode, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone) DO UPDATE
           SET label = COALESCE(EXCLUDED.label, operational_phone_whitelist.label),
               mode  = EXCLUDED.mode
         RETURNING id, phone, label, mode, created_at`,
        [phone, label, mode, createdById]
      );

      // Si es muted, marcar chats existentes retroactivamente
      if (mode === "muted") {
        await client.query(
          `UPDATE crm_chats SET is_operational = TRUE, updated_at = NOW() WHERE phone = $1`,
          [phone]
        );
      }

      await client.query("COMMIT");
      invalidateWhitelistCache();
      writeJson(res, 201, { ok: true, entry: rows[0] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      writeJson(res, 500, { error: "db_error", message: err.message });
    } finally {
      client.release();
    }
    return true;
  }

  // ── DELETE /api/inbox/whitelist/:id ────────────────────────────────────────
  const delM = pathname.match(/^\/api\/inbox\/whitelist\/(\d+)$/);
  if (delM && req.method === "DELETE") {
    const entryId = Number(delM[1]);

    // Obtener el phone antes de eliminar para poder desmarcar chats si era muted
    const { rows: pre } = await pool.query(
      `SELECT phone, mode FROM operational_phone_whitelist WHERE id = $1`, [entryId]
    );

    const { rowCount } = await pool.query(
      `DELETE FROM operational_phone_whitelist WHERE id = $1`, [entryId]
    );
    if (!rowCount) {
      writeJson(res, 404, { error: "not_found" }); return true;
    }

    // Si era muted, desmarcar chats
    if (pre.length && pre[0].mode === "muted") {
      await pool.query(
        `UPDATE crm_chats SET is_operational = FALSE, updated_at = NOW() WHERE phone = $1`,
        [pre[0].phone]
      );
    }

    invalidateWhitelistCache();
    writeJson(res, 200, { ok: true, deleted_id: entryId });
    return true;
  }

  return false;
}

// ── Caché en memoria (TTL 60 s) ────────────────────────────────────────────
// Devuelve 'ignore' | 'muted' | null para un número dado.
// null = no está en whitelist → procesar normalmente.

let _cache    = null;   // Map<phone, 'ignore'|'muted'>
let _cacheTs  = 0;
const CACHE_TTL_MS = 60_000;

async function _refreshCache() {
  const { rows } = await pool.query(
    `SELECT phone, mode FROM operational_phone_whitelist`
  );
  _cache = new Map(rows.map((r) => [r.phone, r.mode || "ignore"]));
  _cacheTs = Date.now();
}

/**
 * Retorna el modo de whitelist del número, o null si no está registrado.
 * 'ignore' → no crear chat
 * 'muted'  → crear chat con is_operational = true
 * null     → procesar normalmente
 */
async function getWhitelistMode(phone) {
  const now = Date.now();
  if (!_cache || now - _cacheTs > CACHE_TTL_MS) {
    try { await _refreshCache(); } catch (_) { return null; }
  }
  return _cache.get(phone) ?? null;
}

/**
 * Compatibilidad hacia atrás: retorna true si el número tiene modo 'ignore'.
 * (Usado en mlInboxBridge que ya ignoraba el número completo.)
 */
async function isPhoneWhitelisted(phone) {
  const mode = await getWhitelistMode(phone);
  return mode === "ignore";
}

function invalidateWhitelistCache() {
  _cache = null;
}

module.exports = {
  handleWhitelistRequest,
  isPhoneWhitelisted,
  getWhitelistMode,
  invalidateWhitelistCache,
};
