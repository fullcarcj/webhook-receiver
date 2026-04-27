"use strict";

/**
 * Ferrari ERP — crmService.js
 *
 * Servicio CRM: customers + customer_ml_buyers + wallet.
 * REGLA ABSOLUTA: nunca SELECT/INSERT/UPDATE/DELETE en ml_buyers.
 * Solo lectura de ml_buyers para findOrCreateFromBuyer y la migración.
 *
 * Prerrequisitos BD:
 *   sql/customer-wallet.sql  (customers, customer_ml_buyers,
 *                             customer_wallets, wallet_transactions)
 *   sql/crm-customers.sql    (columnas CRM, v_customers_full, migrate fn)
 */

const { pool } = require("../../db");
const { normalizePhone } = require("../utils/phoneNormalizer");
const { mergeCustomers } = require("./customerMergeService");

/** Valores permitidos por `chk_id_type` en customers (customer-wallet.sql). */
const ALLOWED_CUSTOMER_ID_TYPES = new Set(["V", "E", "J", "G", "P"]);

/**
 * Valor para columnas `customers.phone` / `phone_2` (CHECK chk_phone_format: solo dígitos, 7–15).
 * Quita espacios, +, guiones, etc. Aplica `normalizePhone` (VE por defecto) cuando aplica;
 * si no, acepta el literal de 7–15 dígitos.
 */
function normalizePhoneForCustomersTable(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const viaNorm = normalizePhone(s);
  if (viaNorm) return viaNorm;
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length < 7 || digits.length > 15) {
    const e = new Error(
      "Teléfono inválido: debe quedar entre 7 y 15 dígitos (sin letras). " +
        "Puede incluir +, espacios o guiones; se guardan solo los números."
    );
    e.code = "BAD_REQUEST";
    throw e;
  }
  return digits;
}

/** Coherente con chk_id_type: null o una letra V/E/J/G/P. */
function normalizeIdTypeForCustomer(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const t = String(raw).trim().toUpperCase();
  if (!t) return null;
  if (!ALLOWED_CUSTOMER_ID_TYPES.has(t)) {
    const e = new Error(
      "Tipo de documento inválido. Elija V, E, J, G o P, o deje el tipo en blanco."
    );
    e.code = "BAD_REQUEST";
    throw e;
  }
  return t;
}

// ─── tx_type válidos expuestos por la API CRM ──────────────────────────────
// Subconjunto del ENUM wallet_tx_type que tiene sentido para el CRM.
// Se mapean a los valores EXACTOS del ENUM en wallet_transactions.
const CRM_TX_TYPES = {
  CREDIT_RMA:     "CREDIT_RMA",
  CREDIT_MANUAL:  "CREDIT_ADJUSTMENT",  // alias amigable
  CREDIT_RETURN:  "CREDIT_RETURN",
  DEBIT_SALE:     "DEBIT_PURCHASE",     // alias amigable
  DEBIT_MANUAL:   "DEBIT_ADJUSTMENT",   // alias amigable
  DEBIT_ADJUST:   "DEBIT_ADJUSTMENT",
};
const VALID_CRM_TX_TYPES = Object.keys(CRM_TX_TYPES);

function mapCrmTxType(input) {
  const t = String(input || "").toUpperCase().trim();
  return CRM_TX_TYPES[t] || null;
}

