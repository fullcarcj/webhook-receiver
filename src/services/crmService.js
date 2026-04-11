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

// ─── tx_type válidos expuestos por la API CRM ──────────────────────────────
// Subconjunto del ENUM wallet_tx_type que tiene sentido para el CRM.
// Se mapean a los valores EXACTOS del ENUM en wallet_transactions.
const CRM_TX_TYPES = {
  CREDIT_RMA:     "CREDIT_RMA",
  CREDIT_MANUAL:  "CREDIT_ADJUSTMENT",  // alias amigable
  CREDIT_RETURN:  "CREDIT_RETURN",
  DEBIT_SALE:     "DEBIT_PURCHASE",     // alias amigable
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
      `SELECT * FROM v_customers_full WHERE customer_id = $1`,
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
        body.id_type   ? String(body.id_type).trim()   : null,
        body.id_number ? String(body.id_number).trim() : null,
        body.email     ? String(body.email).trim()     : null,
        body.phone     ? String(body.phone).trim()     : null,
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

  const ALLOWED = [
    "full_name", "id_type", "id_number", "email", "phone",
    "address", "city", "customer_type", "notes", "tags", "is_active",
  ];

  const sets = [];
  const params = [];

  for (const key of ALLOWED) {
    if (body[key] === undefined) continue;
    params.push(key === "tags" ? body[key] : body[key]);
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

module.exports = {
  findOrCreateFromBuyer,
  getCustomer,
  searchCustomers,
  createCustomer,
  updateCustomer,
  linkMlBuyer,
  getMlBuyersForCustomer,
  addWalletTransaction,
  getWalletBalance,
  getWalletHistory,
  runMigration,
  VALID_CRM_TX_TYPES,
};
