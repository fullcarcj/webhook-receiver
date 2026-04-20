"use strict";

const pino = require("pino");
const { pool } = require("../../../db");
const { upsertChat } = require("./_shared");
const { normalizePhone } = require("../../utils/phoneNormalizer");

const sentLog = pino({ level: process.env.LOG_LEVEL || "info", name: "whatsapp_sent" });
const { applyOutboundOmnichannelHook } = require("../../services/omnichannelOutboundHook");

async function handle(normalized) {
  const phone = normalized.toPhone || normalized.fromPhone;
  if (!phone || !normalized.messageId) return;

  const normalizedPhone = normalizePhone(phone);
  const digits = (normalizedPhone || String(phone)).replace(/\D/g, "");
  if (!digits) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Solo registrar mensaje saliente si el cliente ya existe en customers.
    // NO crear clientes con placeholder "Cliente WhatsApp" desde eventos messages.sent.
    const { rows } = await client.query(
      `SELECT c.id AS customer_id
       FROM customers c
       WHERE NULLIF(TRIM(c.phone), '') IS NOT NULL
         AND REGEXP_REPLACE(c.phone, '\\D', '', 'g') = $1
       UNION
       SELECT ci.customer_id
       FROM crm_customer_identities ci
       WHERE ci.external_id = $1
         AND ci.source IN ('whatsapp'::crm_identity_source, 'mostrador'::crm_identity_source)
       LIMIT 1`,
      [digits]
    );

    if (!rows.length) {
      // Cliente aún no registrado (espera onboarding Tipo H). No crear placeholder.
      sentLog.info({ phone, digits, messageId: normalized.messageId }, "sent: cliente no encontrado, skip (onboarding pendiente)");
      await client.query("ROLLBACK");
      return;
    }

    const customerId = Number(rows[0].customer_id);
    const lastAt = new Date((normalized.timestamp || Math.floor(Date.now() / 1000)) * 1000);
    const preview = normalized.content?.text ? String(normalized.content.text).slice(0, 200) : "";

    const chatRow = await upsertChat(client, {
      customerId,
      phone,
      lastMessageAt: lastAt,
      lastMessageText: preview,
      lastMessageType: normalized.type || "text",
    });

    const ins = await client.query(
      `INSERT INTO crm_messages
         (chat_id, customer_id, external_message_id, direction, type, content, sent_by, created_at)
       VALUES ($1, $2, $3, 'outbound', $4, $5::jsonb, $6, NOW())
       ON CONFLICT (external_message_id) DO NOTHING
       RETURNING id`,
      [
        chatRow.id,
        customerId,
        normalized.messageId,
        normalized.type || "text",
        JSON.stringify(normalized.content || {}),
        normalized.sentBy || "agent",
      ]
    );

    await client.query("COMMIT");
    if (ins.rows.length) {
      await applyOutboundOmnichannelHook(pool, chatRow.id);
    }
    sentLog.info({ phone, customerId, messageId: normalized.messageId }, "sent: mensaje saliente guardado");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { handle };
