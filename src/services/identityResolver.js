"use strict";

const { pool } = require("../../db");
const { expandPhoneMatchKeys, normalizePhone } = require("../utils/phoneNormalizer");

/** Alineado a consultas manuales: `COALESCE(is_active, true)`. */
const CUST_ACTIVE = `(COALESCE(c.is_active, TRUE) = TRUE)`;

/**
 * Orígenes tratados como WhatsApp para la resolución por teléfono del remitente.
 * Hilos ML explícitos quedan fuera: allí la identidad sigue por `ml_buyer_id` u otras reglas.
 */
function isWhatsappChatSource(sourceType) {
  const s = sourceType == null ? "" : String(sourceType).trim().toLowerCase();
  if (s === "ml_message" || s === "ml_question") return false;
  return s === "" || s === "wa_inbound" || s === "wa_ml_linked";
}

/**
 * Un solo `customers.id` si hay match único por `phone`, o si no hay en principal por `phone_2`.
 * @param {import("pg").Pool|import("pg").PoolClient} poolConn
 * @param {string[]} matchKeys
 * @returns {Promise<number|null>}
 */
async function findUniqueCustomerIdByPhoneKeys(poolConn, matchKeys) {
  if (!Array.isArray(matchKeys) || !matchKeys.length) return null;
  try {
    const { rows: pr } = await poolConn.query(
      `SELECT c.id FROM customers c
       WHERE ${CUST_ACTIVE}
         AND NULLIF(TRIM(COALESCE(c.phone, '')), '') <> ''
         AND REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = ANY($1::text[])
       ORDER BY c.total_orders DESC NULLS LAST
       LIMIT 2`,
      [matchKeys]
    );
    if (pr.length === 1) return Number(pr[0].id);
    if (pr.length > 1) return null;
    const { rows: sec } = await poolConn.query(
      `SELECT c.id FROM customers c
       WHERE ${CUST_ACTIVE}
         AND NULLIF(TRIM(COALESCE(c.phone_2, '')), '') <> ''
         AND REGEXP_REPLACE(COALESCE(c.phone_2, ''), '\\D', '', 'g') = ANY($1::text[])
       ORDER BY c.total_orders DESC NULLS LAST
       LIMIT 2`,
      [matchKeys]
    );
    if (sec.length === 1) return Number(sec[0].id);
  } catch (_e) {
    return null;
  }
  return null;
}

/**
 * Resuelve cliente único por `crm_chats.phone` y orígenes WA (p. ej. GET /context sin nuevo mensaje).
 * @param {import("pg").Pool|import("pg").PoolClient} poolConn
 * @param {string|null|undefined} chatPhoneRaw
 * @param {string|null|undefined} sourceType
 * @returns {Promise<number|null>}
 */
async function findUniqueCustomerByPhoneForWaChat(poolConn, chatPhoneRaw, sourceType) {
  if (!isWhatsappChatSource(sourceType)) return null;
  const norm = normalizePhone(chatPhoneRaw) || String(chatPhoneRaw || "").replace(/\D/g, "");
  const keys = expandPhoneMatchKeys(norm);
  if (!keys.length) return null;
  return findUniqueCustomerIdByPhoneKeys(poolConn, keys);
}

/**
 * Vincula el chat al cliente por coincidencia única de teléfono (WhatsApp).
 * Solo si hay exactamente un `customers` activo; si hay varios, no auto-enlaza.
 */
async function tryAutoLinkCustomerByWaPhone(chatId, customerId, digits) {
  const cid = Number(chatId);
  const custId = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(custId) || custId <= 0) return;
  const ext = digits && String(digits).replace(/\D/g, "").length > 0 ? String(digits).replace(/\D/g, "") : String(cid);
  const metadata = JSON.stringify({ auto_phone_match: true, chat_id: cid });
  await pool.query(
    `UPDATE crm_chats SET
       customer_id = $1,
       identity_status = 'auto_matched',
       identity_candidates = NULL,
       updated_at = NOW()
     WHERE id = $2
       AND customer_id IS NULL
       AND identity_status <> 'manual_linked'`,
    [custId, cid]
  );
  try {
    await pool.query(
      `INSERT INTO crm_customer_identities (customer_id, source, external_id, is_primary, metadata)
       VALUES ($1, 'whatsapp'::crm_identity_source, $2, false, $3::jsonb)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [custId, ext, metadata]
    );
  } catch (_e) {
    /* tabla/enum opcional en entornos viejos */
  }
}

/**
 * Post-commit: sugiere candidatos de identidad sin bloquear la TX del webhook.
 * Usa `pool` (no el client de la transacción de mensajes).
 *
 * **WhatsApp, chat sin `customer_id`:** el número del remitente (ya pasado por
 * `normalizePhone` en el procesador) se compara solo en dígitos con `customers.phone`;
 * si no hay coincidencias, se consulta `customers.phone_2` con el mismo criterio.
 * Si hay **exactamente un** cliente activo en ese paso, se vincula (`customer_id`,
 * `identity_status = auto_matched`). Si hay 0 o varios, se guardan candidatos en
 * `identity_candidates` como antes.
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

  if (!hasCustomer && digits && isWhatsappChatSource(chat.source_type)) {
    const matchKeys = expandPhoneMatchKeys(digits);
    if (matchKeys.length) {
      const uniqueId = await findUniqueCustomerIdByPhoneKeys(pool, matchKeys);
      if (uniqueId != null) {
        await tryAutoLinkCustomerByWaPhone(cid, uniqueId, digits);
        return;
      }

      const baseSelect = `SELECT c.id, c.full_name, c.phone, c.crm_status, c.total_orders, c.total_spent_usd
       FROM customers c
       WHERE ${CUST_ACTIVE}`;

      const { rows: byPrimary } = await pool.query(
        `${baseSelect}
         AND NULLIF(TRIM(COALESCE(c.phone, '')), '') <> ''
         AND REGEXP_REPLACE(COALESCE(c.phone, ''), '\\D', '', 'g') = ANY($1::text[])
       ORDER BY c.total_orders DESC NULLS LAST
       LIMIT 3`,
        [matchKeys]
      );

      if (byPrimary.length > 1) {
        candidates.phoneMatches = byPrimary;
      } else if (byPrimary.length === 0) {
        const { rows: bySecondary } = await pool.query(
          `${baseSelect}
           AND NULLIF(TRIM(COALESCE(c.phone_2, '')), '') <> ''
           AND REGEXP_REPLACE(COALESCE(c.phone_2, ''), '\\D', '', 'g') = ANY($1::text[])
         ORDER BY c.total_orders DESC NULLS LAST
         LIMIT 3`,
          [matchKeys]
        );
        candidates.phoneMatches = bySecondary;
      } else {
        candidates.phoneMatches = byPrimary;
      }
    }
  }

  if (chat.ml_buyer_id != null) {
    const { rows: mlRows } = await pool.query(
      `SELECT c.id, c.full_name, c.phone, cmb.is_primary,
              c.total_orders, c.total_spent_usd
       FROM customer_ml_buyers cmb
       JOIN customers c ON c.id = cmb.customer_id
       WHERE cmb.ml_buyer_id = $1
         AND ${CUST_ACTIVE}
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

module.exports = {
  resolveIdentity,
  findUniqueCustomerByPhoneForWaChat,
  tryAutoLinkCustomerByWaPhone,
};
