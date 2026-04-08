"use strict";

const { z } = require("zod");
const pino = require("pino");
const { timingSafeCompare } = require("../services/currencyService");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const {
  listChats,
  getChatContext,
  listMessages,
  patchChat,
  getWaStatus,
} = require("../services/chatService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "chat_api",
});

const patchSchema = z.object({
  needs_followup: z.boolean().optional(),
  unread_count: z.number().int().min(0).optional(),
  is_ai_generating: z.boolean().optional(),
});

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

function ensureAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    writeJson(res, 503, { error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  const provided = req.headers["x-admin-secret"];
  if (!timingSafeCompare(provided, secret)) {
    writeJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
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

  if (!ensureAdmin(req, res)) return true;

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
    if (msgMatch && req.method === "GET") {
      const before_id = url.searchParams.get("before_id");
      const limit = url.searchParams.get("limit");
      const data = await listMessages(msgMatch[1], {
        before_id: before_id != null ? Number(before_id) : undefined,
        limit: limit != null ? Number(limit) : 50,
      });
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
    logger.error({ err: e }, "chat_api_error");
    writeJson(res, 500, {
      error: "error",
      message: isDev && e && e.message ? String(e.message) : "Internal server error",
    });
    return true;
  }
}

module.exports = { handleChatApiRequest };
