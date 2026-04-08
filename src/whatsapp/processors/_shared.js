"use strict";

const { pool } = require("../../../db");
const { normalizePhone } = require("../../utils/phoneNormalizer");
const { resolveCustomer } = require("../../services/resolveCustomer");

function normalizePhoneDigits(raw) {
  return normalizePhone(raw);
}

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 */
async function resolveCustomerId(db, phoneRaw) {
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    const e = new Error("phone inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const r = await resolveCustomer(
    {
      source: "whatsapp",
      external_id: phone,
      data: { phone: phoneRaw },
    },
    { client: db }
  );
  return Number(r.customerId);
}

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 */
async function upsertChat(db, { customerId, phone, lastMessageAt, lastMessageText, lastMessageType }) {
  const p = normalizePhone(phone);
  if (!p) {
    const e = new Error("phone inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const { rows } = await db.query(
    `INSERT INTO crm_chats
       (customer_id, phone, last_message_at, last_message_text, last_message_type, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       customer_id       = COALESCE(EXCLUDED.customer_id, crm_chats.customer_id),
       last_message_at   = EXCLUDED.last_message_at,
       last_message_text = EXCLUDED.last_message_text,
       last_message_type = EXCLUDED.last_message_type,
       updated_at        = NOW()
     RETURNING id`,
    [customerId, p, lastMessageAt, lastMessageText, lastMessageType || "text"]
  );
  return rows[0];
}

module.exports = { resolveCustomerId, upsertChat, normalizePhoneDigits };
