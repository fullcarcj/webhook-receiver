"use strict";

/**
 * Servicio de Control Financiero Multi-Moneda.
 * Operaciones de escritura y lectura transaccional para:
 *   - Justificación de débitos de bank_statements
 *   - Categorías de gasto (CRUD)
 *   - Transacciones manuales (Zelle, Binance, Efectivo, etc.)
 *   - Tasas de cambio diarias
 */

const { pool } = require("../../db");

// ─── DÉBITOS SIN JUSTIFICAR ────────────────────────────────────────────────────

async function getUnjustifiedDebits({ from, to, limit = 50 }) {
  const { rows } = await pool.query(`
    SELECT bs.id, bs.tx_date, bs.amount AS amount_bs, bs.description,
           bs.reference_number, bs.payment_type,
           CURRENT_DATE - bs.tx_date AS days_pending
    FROM bank_statements bs
    LEFT JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
    WHERE bs.tx_type = 'DEBIT'
      AND dj.id IS NULL
      AND ($1::date IS NULL OR bs.tx_date >= $1)
      AND ($2::date IS NULL OR bs.tx_date <= $2)
    ORDER BY bs.tx_date ASC, bs.amount DESC
    LIMIT $3
  `, [from || null, to || null, limit]);

  const { rows: totals } = await pool.query(`
    SELECT COUNT(*) AS total_count, COALESCE(SUM(bs.amount),0) AS total_bs
    FROM bank_statements bs
    LEFT JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
    WHERE bs.tx_type = 'DEBIT' AND dj.id IS NULL
  `);

  return {
    debits: rows.map((r) => ({
      id:                         Number(r.id),
      tx_date:                    r.tx_date,
      amount_bs:                  Number(r.amount_bs),
      description:                r.description,
      reference_number:           r.reference_number,
      payment_type:               r.payment_type,
      days_without_justification: Number(r.days_pending || 0),
    })),
    total_count: Number(totals[0].total_count),
    total_bs:    Number(totals[0].total_bs),
  };
}

// ─── JUSTIFICAR UN DÉBITO ─────────────────────────────────────────────────────

