"use strict";

/**
 * API interna para responder mensajes de Facebook Messenger desde el ERP.
 *
 * Rutas:
 *   POST /api/inbox/:chatId/fb/reply
 *     body: { text: string, answered_by?: string }
 *
 * Auth: requireAdminOrPermission (mismo patrón que el resto de /api/inbox/*)
 */

const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");
const { sendTextMessage } = require("../services/fbPageClient");
const { insertFbOutboundMessage } = require("../services/fbPageInboxBridge");
const { applyOutboundOmnichannelHook } = require("../services/omnichannelOutboundHook");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "inbox_fb_api" });

const RE_FB_REPLY = /^\/api\/inbox\/(\d+)\/fb\/reply$/;

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 64 * 1024;
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
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleInboxFbRequest(req, res, url) {
  applyCrmApiCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const pathname = String(url.pathname || "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  const mReply = RE_FB_REPLY.exec(pathname);

  if (!mReply) return false;

  // ── POST /api/inbox/:chatId/fb/reply ──────────────────────────────────────
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "usa POST" });
    return true;
  }

  if (await requireAdminOrPermission(req, res, "inbox")) return true;

  const chatId = Number(mReply[1]);

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    writeJson(res, 400, { ok: false, error: "body_inválido" });
    return true;
  }

  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    writeJson(res, 422, { ok: false, error: "text es requerido" });
    return true;
  }

  const answeredBy = (body && body.answered_by) ? String(body.answered_by).trim() : "agent";

  // Obtener fb_psid del chat
  const { rows } = await pool.query(
    `SELECT fb_psid, source_type FROM crm_chats WHERE id = $1 LIMIT 1`,
    [chatId]
  );

  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "chat no encontrado" });
    return true;
  }

  const chat = rows[0];
  if (chat.source_type !== "fb_page" || !chat.fb_psid) {
    writeJson(res, 422, { ok: false, error: "el chat no es de tipo fb_page o no tiene fb_psid" });
    return true;
  }

  // Enviar a Meta Graph API
  let fbResult;
  try {
    fbResult = await sendTextMessage(chat.fb_psid, text);
  } catch (e) {
    logger.error({ err: e, chatId }, "[fb_reply] error al llamar a Graph API");
    writeJson(res, 502, { ok: false, error: "error de red al contactar Meta" });
    return true;
  }

  if (!fbResult.ok) {
    logger.warn({ status: fbResult.status, data: fbResult.data, chatId }, "[fb_reply] Meta rechazó el mensaje");
    writeJson(res, 502, {
      ok: false,
      error: "Meta rechazó el mensaje",
      meta_status: fbResult.status,
      meta_error: fbResult.data,
    });
    return true;
  }

  // mid devuelto por Meta (puede no existir si el formato cambió)
  const sentMid = fbResult.data && fbResult.data.message_id ? String(fbResult.data.message_id) : null;

  // Registrar en crm_messages
  await insertFbOutboundMessage({ chatId, mid: sentMid, text, sentBy: answeredBy });

  // Hook outbound (marca ATTENDED, limpia badge, SSE clear_notification)
  try {
    await applyOutboundOmnichannelHook(pool, chatId);
  } catch (e) {
    logger.warn({ err: e, chatId }, "[fb_reply] error en outbound hook (no crítico)");
  }

  writeJson(res, 200, { ok: true, mid: sentMid });
  return true;
}

module.exports = { handleInboxFbRequest };
