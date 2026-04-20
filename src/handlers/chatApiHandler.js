"use strict";

const { z } = require("zod");
const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const {
  listChats,
  getChatContext,
  listMessages,
  markChatRead,
  patchChat,
  getWaStatus,
  DEFAULT_MESSAGES_PAGE_LIMIT,
} = require("../services/chatService");
const { sendChatMessage } = require("../services/chatMessageService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "chat_api",
});

const patchSchema = z.object({
  needs_followup: z.boolean().optional(),
  unread_count: z.number().int().min(0).optional(),
  is_ai_generating: z.boolean().optional(),
});

const CRM_SCHEMA_BODY = {
  error: "crm_schema_missing",
  message:
    "Faltan tablas CRM en la base de datos. Ejecutar en orden contra DATABASE_URL: npm run db:crm luego npm run db:whatsapp-hub (requiere psql en PATH).",
  detail:
    "Migraciones: sql/crm-solomotor3k.sql (db:crm) y sql/20260410_whatsapp_hub.sql (db:whatsapp-hub).",
};

function isCrmSchemaMissing(err) {
  if (!err) return false;
  if (err.code === "CRM_SCHEMA_MISSING") return true;
  if (String(err.message || "") === "crm_schema_missing") return true;
  const c = err.cause;
  if (c && (c.code === "42P01" || c.code === "42704")) return true;
  return false;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 256 * 1024;
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
 * Rutas CRM WhatsApp Hub: /api/crm/chats*, /api/crm/system/wa-status
 * @returns {Promise<boolean>} true si la petición fue manejada
 */
async function handleChatApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/crm/chats") && pathname !== "/api/crm/system/wa-status") {
    return false;
  }

  const isDev = process.env.NODE_ENV !== "production";
  applyCrmApiCorsHeaders(req, res);

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  try {
    if (req.method === "GET" && pathname === "/api/crm/chats") {
      const q = url.searchParams.get("q") || undefined;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const nf = url.searchParams.get("needs_followup");
      let needs_followup;
      if (nf === "1" || nf === "true") needs_followup = true;
      if (nf === "0" || nf === "false") needs_followup = false;
      const data = await listChats({
        q,
        limit: limit != null ? Number(limit) : 50,
        offset: offset != null ? Number(offset) : 0,
        needs_followup,
      });
      writeJson(res, 200, data);
      return true;
    }

    const ctxMatch = pathname.match(/^\/api\/crm\/chats\/(\d+)\/context$/);
    if (ctxMatch && req.method === "GET") {
      const row = await getChatContext(ctxMatch[1]);
      if (!row) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, row);
      return true;
    }

    const msgMatch = pathname.match(/^\/api\/crm\/chats\/(\d+)\/messages$/);
    if (msgMatch && req.method === "POST") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const text = body && body.text != null ? String(body.text) : "";
      if (!text.trim()) {
        writeJson(res, 400, { error: "bad_request", message: "text requerido" });
        return true;
      }
      const sentBy =
        body && body.sent_by != null && String(body.sent_by).trim() !== ""
          ? String(body.sent_by).trim()
          : String(user.userId != null ? user.userId : "");
      try {
        const out = await sendChatMessage(msgMatch[1], text, sentBy);
        writeJson(res, 200, out);
      } catch (e) {
        if (e && e.code === "BAD_REQUEST") {
          writeJson(res, 400, { error: "bad_request", message: e.message });
          return true;
        }
        if (e && e.code === "NOT_FOUND") {
          writeJson(res, 404, { error: "not_found" });
          return true;
        }
        if (e && e.code === "SERVICE_UNAVAILABLE") {
          writeJson(res, 503, { error: "wasender_not_configured" });
          return true;
        }
        if (e && e.code === "WASENDER_ERROR") {
          writeJson(res, e.httpStatus || 502, {
            error: "wasender_error",
            message: e.message,
          });
          return true;
        }
        throw e;
      }
      return true;
    }

    if (msgMatch && req.method === "GET") {
      const before_id = url.searchParams.get("before_id");
      const limit = url.searchParams.get("limit");
      const markReadParam = url.searchParams.get("mark_read");
      const skipMarkRead =
        markReadParam === "0" ||
        markReadParam === "false" ||
        String(markReadParam || "").toLowerCase() === "no";
      const lim =
        limit != null && String(limit).trim() !== ""
          ? Number(limit)
          : DEFAULT_MESSAGES_PAGE_LIMIT;
      const data = await listMessages(msgMatch[1], {
        before_id: before_id != null && String(before_id).trim() !== "" ? Number(before_id) : undefined,
        limit: lim,
      });
      const isFirstPage =
        before_id == null || String(before_id).trim() === "";
      if (isFirstPage && !skipMarkRead) {
        try {
          await markChatRead(msgMatch[1]);
        } catch (e) {
          logger.warn({ err: e, chatId: msgMatch[1] }, "mark_chat_read_failed");
        }
      }
      writeJson(res, 200, data);
      return true;
    }

    const patchMatch = pathname.match(/^\/api\/crm\/chats\/(\d+)$/);
    if (patchMatch && req.method === "PATCH") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const row = await patchChat(patchMatch[1], parsed.data);
      if (!row) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { chat: row });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/crm/system/wa-status") {
      const data = await getWaStatus();
      writeJson(res, 200, data);
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    if (e && e.name === "ZodError") {
      writeJson(res, 422, { error: "validation_error", details: e.issues });
      return true;
    }
    if (isCrmSchemaMissing(e)) {
      writeJson(res, 503, CRM_SCHEMA_BODY);
      return true;
    }
    logger.error({ err: e }, "chat_api_error");
    writeJson(res, 500, {
      error: "error",
      message: isDev && e && e.message ? String(e.message) : "Internal server error",
    });
    return true;
  }
}

module.exports = { handleChatApiRequest };
