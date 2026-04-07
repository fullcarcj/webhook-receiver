"use strict";

const { pool } = require("../../db");

const TX_CREDIT_PREFIX = "CREDIT";
const TX_DEBIT_PREFIX = "DEBIT";

function isSchemaMissing(err) {
  const c = err && err.code;
  return c === "42P01" || c === "42P04";
}

function mapWalletError(err) {
  if (isSchemaMissing(err)) {
    const e = new Error("wallet_schema_missing");
    e.code = "WALLET_SCHEMA_MISSING";
    e.cause = err;
    return e;
  }
  const msg = err && err.message ? String(err.message) : "";
  if (msg.includes("Balance negativo")) {
    const e = new Error("negative_balance");
    e.code = "NEGATIVE_BALANCE";
    e.cause = err;
    return e;
  }
  return err;
}

function validateAmountForTxType(txType, amount) {
  const t = String(txType || "");
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) {
    const e = new Error("amount debe ser distinto de cero");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (t.startsWith(TX_CREDIT_PREFIX) && n <= 0) {
    const e = new Error("CREDIT requiere amount > 0");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (t.startsWith(TX_DEBIT_PREFIX) && n >= 0) {
    const e = new Error("DEBIT requiere amount < 0");
    e.code = "BAD_REQUEST";
    throw e;
  }
}

function needsApproverOnConfirm(txType) {
  const t = String(txType || "");
  return !(t === "DEBIT_PURCHASE" || t === "DEBIT_REFUND_CASH");
}

async function mlBuyerExists(mlBuyerId) {
  const { rows } = await pool.query(`SELECT 1 FROM ml_buyers WHERE buyer_id = $1 LIMIT 1`, [
    mlBuyerId,
  ]);
  return rows.length > 0;
}

async function createCustomer(body) {
  const full_name = String(body.full_name || "").trim();
  if (!full_name) {
    const e = new Error("full_name es obligatorio");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO customers (
         company_id, full_name, id_type, id_number, email, phone,
         primary_ml_buyer_id, notes
       ) VALUES (
         COALESCE($1::int, 1), $2, $3, $4, $5, $6, $7, $8
       )
       RETURNING *`,
      [
        body.company_id,
        full_name,
        body.id_type != null ? String(body.id_type).trim() : null,
        body.id_number != null ? String(body.id_number).trim() : null,
        body.email != null ? String(body.email).trim() : null,
        body.phone != null ? String(body.phone).trim() : null,
        body.primary_ml_buyer_id != null ? Number(body.primary_ml_buyer_id) : null,
        body.notes != null ? String(body.notes) : null,
      ]
    );
    return rows[0];
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function getCustomer(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function listCustomers(options) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM customers ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return { items: rows, limit, offset };
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function linkMlBuyer(body) {
  const customer_id = Number(body.customer_id);
  const ml_buyer_id = Number(body.ml_buyer_id);
  if (!Number.isFinite(customer_id) || customer_id <= 0 || !Number.isFinite(ml_buyer_id) || ml_buyer_id <= 0) {
    const e = new Error("customer_id y ml_buyer_id son obligatorios");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    if (!(await mlBuyerExists(ml_buyer_id))) {
      const e = new Error("ml_buyer_id no existe en ml_buyers");
      e.code = "NOT_FOUND";
      throw e;
    }
    const { rows } = await pool.query(
      `INSERT INTO customer_ml_buyers (customer_id, ml_buyer_id, is_primary)
       VALUES ($1, $2, COALESCE($3, false))
       ON CONFLICT (customer_id, ml_buyer_id) DO UPDATE SET
         is_primary = EXCLUDED.is_primary
       RETURNING *`,
      [customer_id, ml_buyer_id, body.is_primary === true]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "BAD_REQUEST" || err.code === "NOT_FOUND") throw err;
    throw mapWalletError(err);
  }
}

async function ensureWallet(customerId, currency) {
  const cid = Number(customerId);
  const cur = String(currency || "USD").toUpperCase();
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (cur !== "USD" && cur !== "VES") {
    const e = new Error("currency debe ser USD o VES");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const ins = await pool.query(
      `INSERT INTO customer_wallets (customer_id, currency)
       VALUES ($1, $2::wallet_currency)
       ON CONFLICT (customer_id, currency) DO NOTHING
       RETURNING *`,
      [cid, cur]
    );
    if (ins.rows[0]) return ins.rows[0];
    const { rows } = await pool.query(
      `SELECT * FROM customer_wallets WHERE customer_id = $1 AND currency = $2::wallet_currency`,
      [cid, cur]
    );
    return rows[0] || null;
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function createTransaction(body) {
  const wallet_id = Number(body.wallet_id);
  const customer_id = Number(body.customer_id);
  const tx_type = String(body.tx_type || "").trim();
  const status = String(body.status || "PENDING").trim();
  const currency = String(body.currency || "USD").toUpperCase();

  if (!Number.isFinite(wallet_id) || wallet_id <= 0 || !Number.isFinite(customer_id) || customer_id <= 0) {
    const e = new Error("wallet_id y customer_id son obligatorios");
    e.code = "BAD_REQUEST";
    throw e;
  }
  if (!tx_type) {
    const e = new Error("tx_type es obligatorio");
    e.code = "BAD_REQUEST";
    throw e;
  }

  validateAmountForTxType(tx_type, body.amount);
  const amount = Number(body.amount);

  if (status === "CONFIRMED") {
    if (needsApproverOnConfirm(tx_type) && (body.approved_by == null || body.approved_by === "")) {
      const e = new Error("approved_by es obligatorio para CONFIRMED en este tx_type");
      e.code = "BAD_REQUEST";
      throw e;
    }
  }

  const approved_by =
    body.approved_by != null && body.approved_by !== "" ? Number(body.approved_by) : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO wallet_transactions (
         wallet_id, customer_id, tx_type, status, currency, amount,
         rate_applied, rate_source, amount_ves,
         reference_type, reference_id, notes, approved_by, approved_at
       ) VALUES (
         $1, $2, $3::wallet_tx_type, $4::wallet_tx_status, $5::wallet_currency, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13,
         CASE WHEN $4::wallet_tx_status = 'CONFIRMED'::wallet_tx_status THEN now() ELSE NULL END
       )
       RETURNING *`,
      [
        wallet_id,
        customer_id,
        tx_type,
        status,
        currency,
        amount,
        body.rate_applied != null ? Number(body.rate_applied) : null,
        body.rate_source != null ? String(body.rate_source) : null,
        body.amount_ves != null ? Number(body.amount_ves) : null,
        body.reference_type != null ? String(body.reference_type) : null,
        body.reference_id != null ? String(body.reference_id) : null,
        body.notes != null ? String(body.notes) : null,
        Number.isFinite(approved_by) ? approved_by : null,
      ]
    );
    return rows[0];
  } catch (err) {
    const mapped = mapWalletError(err);
    if (mapped !== err) throw mapped;
    throw err;
  }
}

