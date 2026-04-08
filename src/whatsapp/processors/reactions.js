"use strict";

const { pool } = require("../../../db");

async function handle(normalized) {
  if (!normalized.messageId) return;
  const { rows } = await pool.query(
    `SELECT chat_id, customer_id FROM crm_messages WHERE external_message_id = $1 LIMIT 1`,
    [normalized.messageId]
  );
  if (!rows.length) return;

  const extId = `reaction-${normalized.messageId}-${Date.now()}`;
  await pool.query(
    `INSERT INTO crm_messages
       (chat_id, customer_id, external_message_id, direction, type, content, created_at)
     VALUES ($1, $2, $3, 'inbound', 'reaction', $4::jsonb, NOW())`,
    [
      rows[0].chat_id,
      rows[0].customer_id,
      extId,
      JSON.stringify({
        reaction: normalized.content?.reaction || null,
        reactionTo: normalized.messageId,
      }),
    ]
  );
}

module.exports = { handle };
