"use strict";

const { pool } = require("../../../db");
const { normalizePhone } = require("../../utils/phoneNormalizer");
const { resolveCustomer } = require("../../services/resolveCustomer");

function normalizePhoneDigits(raw) {
  return normalizePhone(raw);
}

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {object} [extraData] — p. ej. `{ name: "Nombre Apellido" }` para enriquecer CRM y match ML tipo E
 */
async function resolveCustomerId(db, phoneRaw, extraData = {}) {
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
      data: { phone: phoneRaw, ...extraData },
    },
    { client: db }
  );
  return {
    customerId: Number(r.customerId),
    waMlBuyerTipoECheck: r.waMlBuyerTipoECheck || null,
  };
}

/**
 * @param {import("pg").Pool|import("pg").PoolClient} db
 * @param {{ customerId, phone, lastMessageAt, lastMessageText, lastMessageType, isOperational? }} opts
 */
async function upsertChat(db, { customerId, phone, lastMessageAt, lastMessageText, lastMessageType, isOperational }) {
  const p = normalizePhone(phone);
  if (!p) {
    const e = new Error("phone inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  // is_operational solo se actualiza a TRUE cuando el flag se pasa explícitamente;
  // no se sobreescribe a FALSE para no deshacer marcas previas del whitelist.
  const opClause = isOperational ? ", is_operational = TRUE" : "";
  const { rows } = await db.query(
    `INSERT INTO crm_chats
       (customer_id, phone, last_message_at, last_message_text, last_message_type,
        is_operational, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       customer_id       = COALESCE(EXCLUDED.customer_id, crm_chats.customer_id),
       last_message_at   = EXCLUDED.last_message_at,
       last_message_text = EXCLUDED.last_message_text,
       last_message_type = EXCLUDED.last_message_type${opClause},
       updated_at        = NOW()
     RETURNING id`,
    [customerId, p, lastMessageAt, lastMessageText, lastMessageType || "text", Boolean(isOperational)]
  );
  return rows[0];
}

module.exports = { resolveCustomerId, upsertChat, normalizePhoneDigits };
