"use strict";

const { pool } = require("../../db");

/**
 * Post-commit: sugiere candidatos de identidad sin bloquear la TX del webhook.
 * Usa `pool` (no el client de la transacción de mensajes).
 *
 * @param {number|string} chatId
 * @param {string|null|undefined} phone — preferir salida de normalizePhone (E.164)
 * @param {string|null|undefined} messageText
 */
async function resolveIdentity(chatId, phone, messageText) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid) || cid <= 0) return;

  const { rows } = await pool.query(
    `SELECT identity_status, customer_id, ml_buyer_id, source_type
     FROM crm_chats WHERE id = $1`,
    [cid]
  );
  const chat = rows[0];
  if (!chat) return;

  if (chat.identity_status === "manual_linked") return;

  const hasCustomer = chat.customer_id != null;

  const candidates = {
    phoneMatches: [],
    mlBuyerMatches: [],
    keywordHint: false,
  };

  const digits = phone ? String(phone).replace(/\D/g, "") : "";

  if (!hasCustomer && digits) {
    const { rows: phoneRows } = await pool.query(
      `SELECT id, full_name, phone, crm_status, total_orders, total_spent_usd
       FROM customers
       WHERE is_active = true
         AND (
           REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $1
           OR REGEXP_REPLACE(COALESCE(phone_2, ''), '\\D', '', 'g') = $1
           OR REGEXP_REPLACE(COALESCE(alternative_phone, ''), '\\D', '', 'g') = $1
         )
       ORDER BY total_orders DESC NULLS LAST
       LIMIT 3`,
      [digits]
    );
    candidates.phoneMatches = phoneRows;
  }

  if (chat.ml_buyer_id != null) {
    const { rows: mlRows } = await pool.query(
      `SELECT c.id, c.full_name, c.phone, cmb.is_primary,
              c.total_orders, c.total_spent_usd
       FROM customer_ml_buyers cmb
       JOIN customers c ON c.id = cmb.customer_id
       WHERE cmb.ml_buyer_id = $1
         AND c.is_active = true
       ORDER BY cmb.is_primary DESC, c.total_orders DESC NULLS LAST
       LIMIT 3`,
      [chat.ml_buyer_id]
    );
    candidates.mlBuyerMatches = mlRows;
  }

  const keywords = [
    "mercadolibre",
    "mercado libre",
    "compré en ml",
    "pedido ml",
    "orden ml",
  ];
  const lowerText = (messageText || "").toLowerCase();
  const hasKeyword = keywords.some((k) => lowerText.includes(k));
  if (hasKeyword) {
    candidates.keywordHint = true;
    if (chat.identity_status === "unknown") {
      await pool.query(
        `UPDATE crm_chats SET identity_status = 'declared' WHERE id = $1`,
        [cid]
      );
    }
  }

  const hasCandidates =
    candidates.phoneMatches.length > 0 ||
    candidates.mlBuyerMatches.length > 0 ||
    candidates.keywordHint;

  if (hasCandidates) {
    await pool.query(`UPDATE crm_chats SET identity_candidates = $1::jsonb WHERE id = $2`, [
      candidates,
      cid,
    ]);
  }
}

module.exports = { resolveIdentity };
