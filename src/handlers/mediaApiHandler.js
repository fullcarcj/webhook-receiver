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
const { requireAdminOrPermission } = require("../utils/authMiddleware");
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

  const isMediaApiPath = pathname.startsWith("/api/media/");
  const isMediaLogsHtmlPath = pathname === "/media-logs" || pathname === "/media-logs/";
  if (!isMediaApiPath && !isMediaLogsHtmlPath) return false;

  if (!await requireAdminOrPermission(req, res, 'catalog')) return true;

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

    // GET /api/media/logs
    // Filtros opcionales:
    //   ?limit=100 (máx 1000)
    //   ?offset=0
    //   ?type=image|audio|video|document|sticker
    //   ?direction=inbound|outbound
    //   ?phone=584XXXXXXXXX (busca por crm_chats.phone)
    //   ?customer_id=123
    if (req.method === "GET" && pathname === "/api/media/logs") {
      const limitRaw = Number.parseInt(String(url.searchParams.get("limit") || "100"), 10);
      const offsetRaw = Number.parseInt(String(url.searchParams.get("offset") || "0"), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100;
      const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

      const type = String(url.searchParams.get("type") || "").trim().toLowerCase();
      const direction = String(url.searchParams.get("direction") || "").trim().toLowerCase();
      const phoneDigits = String(url.searchParams.get("phone") || "").replace(/\D/g, "");
      const customerId = String(url.searchParams.get("customer_id") || "").trim();

      const where = [`m.type IN ('image','audio','video','document','sticker')`];
      const args = [];
      let i = 1;

      if (type) {
        where.push(`m.type = $${i++}`);
        args.push(type);
      }
      if (direction) {
        where.push(`m.direction = $${i++}`);
        args.push(direction);
      }
      if (phoneDigits) {
        where.push(`REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = $${i++}`);
        args.push(phoneDigits);
      }
      if (customerId) {
        if (!/^\d+$/.test(customerId)) {
          writeJson(res, 400, { ok: false, error: "customer_id inválido" });
          return true;
        }
        where.push(`m.customer_id = $${i++}`);
        args.push(Number(customerId));
      }

      args.push(limit);
      args.push(offset);

      const { rows } = await pool.query(
        `SELECT
           m.id,
           m.chat_id,
           m.customer_id,
           m.direction,
           m.type,
           m.sent_by,
           m.created_at,
           c.phone AS chat_phone,
           m.content->>'mediaUrl' AS media_url,
           m.content->>'mimeType' AS mime_type,
           m.content->>'caption' AS caption,
           m.content->>'fileName' AS file_name,
           m.content->>'transcription' AS transcription,
           m.content->>'transcription_error' AS transcription_error
         FROM crm_messages m
         LEFT JOIN crm_chats c ON c.id = m.chat_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        args
      );

      writeJson(res, 200, {
        ok: true,
        filters: {
          type: type || null,
          direction: direction || null,
          phone: phoneDigits || null,
          customer_id: customerId || null,
          limit,
          offset,
        },
        logs: rows,
      });
      return true;
    }

    // GET /media-logs (HTML simple para monitoreo visual)
    if (req.method === "GET" && isMediaLogsHtmlPath) {
      const limitRaw = Number.parseInt(String(url.searchParams.get("limit") || "100"), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
      const type = String(url.searchParams.get("type") || "").trim().toLowerCase();
      const direction = String(url.searchParams.get("direction") || "").trim().toLowerCase();
      const phoneDigits = String(url.searchParams.get("phone") || "").replace(/\D/g, "");

      const where = [`m.type IN ('image','audio','video','document','sticker')`];
      const args = [];
      let i = 1;
      if (type) {
        where.push(`m.type = $${i++}`);
        args.push(type);
      }
      if (direction) {
        where.push(`m.direction = $${i++}`);
        args.push(direction);
      }
      if (phoneDigits) {
        where.push(`REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = $${i++}`);
        args.push(phoneDigits);
      }
      where.push(`m.content->>'mediaUrl' IS NOT NULL`);
      args.push(limit);

      const { rows } = await pool.query(
        `SELECT
           m.id,
           m.customer_id,
           m.direction,
           m.type,
           m.sent_by,
           m.created_at,
           c.phone AS chat_phone,
           m.content->>'mediaUrl' AS media_url,
           m.content->>'mimeType' AS mime_type,
           m.content->>'caption' AS caption,
           m.content->>'fileName' AS file_name,
           m.content->>'transcription' AS transcription,
           m.content->>'transcription_error' AS transcription_error
         FROM crm_messages m
         LEFT JOIN crm_chats c ON c.id = m.chat_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.created_at DESC
         LIMIT $${i++}`,
        args
      );

      const esc = (v) =>
        String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");

      const mediaCell = (r) => {
        const urlEsc = esc(r.media_url || "");
        const typeV = String(r.type || "");
        if (!r.media_url) return "-";
        if (typeV === "image") return `<a href="${urlEsc}" target="_blank" rel="noreferrer">Abrir imagen</a>`;
        if (typeV === "audio") return `<audio controls preload="none" src="${urlEsc}" style="max-width:260px;"></audio>`;
        if (typeV === "video") return `<video controls preload="none" src="${urlEsc}" style="max-width:260px;max-height:160px;"></video>`;
        return `<a href="${urlEsc}" target="_blank" rel="noreferrer">Descargar</a>`;
      };

      const rowsHtml = rows
        .map(
          (r) => `<tr>
  <td>${esc(r.id)}</td>
  <td>${esc(r.created_at)}</td>
  <td>${esc(r.direction)}</td>
  <td>${esc(r.type)}</td>
  <td>${esc(r.chat_phone || "")}</td>
  <td>${esc(r.sent_by || "")}</td>
  <td>${esc(r.caption || "")}</td>
  <td>${mediaCell(r)}</td>
  <td style="max-width:280px;white-space:pre-wrap;">${esc(r.transcription || "")}</td>
  <td style="max-width:280px;white-space:pre-wrap;color:#f88;">${esc(r.transcription_error || "")}</td>
</tr>`
        )
        .join("\n");

      const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Media Logs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; margin: 16px; background: #111; color: #eee; }
    h1 { margin: 0 0 12px; }
    .meta { color: #bbb; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; background: #1a1a1a; }
    th, td { border: 1px solid #333; padding: 8px; font-size: 12px; vertical-align: top; }
    th { position: sticky; top: 0; background: #222; z-index: 1; }
    a { color: #7ab7ff; }
  </style>
</head>
<body>
  <h1>Media Logs</h1>
  <div class="meta">Mostrando ${rows.length} registro(s). Filtros: type=${esc(type || "-")}, direction=${esc(direction || "-")}, phone=${esc(phoneDigits || "-")}, limit=${esc(limit)}</div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Fecha</th>
        <th>Dir</th>
        <th>Tipo</th>
        <th>Teléfono</th>
        <th>Sent By</th>
        <th>Caption</th>
        <th>Media</th>
        <th>Transcripción</th>
        <th>Motivo error</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="10">Sin registros.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
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
