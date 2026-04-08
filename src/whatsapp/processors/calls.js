"use strict";

const { pool } = require("../../../db");

async function handle(normalized) {
  const ev = normalized.eventType || "calls.event";
  await pool.query(
    `INSERT INTO crm_system_events (event_type, payload, is_critical)
     VALUES ($1, $2::jsonb, FALSE)`,
    [ev, JSON.stringify(normalized.rawPayload != null ? normalized.rawPayload : normalized)]
  );
}

module.exports = { handle };
