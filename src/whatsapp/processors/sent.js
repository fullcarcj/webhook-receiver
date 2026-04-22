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

    // Dedup: chatMessageService.js guarda el mensaje con un UUID temporal ("out-<uuid>")
    // porque obtiene el ID de Wasender de la respuesta API. Cuando llega el webhook
    // messages.sent, intentamos unificar ambas filas actualizando el external_message_id
    // en lugar de insertar un duplicado.
    const textBody = normalized.content?.text ? String(normalized.content.text) : null;
    const webhookMsgId = String(normalized.messageId);
    let didUpdate = false;
    let didSkip = false;

    const alreadyId = await client.query(
      `SELECT id FROM crm_messages WHERE chat_id = $1 AND external_message_id = $2 LIMIT 1`,
      [chatRow.id, webhookMsgId]
    );
    if (alreadyId.rows.length) {
      didSkip = true;
    }

    if (!didSkip && textBody) {
      const existing = await client.query(
        `SELECT id FROM crm_messages
         WHERE chat_id        = $1
           AND direction      = 'outbound'
           AND external_message_id LIKE 'out-%'
           AND content::jsonb->>'text' = $2
           AND created_at    >= NOW() - INTERVAL '5 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        [chatRow.id, textBody]
      );
      if (existing.rows.length) {
        await client.query(
          `UPDATE crm_messages SET external_message_id = $1 WHERE id = $2`,
          [webhookMsgId, existing.rows[0].id]
        );
        didUpdate = true;
      } else {
        // sendChatMessage ya insertó la fila con el id devuelto por la API; el webhook
        // suele traer otro id o el mismo en otro formato → sin esto se duplica en el chat.
        const dupe = await client.query(
          `SELECT id FROM crm_messages
           WHERE chat_id = $1
             AND direction = 'outbound'
             AND content::jsonb->>'text' = $2
             AND created_at BETWEEN ($4::timestamptz - INTERVAL '3 minutes')
                                AND ($4::timestamptz + INTERVAL '3 minutes')
             AND (external_message_id IS NULL OR external_message_id IS DISTINCT FROM $3::text)
           ORDER BY created_at DESC
           LIMIT 1`,
          [chatRow.id, textBody, webhookMsgId, lastAt]
        );
        if (dupe.rows.length) {
          didSkip = true;
          sentLog.info(
            { chatId: chatRow.id, messageId: webhookMsgId },
            "sent: omitido insert duplicado (mismo texto que fila reciente desde API)"
          );
        }
      }
    } else if (!didSkip && !textBody) {
      // Wasender a veces manda messages.sent sin cuerpo útil; si solo hay un outbound
      // pendiente out-* reciente, enlazar el msgId del webhook (evita duplicado vs bandeja).
      const pendingOut = await client.query(
        `SELECT id FROM crm_messages
         WHERE chat_id = $1
           AND direction = 'outbound'
           AND external_message_id LIKE 'out-%'
           AND created_at >= NOW() - INTERVAL '5 minutes'`,
        [chatRow.id]
      );
      if (pendingOut.rows.length === 1) {
        await client.query(
          `UPDATE crm_messages SET external_message_id = $1 WHERE id = $2`,
          [webhookMsgId, pendingOut.rows[0].id]
        );
        didUpdate = true;
      }
    }

    let ins = { rows: [] };
    if (!didUpdate && !didSkip) {
      ins = await client.query(
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
    }

    await client.query("COMMIT");
    if (didUpdate || ins.rows.length) {
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
