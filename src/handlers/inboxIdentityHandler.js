"use strict";

const crypto = require("crypto");
const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_identity_api",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function normalizePath(pathname) {
  const raw = String(pathname || "").replace(/\/{2,}/g, "/");
  return raw.replace(/\/+$/, "") || "/";
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 512 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function enrichCandidates(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch (_e) {
      return null;
    }
  }
  const phoneMatches = Array.isArray(obj.phoneMatches)
    ? obj.phoneMatches.map((r) => ({ ...r, match_type: "phone" }))
    : [];
  const mlBuyerMatches = Array.isArray(obj.mlBuyerMatches)
    ? obj.mlBuyerMatches.map((r) => ({ ...r, match_type: "ml_buyer" }))
    : [];
  return {
    phoneMatches,
    mlBuyerMatches,
    keywordHint: Boolean(obj.keywordHint),
  };
}

/**
 * GET /api/inbox/:chatId/identity-candidates
 * POST /api/inbox/:chatId/link-customer
 * POST /api/inbox/:chatId/link-ml-order
 * @returns {Promise<boolean>}
 */
async function handleInboxIdentityRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  const m = pathname.match(/^\/api\/inbox\/(\d+)\/(identity-candidates|link-customer|link-ml-order)$/);
  if (!m) return false;

  applyCrmApiCorsHeaders(req, res);

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  const chatId = Number(m[1]);
  const sub = m[2];
  const isDev = process.env.NODE_ENV !== "production";

  try {
    if (req.method === "GET" && sub === "identity-candidates") {
      const { rows } = await pool.query(
        `SELECT identity_status, identity_candidates, customer_id, ml_buyer_id, source_type
         FROM crm_chats WHERE id = $1`,
        [chatId]
      );
      if (!rows.length) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      const row = rows[0];
      const candidates = enrichCandidates(row.identity_candidates);
      writeJson(res, 200, {
        identity_status: row.identity_status,
        customer_id: row.customer_id,
        ml_buyer_id: row.ml_buyer_id,
        source_type: row.source_type,
        candidates: candidates,
      });
      return true;
    }

    if (req.method === "POST" && sub === "link-customer") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const customerId = body.customer_id != null ? Number(body.customer_id) : NaN;
      const confirmedByRaw = body.confirmed_by != null ? Number(body.confirmed_by) : user.userId;
      const confirmedBy = Number.isFinite(confirmedByRaw) ? confirmedByRaw : user.userId;
      const linkType = body.link_type != null ? String(body.link_type) : "";
      if (!Number.isFinite(customerId) || customerId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "customer_id inválido" });
        return true;
      }
      if (!["phone", "ml_buyer", "manual"].includes(linkType)) {
        writeJson(res, 400, { error: "bad_request", message: "link_type inválido" });
        return true;
      }

      const cust = await pool.query(
        `SELECT id, full_name FROM customers WHERE id = $1 AND is_active = true`,
        [customerId]
      );
      if (!cust.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Cliente no encontrado o inactivo" });
        return true;
      }
      const fullName = String(cust.rows[0].full_name || "");

      const chatR = await pool.query(
        `SELECT phone, ml_buyer_id FROM crm_chats WHERE id = $1`,
        [chatId]
      );
      if (!chatR.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Chat no encontrado" });
        return true;
      }
      const chatPhone = chatR.rows[0].phone;
      const mlBuyerIdChat = chatR.rows[0].ml_buyer_id;
      const digits = chatPhone ? String(chatPhone).replace(/\D/g, "") : "";

      await pool.query(
        `UPDATE crm_chats SET
           customer_id = $1,
           identity_status = 'manual_linked',
           identity_candidates = NULL,
           updated_at = NOW()
         WHERE id = $2`,
        [customerId, chatId]
      );

      let source = "whatsapp";
      let externalId = `manual:${chatId}`;
      if (linkType === "ml_buyer") {
        source = "mercadolibre";
        externalId =
          mlBuyerIdChat != null ? String(mlBuyerIdChat) : String(chatId);
      } else if (linkType === "phone") {
        source = "whatsapp";
        externalId = digits || String(chatId);
      }

      const metadata = {
        confirmed_by: Number.isFinite(confirmedBy) ? confirmedBy : null,
        chat_id: chatId,
        link_type: linkType,
      };

      await pool.query(
        `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary, metadata)
         VALUES ($1, $2::crm_identity_source, $3, false, $4::jsonb)
         ON CONFLICT (source, external_id) DO NOTHING`,
        [customerId, source, externalId, JSON.stringify(metadata)]
      );

      const extMsg = `out-${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO crm_messages (
           chat_id, customer_id, direction, type, content, sent_by,
           external_message_id, is_read, ai_reply_status
         ) VALUES (
           $1, $2, 'outbound', 'text', $3::jsonb,
           $4, $5, true, NULL
         )`,
        [
          chatId,
          customerId,
          JSON.stringify({ text: `Cliente vinculado: ${fullName}` }),
          String(confirmedBy),
          extMsg,
        ]
      );

      const { rows: outRows } = await pool.query(`SELECT * FROM crm_chats WHERE id = $1`, [chatId]);
      writeJson(res, 200, { chat: outRows[0] });
      return true;
    }

    if (req.method === "POST" && sub === "link-ml-order") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const mlOrderId = body.ml_order_id != null ? Number(body.ml_order_id) : NaN;
      const confirmedByRaw = body.confirmed_by != null ? Number(body.confirmed_by) : user.userId;
      const confirmedBy = Number.isFinite(confirmedByRaw) ? confirmedByRaw : user.userId;
      if (!Number.isFinite(mlOrderId) || mlOrderId <= 0) {
        writeJson(res, 400, { error: "bad_request", message: "ml_order_id inválido" });
        return true;
      }

      const ord = await pool.query(`SELECT id FROM sales_orders WHERE id = $1`, [mlOrderId]);
      if (!ord.rows.length) {
        writeJson(res, 404, { error: "not_found", message: "Orden no encontrada" });
        return true;
      }

      await pool.query(
        `UPDATE crm_chats SET
           ml_order_id = $1,
           identity_status = 'manual_linked',
           source_type = 'wa_ml_linked',
           identity_candidates = NULL,
           updated_at = NOW()
         WHERE id = $2`,
        [mlOrderId, chatId]
      );

      const extMsg = `out-${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO crm_messages (
           chat_id, customer_id, direction, type, content, sent_by,
           external_message_id, is_read, ai_reply_status
         ) VALUES (
           $1,
           (SELECT customer_id FROM crm_chats WHERE id = $1),
           'outbound', 'text', $2::jsonb,
           $3, $4, true, NULL
         )`,
        [
          chatId,
          JSON.stringify({ text: `Orden ML #${mlOrderId} vinculada` }),
          String(confirmedBy),
          extMsg,
        ]
      );

      const { rows: outRows } = await pool.query(`SELECT * FROM crm_chats WHERE id = $1`, [chatId]);
      writeJson(res, 200, { chat: outRows[0] });
      return true;
    }

    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    logger.error({ err }, "inbox_identity_error");
    writeJson(res, 500, {
      error: "error",
      message: isDev && err && err.message ? String(err.message) : "Internal server error",
    });
    return true;
  }
}

module.exports = { handleInboxIdentityRequest };