async function confirmTransaction(transactionId, body) {
  const id = Number(transactionId);
  const approved_by = body.approved_by != null ? Number(body.approved_by) : null;
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows: cur } = await pool.query(
      `SELECT id, tx_type, status FROM wallet_transactions WHERE id = $1`,
      [id]
    );
    if (!cur[0]) {
      const e = new Error("transacción no encontrada");
      e.code = "NOT_FOUND";
      throw e;
    }
    if (cur[0].status !== "PENDING") {
      const e = new Error("solo se confirma desde PENDING");
      e.code = "BAD_REQUEST";
      throw e;
    }
    if (needsApproverOnConfirm(cur[0].tx_type) && (approved_by == null || !Number.isFinite(approved_by))) {
      const e = new Error("approved_by es obligatorio al confirmar este tipo");
      e.code = "BAD_REQUEST";
      throw e;
    }

    const { rows } = await pool.query(
      `UPDATE wallet_transactions
       SET status = 'CONFIRMED'::wallet_tx_status,
           approved_by = COALESCE($2::integer, approved_by),
           approved_at = now()
       WHERE id = $1 AND status = 'PENDING'::wallet_tx_status
       RETURNING *`,
      [id, Number.isFinite(approved_by) ? approved_by : null]
    );
    if (!rows[0]) {
      const e = new Error("no se pudo confirmar");
      e.code = "CONFLICT";
      throw e;
    }
    return rows[0];
  } catch (err) {
    if (["BAD_REQUEST", "NOT_FOUND", "CONFLICT"].includes(err.code)) throw err;
    const mapped = mapWalletError(err);
    if (mapped !== err) throw mapped;
    throw err;
  }
}

