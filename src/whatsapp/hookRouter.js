"use strict";

const pino = require("pino");
const { parseWebhookJobs } = require("./payloadParser");
const { findOrCreateCustomer } = require("../services/crmIdentityService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "whatsapp_hub",
});

const processors = {
  "messages.received": require("./processors/messages"),
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
  let firstInbound = null;

  for (const job of jobs) {
    const eventType = job.eventType || "messages.received";
    const normalized = { ...(job.normalized || {}), eventType };

    if (eventType === "messages.received" && normalized.type !== "reaction") {
      if (!firstInbound && normalized.fromPhone) {
        firstInbound = normalized;
      }
    }

    try {
      await runProcessor(eventType, normalized);
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

  if (firstInbound && firstInbound.fromPhone) {
    try {
      await findOrCreateCustomer({
        phoneNumber: firstInbound.fromPhone,
        fullName: firstInbound.contactName || null,
        messageId: firstInbound.messageId || `hub-${Date.now()}`,
        rawPayload: body,
        fuzzyThreshold: 0.35,
      });
    } catch (err) {
      logger.warn({ err }, "whatsapp_hub_find_or_create_customer");
    }
  }
}

module.exports = { routeWebhook, routeWebhookJobs: parseWebhookJobs };
