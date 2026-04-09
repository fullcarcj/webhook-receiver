"use strict";

const { pool } = require("../../../db");
const { normalizePhoneDigits } = require("./_shared");
const { emitWaSessionStatus } = require("../../services/sseService");

async function handle(normalized) {
  const st = String(normalized.sessionStatus || "").toLowerCase();
  const bad = ["close", "closed", "disconnected", "logout", "logged_out", "unpaired"];
  const ok = !bad.some((b) => st.includes(b));

  const phone = normalizePhoneDigits(normalized.fromPhone);
  if (phone) {
    await pool.query(
      `UPDATE crm_chats SET wa_session_ok = $1, updated_at = NOW() WHERE phone = $2`,
      [ok, phone]
    );
  }

  await pool.query(
    `INSERT INTO crm_system_events (event_type, payload, is_critical)
     VALUES ($1, $2::jsonb, $3)`,
    [
      "session.status",
      JSON.stringify({
        sessionStatus: normalized.sessionStatus,
        phone,
        raw: normalized.rawPayload || null,
      }),
      !ok,
    ]
  );

  // Notificar frontend en tiempo real
  emitWaSessionStatus({
    status:     normalized.sessionStatus || st,
    isCritical: !ok,
  });
}

module.exports = { handle };
