"use strict";

/**
 * Handler para webhooks de Facebook Messenger (Pages API).
 *
 * Rutas:
 *   GET  /webhook/facebook  — verificación inicial de Meta (hub.challenge)
 *   POST /webhook/facebook  — mensajes entrantes
 *
 * Variables de entorno:
 *   FB_WEBHOOK_VERIFY_TOKEN  — token libre configurado en Meta Developers
 *   FB_APP_SECRET            — para validar firma X-Hub-Signature-256
 *   FB_ENABLED               — "1" para activar el handler (default inactivo)
 */

const pino = require("pino");
const { pool } = require("../../db");
const { verifyWebhookSignature } = require("../services/fbPageClient");
const { upsertFbMessageChat } = require("../services/fbPageInboxBridge");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "fb_webhook" });

const FB_WEBHOOK_PATH = "/webhook/facebook";

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Lee el body completo como Buffer (para poder verificar la firma antes de parsear).
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const max = 512 * 1024;
    req.on("data", (c) => {
      total += c.length;
      if (total > max) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Extrae entradas de mensajes del payload de Meta.
 * Meta envía: { object: "page", entry: [{ id, messaging: [...] }] }
 * @param {object} body
 * @returns {Array<{ psid:string, pageId:string, mid:string, text:string, timestamp:number, attachments?:object[] }>}
 */
function extractMessagingEntries(body) {
  const entries = [];
  if (!body || body.object !== "page" || !Array.isArray(body.entry)) return entries;

  for (const pageEntry of body.entry) {
    const pageId = String(pageEntry.id || "");
    const messaging = Array.isArray(pageEntry.messaging) ? pageEntry.messaging : [];

    for (const ev of messaging) {
      // Solo mensajes entrantes (no echoes, no delivery, no read)
      if (!ev.message) continue;
      if (ev.message.is_echo) continue;

      const psid = String((ev.sender && ev.sender.id) || "");
      const mid = String(ev.message.mid || "");
      if (!psid || !mid) continue;

      entries.push({
        psid,
        pageId,
        mid,
        text: String(ev.message.text || ""),
        timestamp: ev.timestamp || Date.now(),
        attachments: Array.isArray(ev.message.attachments) ? ev.message.attachments : undefined,
      });
    }
  }
  return entries;
}

/**
 * Registra el evento en fb_webhook_events (idempotencia por mid).
 * @param {import('pg').Pool} db
 * @param {{ mid:string, pageId:string, psid:string, raw:object }} opts
 */
async function logFbWebhookEvent(db, opts) {
  try {
    await db.query(
      `INSERT INTO fb_webhook_events (mid, page_id, psid, raw_payload, status, created_at)
       VALUES ($1, $2, $3, $4::jsonb, 'received', NOW())
       ON CONFLICT (mid) DO NOTHING`,
      [opts.mid, opts.pageId || null, opts.psid || null, JSON.stringify(opts.raw)]
    );
  } catch (_e) {
    /* tabla puede no existir aún — no es crítico */
  }
}

/**
 * Marca un evento como procesado o con error.
 * @param {import('pg').Pool} db
 * @param {string} mid
 * @param {'processed'|'skipped'|'error'} status
 * @param {string} [errorMsg]
 */
async function markFbWebhookEvent(db, mid, status, errorMsg) {
  try {
    await db.query(
      `UPDATE fb_webhook_events
       SET status = $2, error_msg = $3, processed_at = NOW()
       WHERE mid = $1`,
      [mid, status, errorMsg || null]
    );
  } catch (_e) {
    /* ignorar */
  }
}

/**
 * Procesa entradas de forma asíncrona (setImmediate → no bloquea el 200).
 * @param {object} body
 */
async function processInboundEntries(body) {
  const entries = extractMessagingEntries(body);
  if (!entries.length) return;

  for (const entry of entries) {
    await logFbWebhookEvent(pool, { mid: entry.mid, pageId: entry.pageId, psid: entry.psid, raw: body });

    try {
      const result = await upsertFbMessageChat(entry);
      await markFbWebhookEvent(pool, entry.mid, result.skipped ? "skipped" : "processed");
      logger.info(
        { psid: entry.psid, mid: entry.mid, chatId: result.chatId, isNew: result.isNew },
        "[fb] mensaje inbound procesado"
      );
    } catch (e) {
      logger.error({ err: e, mid: entry.mid }, "[fb] error procesando mensaje inbound");
      await markFbWebhookEvent(pool, entry.mid, "error", e.message);
    }
  }
}

/**
 * Punto de entrada del handler. Retorna `true` si atendió la ruta.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleFacebookWebhookRequest(req, res, url) {
  if (url.pathname !== FB_WEBHOOK_PATH) return false;

  // ── GET: verificación del endpoint por Meta ──────────────────────────────
  if (req.method === "GET") {
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expected  = process.env.FB_WEBHOOK_VERIFY_TOKEN || "";

    if (mode === "subscribe" && token === expected && challenge) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge);
      logger.info("[fb] verificación de endpoint OK");
    } else {
      writeJson(res, 403, { ok: false, error: "verify_token_mismatch" });
      logger.warn({ mode, token }, "[fb] verificación fallida");
    }
    return true;
  }

  // ── POST: mensajes entrantes ─────────────────────────────────────────────
  if (req.method === "POST") {
    // Leer body como Buffer primero (necesario para firma HMAC)
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (e) {
      writeJson(res, 400, { ok: false, error: "body_error" });
      return true;
    }

    // Validar firma si FB_APP_SECRET está configurado
    const sig = req.headers["x-hub-signature-256"];
    if (process.env.FB_APP_SECRET) {
      if (!verifyWebhookSignature(rawBody, sig)) {
        logger.warn({ sig }, "[fb] firma inválida — rechazando POST");
        writeJson(res, 401, { ok: false, error: "invalid_signature" });
        return true;
      }
    }

    // ACK inmediato a Meta (obligatorio < ~5 s para no recibir reintentos)
    writeJson(res, 200, { ok: true });

    // Parsear y procesar de forma asíncrona
    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch (_) {
      logger.warn("[fb] POST con body no-JSON — ignorado tras 200");
      return true;
    }

    setImmediate(() => {
      processInboundEntries(body).catch((e) =>
        logger.error({ err: e }, "[fb] error inesperado en processInboundEntries")
      );
    });

    return true;
  }

  // Método no soportado
  writeJson(res, 405, { ok: false, error: "method_not_allowed" });
  return true;
}

module.exports = { handleFacebookWebhookRequest };
