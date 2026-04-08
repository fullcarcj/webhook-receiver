"use strict";

const { pool } = require("../../../db");
const { resolveCustomerId, upsertChat } = require("./_shared");

async function handle(normalized) {
  const phone = normalized.toPhone || normalized.fromPhone;
  if (!phone || !normalized.messageId) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { customerId } = await resolveCustomerId(client, phone);
    const lastAt = new Date((normalized.timestamp || Math.floor(Date.now() / 1000)) * 1000);
    const preview = normalized.content?.text ? String(normalized.content.text).slice(0, 200) : "";

    const chatRow = await upsertChat(client, {
      customerId,
      phone,
      lastMessageAt: lastAt,
      lastMessageText: preview,
      lastMessageType: normalized.type || "text",
    });

    await client.query(
      `INSERT INTO crm_messages
         (chat_id, customer_id, external_message_id, direction, type, content, sent_by, created_at)
       VALUES ($1, $2, $3, 'outbound', $4, $5::jsonb, $6, NOW())
       ON CONFLICT (external_message_id) DO NOTHING`,
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
