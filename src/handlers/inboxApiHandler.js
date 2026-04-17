"use strict";

const crypto = require("crypto");
const pino = require("pino");
const { pool } = require("../../db");
const { mercadoLibrePostJsonForUser } = require("../../oauth-token");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { listInbox, getInboxCounts, FILTERS, SRCS } = require("../services/inboxService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_api",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBodyInbox(req) {
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

/**
 * Inbox unificado CRM + órdenes: GET /api/inbox, GET /api/inbox/counts
 * @returns {Promise<boolean>}
 */
async function handleInboxApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/inbox")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (!(await requireAdminOrPermission(req, res, "crm"))) {
    return true;
  }

  try {
    if (req.method === "GET" && pathname === "/api/inbox/counts") {
      const data = await getInboxCounts();
      writeJson(res, 200, data);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/inbox") {
      const filter = url.searchParams.get("filter");
      const src = url.searchParams.get("src");
      const search = url.searchParams.get("search");
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");

      if (filter != null && filter !== "" && !FILTERS.has(filter)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `filter inválido. Valores: ${[...FILTERS].join(", ")} o vacío`,
        });
        return true;
      }
      if (src != null && src !== "" && !SRCS.has(src)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `src inválido. Valores: ${[...SRCS].join(", ")} o vacío`,
        });
        return true;
      }

      const data = await listInbox({
        filter: filter || null,
        src: src || null,
        search: search || null,
        cursor: cursor || null,
        limit,
      });
      writeJson(res, 200, data);
      return true;
    }

    const mlMsgReply = (url.pathname || "").match(/^\/api\/inbox\/(\d+)\/ml-message\/reply\/?$/);
    if (req.method === "POST" && mlMsgReply) {
      const chatId = Number(mlMsgReply[1]);
      if (!Number.isFinite(chatId) || chatId <= 0) {
        writeJson(res, 400, { code: "BAD_REQUEST", message: "chatId inválido" });
        return true;
      }

      let body;
      try {
        body = await parseJsonBodyInbox(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }

      const rawText = body && body.text != null ? String(body.text) : "";
      const text = rawText.trim();
      if (!text) {
        writeJson(res, 400, {
          code: "MISSING_TEXT",
          message: "El texto de respuesta es requerido",
        });
        return true;
      }
      if (text.length > 350) {
        writeJson(res, 400, {
          code: "TEXT_TOO_LONG",
          message: "El texto no puede superar 350 caracteres (límite ML)",
        });
        return true;
      }

      const answeredBy =
        body && body.answered_by != null && String(body.answered_by).trim() !== ""
          ? String(body.answered_by).trim()
          : null;

      const { rows: chatRows } = await pool.query(
        `SELECT
           cc.id,
           cc.source_type,
           cc.ml_order_id,
           cc.ml_buyer_id,
           COALESCE(so.ml_user_id, mo.ml_user_id) AS ml_user_id
         FROM crm_chats cc
         LEFT JOIN sales_orders so ON so.id = cc.ml_order_id
         LEFT JOIN LATERAL (
           SELECT ml_user_id FROM ml_orders
           WHERE order_id = cc.ml_order_id
           ORDER BY updated_at DESC NULLS LAST, id DESC
           LIMIT 1
         ) mo ON true
         WHERE cc.id = $1`,
        [chatId]
      );

      if (!chatRows.length) {
        writeJson(res, 404, { code: "CHAT_NOT_FOUND" });
        return true;
      }

      const cr = chatRows[0];
      if (String(cr.source_type) !== "ml_message") {
        writeJson(res, 422, {
          code: "WRONG_CHAT_TYPE",
          message: "Este chat no es de mensajería ML",
        });
        return true;
      }
      if (cr.ml_order_id == null) {
        writeJson(res, 422, {
          code: "NO_ORDER_LINKED",
          message: "Chat sin orden ML vinculada",
        });
        return true;
      }
      const mlUserResolved = cr.ml_user_id != null ? Number(cr.ml_user_id) : NaN;
      if (!Number.isFinite(mlUserResolved) || mlUserResolved <= 0) {
        writeJson(res, 422, {
          code: "NO_ML_USER",
          message: "No se encontró cuenta ML vendedora",
        });
        return true;
      }
      const mlOrderId = Number(cr.ml_order_id);
      const mlBuyerId =
        cr.ml_buyer_id != null && String(cr.ml_buyer_id).trim() !== ""
          ? Number(cr.ml_buyer_id)
          : NaN;
      if (!Number.isFinite(mlBuyerId) || mlBuyerId <= 0) {
        writeJson(res, 422, {
          code: "NO_BUYER",
          message: "Chat sin comprador ML (ml_buyer_id)",
        });
        return true;
      }

      const appId = String(
        process.env.OAUTH_CLIENT_ID || process.env.ML_APPLICATION_ID || process.env.ML_CLIENT_ID || ""
      ).trim();
      if (!appId) {
        writeJson(res, 503, {
          code: "ML_APP_ID_MISSING",
          message: "Falta OAUTH_CLIENT_ID o ML_APPLICATION_ID",
        });
        return true;
      }

      const q = new URLSearchParams({
        application_id: appId,
        tag: "post_sale",
      });
      const path = `/messages/packs/${mlOrderId}/sellers/${mlUserResolved}?${q.toString()}`;

      const mlRes = await mercadoLibrePostJsonForUser(mlUserResolved, path, {
        from: { user_id: mlUserResolved },
        to: { user_id: mlBuyerId },
        option_id: "OTHER",
        text,
      });

      const okHttp = mlRes.ok && (mlRes.status === 200 || mlRes.status === 201);
      if (!okHttp) {
        console.error("[inbox/ml-reply]", mlRes);
        writeJson(res, 502, {
          code: "ML_SEND_FAILED",
          message: "Error al enviar mensaje por ML",
          ml_status: mlRes.status,
        });
        return true;
      }

      const extId = `ml_reply_${chatId}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
      const sentBy = answeredBy || "agent";

      await pool.query(
        `INSERT INTO crm_messages (
           chat_id, external_message_id, direction, type, content,
           sent_by, is_read, created_at
         ) VALUES (
           $1, $2, 'outbound', 'text', $3::jsonb,
           $4, true, NOW()
         )
         ON CONFLICT (external_message_id) DO NOTHING`,
        [chatId, extId, JSON.stringify({ text }), sentBy]
      );

      await pool.query(
        `UPDATE crm_chats SET
           last_message_text = $1,
           last_message_at = NOW(),
           updated_at = NOW()
         WHERE id = $2`,
        [text, chatId]
      );

      writeJson(res, 200, {
        ok: true,
        chat_id: chatId,
        ml_order_id: mlOrderId,
        text,
      });
      return true;
    }

    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    if (err && err.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: err.message });
      return true;
    }
    if (err && err.code === "CRM_SCHEMA_MISSING") {
      writeJson(res, 503, {
        error: "crm_schema_missing",
        message: err.message || String(err),
      });
      return true;
    }
    logger.error({ err: err.message }, "inbox_api");
    writeJson(res, 500, { error: "internal_error" });
    return true;
  }
}

module.exports = { handleInboxApiRequest };