async function cancelTransaction(transactionId, body) {
  const id = Number(transactionId);
  const cancelled_by = body.cancelled_by != null ? Number(body.cancelled_by) : null;
  if (!Number.isFinite(id) || id <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const reason = body.cancel_reason != null ? String(body.cancel_reason) : null;
  try {
    const { rows: cur } = await pool.query(`SELECT id, status FROM wallet_transactions WHERE id = $1`, [id]);
    if (!cur[0]) {
      const e = new Error("transacción no encontrada");
      e.code = "NOT_FOUND";
      throw e;
    }
    if (cur[0].status === "CANCELLED") {
      const e = new Error("ya cancelada");
      e.code = "BAD_REQUEST";
      throw e;
    }

    const { rows } = await pool.query(
      `UPDATE wallet_transactions
       SET status = 'CANCELLED'::wallet_tx_status,
           cancelled_by = $2::integer,
           cancelled_at = now(),
           cancel_reason = $3
       WHERE id = $1 AND status IN ('PENDING'::wallet_tx_status, 'CONFIRMED'::wallet_tx_status)
       RETURNING *`,
      [id, Number.isFinite(cancelled_by) ? cancelled_by : null, reason]
    );
    if (!rows[0]) {
      const e = new Error("no se pudo cancelar");
      e.code = "CONFLICT";
      throw e;
    }
    return rows[0];
  } catch (err) {
    if (["BAD_REQUEST", "NOT_FOUND", "CONFLICT"].includes(err.code)) throw err;
    const mapped = mapWalletError(err);
    if (mapped !== err) throw mapped;
    throw err;
  }
}

async function listTransactions(customerId, options) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("customer_id es obligatorio");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM wallet_transactions
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [cid, limit, offset]
    );
    return { items: rows, limit, offset };
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function getWalletSummaryByCustomerId(customerId, currency) {
  const cid = Number(customerId);
  const cur = currency ? String(currency).toUpperCase() : null;
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("customer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    let q;
    let params;
    if (cur) {
      q = `SELECT * FROM v_customer_wallet_summary WHERE customer_id = $1 AND currency = $2::wallet_currency`;
      params = [cid, cur];
    } else {
      q = `SELECT * FROM v_customer_wallet_summary WHERE customer_id = $1`;
      params = [cid];
    }
    const { rows } = await pool.query(q, params);
    return rows;
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function getWalletSummaryByMlBuyerId(mlBuyerId, currency) {
  const bid = Number(mlBuyerId);
  const cur = currency ? String(currency).toUpperCase() : null;
  if (!Number.isFinite(bid) || bid <= 0) {
    const e = new Error("ml_buyer_id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    let q;
    let params;
    if (cur) {
      q = `
        SELECT v.*
        FROM v_customer_wallet_summary v
        JOIN customer_ml_buyers cmb ON cmb.customer_id = v.customer_id
        WHERE cmb.ml_buyer_id = $1 AND v.currency = $2::wallet_currency`;
      params = [bid, cur];
    } else {
      q = `
        SELECT v.*
        FROM v_customer_wallet_summary v
        JOIN customer_ml_buyers cmb ON cmb.customer_id = v.customer_id
        WHERE cmb.ml_buyer_id = $1`;
      params = [bid];
    }
    const { rows } = await pool.query(q, params);
    return rows;
  } catch (err) {
    throw mapWalletError(err);
  }
}

async function listDriftRows() {
  try {
    const { rows } = await pool.query(
      `SELECT customer_id, full_name, currency, balance_current, balance_calculated, balance_drift,
              pending_count, confirmed_count, last_movement_at
       FROM v_customer_wallet_summary
       WHERE balance_drift != 0
       ORDER BY ABS(balance_drift) DESC`
    );
    return rows;
  } catch (err) {
    throw mapWalletError(err);
  }
}

module.exports = {
  createCustomer,
  getCustomer,
  listCustomers,
  linkMlBuyer,
  ensureWallet,
  createTransaction,
  confirmTransaction,
  cancelTransaction,
  listTransactions,
  getWalletSummaryByCustomerId,
  getWalletSummaryByMlBuyerId,
  listDriftRows,
  mlBuyerExists,
  validateAmountForTxType,
  needsApproverOnConfirm,
};
