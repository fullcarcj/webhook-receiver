"use strict";

const { pool } = require("../../../db");

function normalizePhoneDigits(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return d || null;
}

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 */
async function resolveCustomerId(db, phoneRaw) {
  const phone = normalizePhoneDigits(phoneRaw);
  if (!phone) {
    const e = new Error("phone inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rows } = await db.query(
    `SELECT customer_id FROM crm_customer_identities
     WHERE source = 'whatsapp'::crm_identity_source AND external_id = $1
     LIMIT 1`,
    [phone]
  );
  if (rows.length) return Number(rows[0].customer_id);

  const { rows: nc } = await db.query(
    `INSERT INTO customers (company_id, full_name, crm_status, phone, created_at, updated_at)
     VALUES (1, $1, 'draft', $2, NOW(), NOW())
     RETURNING id`,
    [`WA-${phone}`, phone]
  );
  const newId = nc[0].id;

  await db.query(
    `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary)
     VALUES ($1, 'whatsapp'::crm_identity_source, $2, TRUE)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [newId, phone]
  );

  const { rows: again } = await db.query(
    `SELECT customer_id FROM crm_customer_identities
     WHERE source = 'whatsapp'::crm_identity_source AND external_id = $1 LIMIT 1`,
    [phone]
  );
  return Number(again[0].customer_id);
}

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 */
async function upsertChat(db, { customerId, phone, lastMessageAt, lastMessageText, lastMessageType }) {
  const p = normalizePhoneDigits(phone);
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