function mapCrmError(err) {
  const msg = err && err.message ? String(err.message) : "";
  if (err && (err.code === "42P01" || err.code === "42P04")) {
    const e = new Error("crm_schema_missing");
    e.code = "CRM_SCHEMA_MISSING";
    e.cause = err;
    return e;
  }
  if (msg.includes("Balance negativo")) {
    const e = new Error("negative_balance");
    e.code = "NEGATIVE_BALANCE";
    e.cause = err;
    return e;
  }
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// findOrCreateFromBuyer(mlBuyerId)
//
// Busca el customer vinculado a este buyer de ML.
// Si no existe → crea customer + link automáticamente.
// Retorna { customer, created: bool }.
//
// Solo lee ml_buyers — nunca escribe en ella.
// ─────────────────────────────────────────────────────────────────────────────
async function findOrCreateFromBuyer(mlBuyerId) {
  const bid = Number(mlBuyerId);
  if (!Number.isFinite(bid) || bid <= 0) {
    const e = new Error("ml_buyer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  try {
    // 1. ¿Ya tiene customer vinculado?
    const { rows: [linked] } = await pool.query(
      `SELECT c.*
       FROM customers c
       JOIN customer_ml_buyers cmb ON cmb.customer_id = c.id
       WHERE cmb.ml_buyer_id = $1
       LIMIT 1`,
      [bid]
    );
    if (linked) return { customer: linked, created: false };

    // 2. Leer datos del buyer (solo lectura — no escribe)
    const { rows: [buyer] } = await pool.query(
      `SELECT buyer_id, nickname, nombre_apellido, phone_1
       FROM ml_buyers WHERE buyer_id = $1`,
      [bid]
    );
    if (!buyer) {
      const e = new Error(`ml_buyer_id ${bid} no existe en ml_buyers`);
      e.code = "NOT_FOUND";
      throw e;
    }

    // 3. ¿Existe customer con primary_ml_buyer_id?
    const { rows: [byPrimary] } = await pool.query(
      `SELECT * FROM customers WHERE primary_ml_buyer_id = $1 LIMIT 1`,
      [bid]
    );
    if (byPrimary) {
      // Solo vincular si faltaba el link
      await pool.query(
        `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
         VALUES ($1, $2, TRUE)
         ON CONFLICT DO NOTHING`,
        [byPrimary.id, bid]
      );
      return { customer: byPrimary, created: false };
    }

    // 4. Crear customer nuevo
    const fullName =
      (buyer.nombre_apellido && buyer.nombre_apellido.trim()) ||
      buyer.nickname ||
      `Comprador ML ${bid}`;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: [newCust] } = await client.query(
        `INSERT INTO customers
           (full_name, phone, primary_ml_buyer_id, customer_type)
         VALUES ($1, $2, $3, 'RETAIL')
         RETURNING *`,
        [fullName, buyer.phone_1 || null, bid]
      );

      await client.query(
        `INSERT INTO customer_ml_buyers
           (customer_id, ml_buyer_id, is_primary)
         VALUES ($1, $2, TRUE)
         ON CONFLICT DO NOTHING`,
        [newCust.id, bid]
      );

      await client.query("COMMIT");
      return { customer: newCust, created: true };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === "BAD_REQUEST" || err.code === "NOT_FOUND") throw err;
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getCustomer(customerId)
// ─────────────────────────────────────────────────────────────────────────────
async function getCustomer(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
        (SELECT COUNT(*)::int FROM customer_ml_buyers cmb WHERE cmb.customer_id = c.id) AS ml_accounts_count,
        COALESCE(
          (SELECT cw.balance FROM customer_wallets cw
           WHERE cw.customer_id = c.id AND cw.currency = 'USD' LIMIT 1),
          0
        ) AS wallet_balance_usd
       FROM customers c
       WHERE c.id = $1`,
      [id]
    );
    return rows[0] || null;
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// searchCustomers({ q, customerType, isActive, limit, offset })
// ─────────────────────────────────────────────────────────────────────────────
async function searchCustomers({ q, customerType, isActive, limit, offset } = {}) {
  const lim  = Math.min(Math.max(Number(limit)  || 50,  1), 200);
  const off  = Math.max(Number(offset) || 0, 0);
  const params = [1]; // $1 = company_id
  const clauses = ["c.company_id = $1"];

  if (q && String(q).trim().length >= 2) {
    params.push(`%${String(q).trim()}%`);
    const p = params.length;
    clauses.push(
      `(c.full_name  ILIKE $${p}
        OR c.phone    ILIKE $${p}
        OR c.email    ILIKE $${p}
        OR c.id_number ILIKE $${p})`
    );
  }
  if (customerType) {
    params.push(String(customerType).toUpperCase());
    clauses.push(`c.customer_type = $${params.length}`);
  }
  if (isActive !== undefined && isActive !== null) {
    params.push(isActive === true || isActive === "true" || isActive === "1");
    clauses.push(`c.is_active = $${params.length}`);
  }

  const where = clauses.join(" AND ");

  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              COALESCE(cw.balance, 0) AS wallet_balance_usd,
              COUNT(cmb.ml_buyer_id)  AS ml_accounts_count
       FROM customers c
       LEFT JOIN customer_wallets   cw  ON cw.customer_id = c.id AND cw.currency = 'USD'
       LEFT JOIN customer_ml_buyers cmb ON cmb.customer_id = c.id
       WHERE ${where}
       GROUP BY c.id, cw.balance
       ORDER BY c.total_spent_usd DESC NULLS LAST
       LIMIT $${params.length + 1}
       OFFSET $${params.length + 2}`,
      [...params, lim, off]
    );

    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) AS total
       FROM customers c
       WHERE ${where}`,
      params
    );

    return { customers: rows, total: Number(cnt[0].total), limit: lim, offset: off };
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createCustomer({ fullName, idType, idNumber, email, phone,
//                  address, city, customerType, notes, tags })
// ─────────────────────────────────────────────────────────────────────────────
async function createCustomer(body) {
  const fullName = String(body.full_name || body.fullName || "").trim();
  if (!fullName) {
    const e = new Error("full_name es obligatorio");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const customerType = String(body.customer_type || body.customerType || "RETAIL").toUpperCase();
  const VALID_TYPES = ["RETAIL", "WHOLESALE", "WORKSHOP", "DEALER"];
  if (!VALID_TYPES.includes(customerType)) {
    const e = new Error(`customer_type debe ser uno de: ${VALID_TYPES.join("|")}`);
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const idTypeIns =
      body.id_type !== undefined && body.id_type !== null && String(body.id_type).trim() !== ""
        ? normalizeIdTypeForCustomer(body.id_type)
        : null;
    const phoneIns =
      body.phone !== undefined && body.phone !== null && String(body.phone).trim() !== ""
        ? normalizePhoneForCustomersTable(body.phone)
        : null;
    const { rows } = await pool.query(
      `INSERT INTO customers
         (company_id, full_name, id_type, id_number, email, phone,
          address, city, customer_type, notes, tags)
       VALUES
         (COALESCE($1::int, 1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[])
       RETURNING *`,
      [
        body.company_id ? Number(body.company_id) : 1,
        fullName,
        idTypeIns,
        body.id_number ? String(body.id_number).trim() : null,
        body.email     ? String(body.email).trim()     : null,
        phoneIns,
        body.address   ? String(body.address).trim()   : null,
        body.city      ? String(body.city).trim()      : null,
        customerType,
        body.notes     ? String(body.notes)            : null,
        Array.isArray(body.tags) ? body.tags : null,
      ]
    );
    return rows[0];
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateCustomer({ customerId, ...campos })
//
// Actualización parcial — solo los campos presentes.
// NUNCA actualiza primary_ml_buyer_id desde aquí (usar linkMlBuyer).
// ─────────────────────────────────────────────────────────────────────────────
async function updateCustomer({ customerId, ...body }) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const patch = { ...body };
  if (patch.phone !== undefined) {
    patch.phone = normalizePhoneForCustomersTable(patch.phone);
  }
  if (patch.phone_2 !== undefined) {
    patch.phone_2 = normalizePhoneForCustomersTable(patch.phone_2);
  }
  if (patch.id_type !== undefined) {
    patch.id_type = normalizeIdTypeForCustomer(patch.id_type);
  }

  const ALLOWED = [
    "full_name", "id_type", "id_number", "email", "phone", "phone_2",
    "address", "city", "customer_type", "crm_status", "notes", "tags", "is_active",
  ];

  const sets = [];
  const params = [];

  for (const key of ALLOWED) {
    if (patch[key] === undefined) continue;
    params.push(key === "tags" ? patch[key] : patch[key]);
    const cast = key === "tags" ? `$${params.length}::text[]`
               : key === "is_active" ? `$${params.length}::boolean`
               : `$${params.length}`;
    sets.push(`${key} = ${cast}`);
  }

  if (sets.length === 0) {
    const e = new Error("No hay campos a actualizar");
    e.code = "BAD_REQUEST";
    throw e;
  }

  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE customers
       SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows[0]) {
      const e = new Error("customer no encontrado");
      e.code = "NOT_FOUND";
      throw e;
    }
    return rows[0];
  } catch (err) {
    if (err.code === "BAD_REQUEST" || err.code === "NOT_FOUND") throw err;
    throw mapCrmError(err);
  }
}

/**
 * Tras guardar `customers.phone`, alinea hilos WA (`crm_chats`) por mismo número:
 * fusiona otros `customer_id` en el indicado, asigna chats huérfanos y, si aplica,
 * rellena `sales_orders.conversation_id` cuando aún era NULL.
 * Dispara `triggerResponderNow` para que el worker Tipo M reclame cola pendiente.
 */
async function syncWaChatsByPhoneForCustomer(customerId, options = {}) {
  const keepId = Number(customerId);
  const salesOrderInternalId =
    options.salesOrderInternalId != null && Number.isFinite(Number(options.salesOrderInternalId))
      ? Number(options.salesOrderInternalId)
      : null;

  if (!Number.isFinite(keepId) || keepId <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rows: cr } = await pool.query(`SELECT id, phone FROM customers WHERE id = $1`, [keepId]);
  if (!cr.length) {
    const e = new Error("Cliente no encontrado");
    e.code = "NOT_FOUND";
    throw e;
  }
  const c = cr[0];
  let needle = null;
  try {
    needle = c.phone ? normalizePhoneForCustomersTable(c.phone) : null;
  } catch (_e) {
    needle = c.phone ? String(c.phone).replace(/\D/g, "") : null;
  }
  if (!needle || String(needle).length < 10) {
    const e = new Error("El cliente no tiene un teléfono válido para buscar chats WA");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rows: chats } = await pool.query(
    `SELECT c.id, c.customer_id
       FROM crm_chats c
      WHERE COALESCE(c.source_type, 'wa_inbound') IN ('wa_inbound', 'wa_ml_linked')
        AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $1
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC`,
    [needle]
  );

  const seen = new Set();
  const dropIds = [];
  for (const ch of chats) {
    const cid = ch.customer_id != null ? Number(ch.customer_id) : null;
    if (cid && cid !== keepId && !seen.has(cid)) {
      seen.add(cid);
      dropIds.push(cid);
    }
  }

  const merges = [];
  for (const dId of dropIds) {
    try {
      merges.push(
        await mergeCustomers(keepId, dId, { triggeredBy: "sync_wa_phone_ventas" })
      );
    } catch (err) {
      if (err && (err.code === "CUSTOMER_NOT_FOUND" || err.code === "SAME_CUSTOMER")) continue;
      throw err;
    }
  }

  const up = await pool.query(
    `UPDATE crm_chats c
        SET customer_id = $2,
            updated_at = NOW()
      WHERE COALESCE(c.source_type, 'wa_inbound') IN ('wa_inbound', 'wa_ml_linked')
        AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $1
        AND (c.customer_id IS DISTINCT FROM $2)`,
    [needle, keepId]
  );

  let conversation_updated = false;
  if (chats.length > 0 && Number.isFinite(salesOrderInternalId) && salesOrderInternalId > 0) {
    const primaryChatId = Number(chats[0].id);
    const so = await pool.query(
      `UPDATE sales_orders
          SET conversation_id = $1,
              updated_at = NOW()
        WHERE id = $2
          AND customer_id = $3
          AND conversation_id IS NULL`,
      [primaryChatId, salesOrderInternalId, keepId]
    );
    conversation_updated = (so.rowCount || 0) > 0;
  }

  try {
    const { triggerResponderNow } = require("./aiResponder");
    triggerResponderNow();
  } catch (_e) {
    /* opcional */
  }

  return {
    needle,
    chats_found: chats.length,
    chats_relinked: up.rowCount || 0,
    merges_count: merges.length,
    merges,
    conversation_updated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// linkMlBuyer({ customerId, mlBuyerId, isPrimary, notes, linkedBy })
//
// Vincula un buyer de ML a un customer.
// Si isPrimary = TRUE → transacción: reset otros primary → INSERT → update customer.
// ─────────────────────────────────────────────────────────────────────────────
async function linkMlBuyer({ customerId, mlBuyerId, isPrimary, notes, linkedBy }) {
  const cid = Number(customerId);
  const bid = Number(mlBuyerId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(bid) || bid <= 0) {
    const e = new Error("customerId y mlBuyerId son obligatorios");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (isPrimary) {
      // Quitar primary de todos los links actuales de este customer
      await client.query(
        `UPDATE customer_ml_buyers SET is_primary = FALSE
         WHERE customer_id = $1`,
        [cid]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO customer_ml_buyers
         (customer_id, ml_buyer_id, is_primary, notes, linked_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, ml_buyer_id) DO UPDATE SET
         is_primary = EXCLUDED.is_primary,
         notes      = COALESCE(EXCLUDED.notes, customer_ml_buyers.notes),
         linked_by  = COALESCE(EXCLUDED.linked_by, customer_ml_buyers.linked_by)
       RETURNING *`,
      [cid, bid, isPrimary === true, notes || null, linkedBy ? Number(linkedBy) : null]
    );

    if (isPrimary) {
      await client.query(
        `UPDATE customers
         SET primary_ml_buyer_id = $1, updated_at = now()
         WHERE id = $2`,
        [bid, cid]
      );
    }

    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw mapCrmError(err);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getMlBuyersForCustomer(customerId)
// ─────────────────────────────────────────────────────────────────────────────
async function getMlBuyersForCustomer(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `SELECT b.buyer_id, b.nickname, b.nombre_apellido,
              b.phone_1, b.phone_2, b.pref_entrega,
              cmb.is_primary, cmb.linked_at, cmb.notes
       FROM ml_buyers b
       JOIN customer_ml_buyers cmb ON cmb.ml_buyer_id = b.buyer_id
       WHERE cmb.customer_id = $1
       ORDER BY cmb.is_primary DESC, cmb.linked_at ASC`,
      [id]
    );
    return rows;
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// addWalletTransaction({ customerId, amountUsd, txType,
//                        referenceType, referenceId, notes, createdBy })
//
// Crea la transacción en wallet_transactions usando el esquema completo
// (wallet_id, status, currency, approved_by, etc.).
//
// Mapeo de txType:
//   CREDIT_RMA     → CREDIT_RMA       (CONFIRMED automático con approved_by=createdBy||1)
//   CREDIT_MANUAL  → CREDIT_ADJUSTMENT (ídem)
//   CREDIT_RETURN  → CREDIT_RETURN    (ídem)
//   DEBIT_SALE     → DEBIT_PURCHASE   (PENDING — requiere confirmación)
//   DEBIT_ADJUST   → DEBIT_ADJUSTMENT  (PENDING)
//
// Retorna { transaction, newBalance }.
// ─────────────────────────────────────────────────────────────────────────────
async function addWalletTransaction({
  customerId, amountUsd, txType,
  referenceType, referenceId, notes, createdBy,
}) {
  const cid = Number(customerId);
  const amt = Number(amountUsd);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("customerId inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (!Number.isFinite(amt) || amt === 0) {
    const e = new Error("amountUsd debe ser distinto de cero");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const mappedType = mapCrmTxType(txType);
  if (!mappedType) {
    const e = new Error(`tx_type inválido. Usar: ${VALID_CRM_TX_TYPES.join("|")}`);
    e.code = "BAD_REQUEST";
    throw e;
  }

  const isCredit = mappedType.startsWith("CREDIT");
  if (isCredit && amt <= 0) {
    const e = new Error("CREDIT requiere amountUsd > 0");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (!isCredit && amt >= 0) {
    const e = new Error("DEBIT requiere amountUsd < 0");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const approver   = createdBy ? Number(createdBy) : 1;
  const statusVal  = isCredit ? "CONFIRMED" : "PENDING";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Asegurar wallet USD
    await client.query(
      `INSERT INTO customer_wallets (customer_id, currency)
       VALUES ($1, 'USD')
       ON CONFLICT (customer_id, currency) DO NOTHING`,
      [cid]
    );
    const { rows: [wallet] } = await client.query(
      `SELECT id FROM customer_wallets
       WHERE customer_id = $1 AND currency = 'USD'`,
      [cid]
    );

    const { rows: [tx] } = await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, customer_id, tx_type, status, currency, amount,
          reference_type, reference_id, notes, approved_by, approved_at)
       VALUES
         ($1, $2, $3::wallet_tx_type, $4::wallet_tx_status, 'USD', $5,
          $6, $7, $8,
          CASE WHEN $4 = 'CONFIRMED' THEN $9 ELSE NULL END,
          CASE WHEN $4 = 'CONFIRMED' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        wallet.id, cid, mappedType, statusVal, amt,
        referenceType || null,
        referenceId   ? String(referenceId) : null,
        notes         || null,
        approver,
      ]
    );

    await client.query("COMMIT");

    const { rows: [wRow] } = await pool.query(
      `SELECT balance FROM customer_wallets
       WHERE customer_id = $1 AND currency = 'USD'`,
      [cid]
    );

    return { transaction: tx, newBalance: wRow ? Number(wRow.balance) : 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "BAD_REQUEST") throw err;
    throw mapCrmError(err);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getWalletBalance(customerId)
// ─────────────────────────────────────────────────────────────────────────────
async function getWalletBalance(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `SELECT currency, balance FROM customer_wallets
       WHERE customer_id = $1
       ORDER BY currency`,
      [id]
    );
    const usd = rows.find(r => r.currency === "USD");
    return {
      balance_usd: usd ? Number(usd.balance) : 0,
      wallets: rows,
    };
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getWalletHistory({ customerId, limit, offset })
// ─────────────────────────────────────────────────────────────────────────────
async function getWalletHistory({ customerId, limit, offset }) {
  const id  = Number(customerId);
  const lim = Math.min(Math.max(Number(limit)  || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `SELECT wt.*, cw.currency AS wallet_currency
       FROM wallet_transactions wt
       JOIN customer_wallets cw ON cw.id = wt.wallet_id
       WHERE wt.customer_id = $1
       ORDER BY wt.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, lim, off]
    );
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*) AS total FROM wallet_transactions WHERE customer_id = $1`,
      [id]
    );
    return { transactions: rows, total: Number(cnt[0].total), limit: lim, offset: off };
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runMigration(companyId)
// ─────────────────────────────────────────────────────────────────────────────
async function runMigration(companyId) {
  const cid = Number(companyId) || 1;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM migrate_ml_buyers_to_crm($1)`,
      [cid]
    );
    const result = rows[0] || { created: 0, linked: 0, skipped: 0 };
    console.log(
      `[crm] Migración completada: created=${result.created} linked=${result.linked} skipped=${result.skipped}`
    );
    return result;
  } catch (err) {
    throw mapCrmError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getWalletSummary(customerId)
//
// Resumen del libro mayor para el panel admin.
// Retorna totales de créditos, débitos y conteos por tipo.
// ─────────────────────────────────────────────────────────────────────────────
async function getWalletSummary(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows: [summary] } = await pool.query(
      `SELECT
         COUNT(*)                                                         AS total_tx,
         COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)              AS total_credits,
         COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0)              AS total_debits,
         COUNT(*) FILTER (WHERE tx_type = 'CREDIT_RMA')                  AS rma_count,
         COUNT(*) FILTER (WHERE tx_type IN ('DEBIT_PURCHASE','DEBIT_ADJUSTMENT')) AS sale_count,
         COUNT(*) FILTER (WHERE status = 'CONFIRMED')                    AS confirmed_count,
         COUNT(*) FILTER (WHERE status = 'PENDING')                      AS pending_count,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')                    AS cancelled_count,
         MIN(created_at)                                                  AS first_tx,
         MAX(created_at)                                                  AS last_tx
       FROM wallet_transactions
       WHERE customer_id = $1`,
      [id]
    );

    const { rows: [wallet] } = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) AS balance_usd
       FROM customer_wallets
       WHERE customer_id = $1`,
      [id]
    );

    return {
      customer_id:     id,
      balance_usd:     Number(wallet.balance_usd),
      total_tx:        Number(summary.total_tx),
      total_credits:   Number(summary.total_credits),
      total_debits:    Number(summary.total_debits),
      rma_count:       Number(summary.rma_count),
      sale_count:      Number(summary.sale_count),
      confirmed_count: Number(summary.confirmed_count),
      pending_count:   Number(summary.pending_count),
      cancelled_count: Number(summary.cancelled_count),
      first_tx:        summary.first_tx,
      last_tx:         summary.last_tx,
    };
  } catch (err) {
    throw mapCrmError(err);
  }
}

module.exports = {
  findOrCreateFromBuyer,
  getCustomer,
  searchCustomers,
  createCustomer,
  updateCustomer,
  syncWaChatsByPhoneForCustomer,
  linkMlBuyer,
  getMlBuyersForCustomer,
  addWalletTransaction,
  getWalletBalance,
  getWalletHistory,
  getWalletSummary,
  runMigration,
  VALID_CRM_TX_TYPES,
};
