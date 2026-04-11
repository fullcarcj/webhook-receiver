"use strict";

const pino = require("pino");
const { parseWebhookJobs } = require("./payloadParser");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "whatsapp_hub",
});

const processors = {
  "messages.received": require("./processors/messages"),
  /** Alias Wasender: mismo handler que `messages.received` (por si el evento llega sin normalizar). */
  "messages-personal.received": require("./processors/messages"),
  "messages.update": require("./processors/messages"),
  "message-receipt.update": require("./processors/receipts"),
  "reactions.received": require("./processors/reactions"),
  "contacts.upsert": require("./processors/contacts"),
  "contacts.update": require("./processors/contacts"),
  "calls.received": require("./processors/calls"),
  "calls.missed": require("./processors/calls"),
  "session.status": require("./processors/session"),
  "messages.sent": require("./processors/sent"),
};

const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);
const mediaProcessor = require("./processors/media");
const { detectMedia, extractRawMessage } = require("./media/mediaDetector");

/** Entrantes de chat: Wasender puede mandar `messages.received` o `messages-personal.received` (misma lógica). */
function isInboundMessagesJob(eventType, normalized) {
  if (normalized && normalized.type === "reaction") return false;
  const e = String(eventType || "").trim().toLowerCase();
  return (
    e === "messages.received" ||
    e === "messages-personal.received" ||
    e === "message.received"
  );
}

/** Media inbound: mismo mensaje puede venir como personal o canónico — tratar igual. */
function isCanonicalInboundForMedia(eventType, originalEv) {
  if (String(eventType || "").trim().toLowerCase() !== "messages.received") return false;
  const o = String(originalEv || "").trim().toLowerCase();
  return (
    o === "messages.received" ||
    o === "messages-personal.received" ||
    o === "message.received"
  );
}

async function runProcessor(eventType, normalized) {
  const mod = processors[eventType];
  if (!mod || typeof mod.handle !== "function") {
    return;
  }
  await mod.handle(normalized);
}

/**
 * Procesa el body del webhook tras responder 200 al proveedor.
 * @param {object} body
 */
async function routeWebhook(body) {
  const jobs = parseWebhookJobs(body);
  logger.info(
    { rawEvent: body && body.event, jobCount: jobs.length, jobs: jobs.map(j => ({ eventType: j.eventType, fromPhone: j.normalized && j.normalized.fromPhone, messageId: j.normalized && j.normalized.messageId, type: j.normalized && j.normalized.type })) },
    "whatsapp_hub_route"
  );
  let firstInbound = null;

  for (const job of jobs) {
    const eventType = job.eventType || "messages.received";
    const normalized = { ...(job.normalized || {}), eventType };

    if (isInboundMessagesJob(eventType, normalized)) {
      if (!firstInbound && normalized.fromPhone) {
        firstInbound = normalized;
      }
    }

    try {
      await runProcessor(eventType, normalized);
      // Media entrante: entrantes canónicos y `messages-personal.received` se tratan igual;
      // messages.upsert puede duplicar el mismo mensaje → evitar triple proceso con originalEv.
      const originalEv = normalized.__originalEvent || eventType;
      const isCanonicalReceived = isCanonicalInboundForMedia(eventType, originalEv);
      const hasMediaByType = MEDIA_TYPES.has(normalized.type);
      const hasMediaInRawPayload = !!detectMedia(extractRawMessage(normalized));
      if (isCanonicalReceived && (hasMediaByType || hasMediaInRawPayload)) {
        setImmediate(() => {
          mediaProcessor.handle(normalized).catch((err) => {
            logger.error({ err, eventType }, "media_processor_error");
          });
        });
      }
    } catch (err) {
      logger.error({ err, eventType }, "whatsapp_hub_processor_error");
      try {
        const { pool } = require("../../db");
        await pool.query(
          `INSERT INTO crm_system_events (event_type, payload, is_critical)
           VALUES ($1, $2::jsonb, TRUE)`,
          [
            `processor_error:${eventType}`,
            JSON.stringify({
              message: err && err.message,
              stack: process.env.NODE_ENV !== "production" && err && err.stack,
            }),
          ]
        );
      } catch (_e) {
        /* ignore */
      }
    }
  }

  // Tipo H onboarding: no crear customers automáticamente desde el router.
  // La creación se controla exclusivamente en processors/messages.js cuando el estado AWAITING_NAME
  // recibe un nombre válido.
}

module.exports = { routeWebhook, routeWebhookJobs: parseWebhookJobs };