async function justifyDebit(bankStatementId, { expense_category_id, justification_note, justified_by }) {
  // Verificar que el bank_statement existe y es DEBIT
  const { rows: stmtRows } = await pool.query(
    `SELECT id, tx_type, amount, tx_date, description FROM bank_statements WHERE id = $1`,
    [bankStatementId]
  );
  if (!stmtRows.length) {
    const err = new Error("Movimiento bancario no encontrado");
    err.code = "NOT_FOUND"; err.status = 404; throw err;
  }
  if (stmtRows[0].tx_type !== "DEBIT") {
    const err = new Error("Solo se pueden justificar débitos");
    err.code = "INVALID_TX_TYPE"; err.status = 400; throw err;
  }

  // Verificar que no tiene justificación previa
  const { rows: existing } = await pool.query(
    `SELECT id FROM debit_justifications WHERE bank_statement_id = $1`,
    [bankStatementId]
  );
  if (existing.length) {
    const err = new Error("Este débito ya fue justificado");
    err.code = "ALREADY_JUSTIFIED"; err.status = 409; throw err;
  }

  const { rows: inserted } = await pool.query(`
    INSERT INTO debit_justifications
      (bank_statement_id, expense_category_id, justification_note, justified_by)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [bankStatementId, expense_category_id, justification_note || null, justified_by]);

  return { justification: inserted[0], statement: stmtRows[0] };
}

// ─── CATEGORÍAS ───────────────────────────────────────────────────────────────

async function getCategories() {
  const { rows } = await pool.query(
    `SELECT id, name, type, is_active FROM expense_categories WHERE is_active = TRUE ORDER BY type, name`
  );
  return { categories: rows };
}

async function createCategory({ name, type }) {
  const upperName = String(name).toUpperCase().trim();
  const { rows } = await pool.query(`
    INSERT INTO expense_categories (name, type) VALUES ($1, $2)
    ON CONFLICT (name) DO NOTHING
    RETURNING *
  `, [upperName, type]);

  if (!rows.length) {
    const err = new Error(`Categoría '${upperName}' ya existe`);
    err.code = "ALREADY_EXISTS"; err.status = 409; throw err;
  }
  return rows[0];
}

// ─── TRANSACCIONES MANUALES ───────────────────────────────────────────────────

async function createTransaction({
  type, currency, amount, expense_category_id,
  description, reference, tx_date, registered_by,
  exchange_rate_used,
}) {
  // Si no viene tasa, buscar la del día
  let rate = exchange_rate_used || null;
  if (!rate) {
    const { rows } = await pool.query(
      `SELECT bs_per_usd FROM exchange_rates WHERE rate_date = CURRENT_DATE LIMIT 1`
    );
    if (rows.length) rate = Number(rows[0].bs_per_usd);
  }

  // Calcular equivalente USD
  let amountUsdEquiv = null;
  if (currency === "BS" && rate && rate > 0) {
    amountUsdEquiv = Number((amount / rate).toFixed(4));
  } else if (currency !== "BS") {
    // Zelle, Binance, USD, etc. ya son USD-equivalentes
    amountUsdEquiv = Number(amount);
  }

  const { rows } = await pool.query(`
    INSERT INTO manual_transactions
      (type, currency, amount, amount_usd_equiv, exchange_rate_used,
       expense_category_id, description, reference, tx_date, registered_by)
    VALUES ($1, $2::transaction_currency, $3, $4, $5, $6, $7, $8,
            COALESCE($9::date, CURRENT_DATE), $10)
    RETURNING *
  `, [
    type, currency, amount, amountUsdEquiv, rate,
    expense_category_id || null, description, reference || null,
    tx_date || null, registered_by,
  ]);

  return rows[0];
}

async function getTransactions({ currency, type, from, to, limit = 50, offset = 0 }) {
  const params = [];
  let where = "WHERE TRUE";
  if (currency) { params.push(currency); where += ` AND mt.currency = $${params.length}::transaction_currency`; }
  if (type)     { params.push(type);     where += ` AND mt.type = $${params.length}`; }
  if (from)     { params.push(from);     where += ` AND mt.tx_date >= $${params.length}::date`; }
  if (to)       { params.push(to);       where += ` AND mt.tx_date <= $${params.length}::date`; }

  params.push(limit, offset);
  const { rows } = await pool.query(`
    SELECT mt.*, ec.name AS category_name, ec.type AS category_type
    FROM manual_transactions mt
    LEFT JOIN expense_categories ec ON ec.id = mt.expense_category_id
    ${where}
    ORDER BY mt.tx_date DESC, mt.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const countParams = params.slice(0, -2);
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*) AS total FROM manual_transactions mt ${where}`,
    countParams
  );

  return { transactions: rows, total: Number(cnt[0].total), limit, offset };
}

// ─── TASAS DE CAMBIO ─────────────────────────────────────────────────────────

async function upsertExchangeRate({ rate_date, bs_per_usd, source, registered_by }) {
  const { rows } = await pool.query(`
    INSERT INTO exchange_rates (rate_date, bs_per_usd, source, registered_by)
    VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4)
    ON CONFLICT (rate_date) DO UPDATE SET bs_per_usd = EXCLUDED.bs_per_usd,
      source = EXCLUDED.source, registered_by = EXCLUDED.registered_by
    RETURNING *
  `, [rate_date || null, bs_per_usd, source || "manual", registered_by]);
  return rows[0];
}

async function getCurrentExchangeRate() {
  const { rows } = await pool.query(
    `SELECT rate_date, bs_per_usd, source FROM exchange_rates ORDER BY rate_date DESC LIMIT 1`
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

module.exports = {
  getUnjustifiedDebits,
  justifyDebit,
  getCategories,
  createCategory,
  createTransaction,
  getTransactions,
  upsertExchangeRate,
  getCurrentExchangeRate,
};
