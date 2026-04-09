"use strict";

/**
 * Endpoints para enviar media desde el sistema al cliente WhatsApp.
 *
 * POST /api/media/send-image
 * POST /api/media/send-audio
 * POST /api/media/send-video
 * POST /api/media/send-document
 * GET  /api/media/customer/:customer_id
 *
 * Auth: X-Admin-Secret (o ?k= si ADMIN_SECRET_QUERY_AUTH no está en 0)
 * Body: JSON con file_base64 (data:mime;base64,... o base64 plano)
 */

const { z }           = require("zod");
const pino            = require("pino");
const { pool }        = require("../../db");
const { ensureAdmin } = require("../middleware/adminAuth");
const { sendMedia }   = require("../whatsapp/media/outboundMedia");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "mediaApiHandler" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Extrae Buffer y mimeType desde un string base64 con o sin data-URI header. */
function base64ToBuffer(base64String, fallbackMime) {
  let mimeType   = fallbackMime;
  let base64Data = base64String;

  const match = String(base64String).match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    mimeType   = match[1];
    base64Data = match[2];
  }

  return {
    buffer:   Buffer.from(base64Data, "base64"),
    mimeType,
  };
}

const SENT_BY_VALUES = ["jesus", "sebastian", "javier", "system", "ai"];

const sendMediaSchema = z.object({
  to_phone:    z.string().regex(/^\d{10,15}$/, "Formato: dígitos únicamente (ej. 584XXXXXXXXX)"),
  file_base64: z.string().min(10),
  caption:     z.string().max(1024).optional(),
  file_name:   z.string().max(255).optional(),
  sent_by:     z.enum(SENT_BY_VALUES).default("system"),
});

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

/**
 * Maneja las rutas /api/media/*.
 * @returns {Promise<boolean>} true si la ruta fue atendida
 */
async function handleMediaApiRequest(req, res, url) {
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/media/")) return false;

  if (!ensureAdmin(req, res, url)) return true;

  try {
    // POST /api/media/send-image
    if (req.method === "POST" && pathname === "/api/media/send-image") {
      const body   = await parseJsonBody(req);
      const parsed = sendMediaSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(res, 400, { ok: false, error: "VALIDATION_ERROR", issues: parsed.error.errors });
        return true;
      }
      const { to_phone, file_base64, caption, sent_by } = parsed.data;
      const { buffer, mimeType } = base64ToBuffer(file_base64, "image/jpeg");
      const result = await sendMedia({ toPhone: to_phone, mediaType: "image", buffer, mimeType, caption, sentBy: sent_by });
      writeJson(res, 201, { ok: true, result });
      return true;
    }

    // POST /api/media/send-audio
    if (req.method === "POST" && pathname === "/api/media/send-audio") {
      const body   = await parseJsonBody(req);
      const parsed = sendMediaSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(res, 400, { ok: false, error: "VALIDATION_ERROR", issues: parsed.error.errors });
        return true;
      }
      const { to_phone, file_base64, sent_by } = parsed.data;
      const { buffer, mimeType } = base64ToBuffer(file_base64, "audio/ogg");
      const result = await sendMedia({ toPhone: to_phone, mediaType: "audio", buffer, mimeType, sentBy: sent_by });
      writeJson(res, 201, { ok: true, result });
      return true;
    }

    // POST /api/media/send-video
    if (req.method === "POST" && pathname === "/api/media/send-video") {
      const body   = await parseJsonBody(req);
      const parsed = sendMediaSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(res, 400, { ok: false, error: "VALIDATION_ERROR", issues: parsed.error.errors });
        return true;
      }
      const { to_phone, file_base64, caption, sent_by } = parsed.data;
      const { buffer, mimeType } = base64ToBuffer(file_base64, "video/mp4");
      const result = await sendMedia({ toPhone: to_phone, mediaType: "video", buffer, mimeType, caption, sentBy: sent_by });
      writeJson(res, 201, { ok: true, result });
      return true;
    }

    // POST /api/media/send-document
    if (req.method === "POST" && pathname === "/api/media/send-document") {
      const body   = await parseJsonBody(req);
      const parsed = sendMediaSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(res, 400, { ok: false, error: "VALIDATION_ERROR", issues: parsed.error.errors });
        return true;
      }
      const { to_phone, file_base64, caption, file_name, sent_by } = parsed.data;
      const { buffer, mimeType } = base64ToBuffer(file_base64, "application/pdf");
      const result = await sendMedia({
        toPhone: to_phone, mediaType: "document",
        buffer, mimeType, caption, fileName: file_name, sentBy: sent_by,
      });
      writeJson(res, 201, { ok: true, result });
      return true;
    }

    // GET /api/media/customer/:customer_id
    if (req.method === "GET" && pathname.startsWith("/api/media/customer/")) {
      const customerId = pathname.split("/").pop();
      if (!customerId || !/^\d+$/.test(customerId)) {
        writeJson(res, 400, { ok: false, error: "customer_id inválido" });
        return true;
      }
      const { rows } = await pool.query(
        `SELECT id, direction, type, content, sent_by, created_at
         FROM crm_messages
         WHERE customer_id = $1
           AND type IN ('image','audio','video','document','sticker')
         ORDER BY created_at DESC
         LIMIT 50`,
        [customerId]
      );
      writeJson(res, 200, { ok: true, media: rows });
      return true;
    }

    return false;
  } catch (err) {
    log.error({ err: err.message, pathname }, "mediaApiHandler error");
    const status = err.status || 500;
    writeJson(res, status, { ok: false, error: err.code || "INTERNAL_ERROR", message: err.message });
    return true;
  }
}

module.exports = { handleMediaApiRequest };
