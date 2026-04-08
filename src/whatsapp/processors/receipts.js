"use strict";

const { pool } = require("../../../db");

async function handle(normalized) {
  if (!normalized.messageId) return;
  const st =
    normalized.receiptStatus ||
    (normalized.rawPayload && normalized.rawPayload.status) ||
    "";
  const s = String(st).toLowerCase();
  if (s !== "read") {
    return;
  }
  await pool.query(
    `UPDATE crm_messages
     SET is_read = TRUE, read_at = NOW()
     WHERE external_message_id = $1 AND direction = 'outbound'`,
    [normalized.messageId]
  );
}

module.exports = { handle };
