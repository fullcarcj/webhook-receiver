"use strict";

const { pool } = require("../../db-postgres");

/**
 * @param {string|Date|null} [date] YYYY-MM-DD o Date
 * @param {number} [companyId] empresa (settings_tax)
 * @returns {Promise<number>}
 */
async function getRate(date, companyId = 1) {
  const d =
    date != null && String(date).trim() !== ""
      ? String(date).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const cid = Number(companyId);
  const coId = Number.isFinite(cid) && cid > 0 ? Math.floor(cid) : 1;
  let v = NaN;
  try {
    const { rows } = await pool.query(
      `SELECT (get_tax_setting_num('igtf_rate_pct', $2::int, $1::date) / 100.0)::numeric AS r`,
      [d, coId]
    );
    v = rows[0] != null && rows[0].r != null ? Number(rows[0].r) : NaN;
  } catch (_) {
    v = NaN;
  }
  if (!Number.isFinite(v) || v <= 0) {
    const { rows } = await pool.query(`SELECT get_igtf_rate($1::date)::text AS r`, [d]);
    v = rows[0] != null && rows[0].r != null ? Number(rows[0].r) : NaN;
  }
  if (!Number.isFinite(v) || v <= 0) {
    throw Object.assign(new Error("No hay tasa IGTF configurada para la fecha"), { code: "NO_IGTF_RATE" });
  }
  return v;
}

/**
 * @param {object} p
 * @param {number} p.amountUsd
 * @param {string} p.paymentMethodCode
 * @param {string|null} [p.date] YYYY-MM-DD
 */
async function calculateIgtf(p) {
  const amt = Number(p.amountUsd);
  const code = String(p.paymentMethodCode || "").trim();
  const d =
    p.date != null && String(p.date).trim() !== ""
      ? String(p.date).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw Object.assign(new Error("amount_usd inválido"), { code: "INVALID_AMOUNT" });
  }
  if (!code) {
    throw Object.assign(new Error("payment_method_code requerido"), { code: "INVALID_METHOD" });
  }
  const { rows } = await pool.query(
    `SELECT * FROM calculate_igtf($1::numeric, $2::text, $3::date)`,
    [amt, code, d]
  );
  const r = rows[0] || {};
  const igtfAmt = r.igtf_amount_usd != null && r.igtf_amount_usd !== "" ? Number(r.igtf_amount_usd) : 0;
  const netAmt = r.net_amount_usd != null && r.net_amount_usd !== "" ? Number(r.net_amount_usd) : amt;
  return {
    generatesIgtf: !!r.generates_igtf,
    igtfRatePct: r.igtf_rate_pct != null ? Number(r.igtf_rate_pct) : null,
    igtfAmountUsd: Number.isFinite(igtfAmt) ? igtfAmt : 0,
    netAmountUsd: Number.isFinite(netAmt) ? netAmt : amt,
  };
}

/**
 * @param {Array<{ payment_method_code?: string, paymentMethodCode?: string, amount_usd?: number, amountUsd?: number }>} payments
 * @param {string|null} [asOfDate] YYYY-MM-DD
 */
async function calculateMultiPaymentIgtf(payments, asOfDate) {
  const list = Array.isArray(payments) ? payments : [];
  const dateStr =
    asOfDate != null && String(asOfDate).trim() !== ""
      ? String(asOfDate).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const out = [];
  let totalTaxableUsd = 0;
  let totalIgtfUsd = 0;
  let totalUsd = 0;
  for (const raw of list) {
    const paymentMethodCode = String(
      raw.payment_method_code != null ? raw.payment_method_code : raw.paymentMethodCode || ""
    ).trim();
    const amountUsd = Number(raw.amount_usd != null ? raw.amount_usd : raw.amountUsd);
    if (!paymentMethodCode) {
      throw Object.assign(new Error("Cada pago requiere payment_method_code"), { code: "INVALID_PAYMENT" });
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw Object.assign(new Error("Cada pago requiere amount_usd > 0"), { code: "INVALID_PAYMENT" });
    }
    const row = await calculateIgtf({
      amountUsd,
      paymentMethodCode,
      date: dateStr,
    });
    totalUsd += amountUsd;
    if (row.generatesIgtf) {
      totalTaxableUsd += amountUsd;
      totalIgtfUsd += row.igtfAmountUsd;
    }
    out.push({
      payment_method_code: paymentMethodCode,
      amount_usd: amountUsd,
      generates_igtf: row.generatesIgtf,
      igtf_rate_pct: row.igtfRatePct,
      igtf_amount_usd: row.igtfAmountUsd,
      net_amount_usd: row.netAmountUsd,
    });
  }
  const totalNetUsd = Math.round((totalUsd - totalIgtfUsd) * 10000) / 10000;
  return {
    payments: out,
    total_taxable_usd: Math.round(totalTaxableUsd * 10000) / 10000,
    total_igtf_usd: Math.round(totalIgtfUsd * 10000) / 10000,
    total_usd: Math.round(totalUsd * 10000) / 10000,
    total_net_usd: totalNetUsd,
    igtf_absorbed: totalIgtfUsd > 0,
  };
}

/**
 * @param {object} p
 * @param {import('pg').PoolClient} [p.client]
 * @param {number|string} p.saleId
 * @param {Array<object>} p.payments filas ya calculadas (calculateMultiPaymentIgtf.payments)
 * @param {number} p.exchangeRate
 */
async function recordSalePayments(p) {
  const q = p.client && typeof p.client.query === "function" ? p.client : pool;
  const saleId = Number(p.saleId);
  const ex = Number(p.exchangeRate);
  if (!Number.isFinite(saleId) || saleId <= 0) {
    throw Object.assign(new Error("saleId inválido"), { code: "INVALID_SALE_ID" });
  }
  if (!Number.isFinite(ex) || ex <= 0) {
    throw Object.assign(new Error("exchangeRate inválido"), { code: "INVALID_EXCHANGE" });
  }
  const rows = Array.isArray(p.payments) ? p.payments : [];
  let totalIgtf = 0;
  for (const pay of rows) {
    const code = String(pay.payment_method_code || "").trim();
    const amountUsd = Number(pay.amount_usd);
    const gen = !!pay.generates_igtf;
    const ratePct = pay.igtf_rate_pct != null ? Number(pay.igtf_rate_pct) : null;
    const igtfAmt = Number(pay.igtf_amount_usd || 0);
    totalIgtf += igtfAmt;
    const ivaRet = Number(pay.iva_retention_usd ?? 0);
    const islrRet = Number(pay.islr_retention_usd ?? 0);
    await q.query(
      `INSERT INTO sale_payments (
         sale_id, payment_method_code,
         amount_currency, amount_usd,
         generates_igtf, igtf_rate_pct, igtf_amount_usd,
         exchange_rate_used,
         iva_retention_usd, islr_retention_usd
       ) VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric)`,
      [
        saleId,
        code,
        amountUsd,
        amountUsd,
        gen,
        ratePct != null && Number.isFinite(ratePct) ? ratePct : null,
        igtfAmt,
        ex,
        Number.isFinite(ivaRet) && ivaRet >= 0 ? ivaRet : 0,
        Number.isFinite(islrRet) && islrRet >= 0 ? islrRet : 0,
      ]
    );
  }
  return { inserted: rows.length, totalIgtfUsd: Math.round(totalIgtf * 10000) / 10000 };
}

/**
 * @param {object} p
 * @param {number} p.year
 * @param {number} p.month
 * @param {number} [p.companyId]
 */
async function closePeriod(p) {
  const y = Number(p.year);
  const m = Number(p.month);
  const cid = p.companyId != null ? Number(p.companyId) : 1;
  const { rows } = await pool.query(`SELECT close_igtf_period($1::int, $2::int, $3::int) AS r`, [y, m, cid]);
  return rows[0]?.r != null ? rows[0].r : null;
}

/**
 * @param {object} p
 * @param {number} p.year
 * @param {number} p.month
 * @param {number} [p.companyId]
 */
async function getPeriodSummary(p) {
  const cid = p.companyId != null ? Number(p.companyId) : 1;
  const { rows } = await pool.query(
    `SELECT * FROM igtf_declarations
     WHERE company_id = $1 AND period_year = $2 AND period_month = $3
     LIMIT 1`,
    [cid, Number(p.year), Number(p.month)]
  );
  return rows[0] || null;
}

/**
 * @param {object} p
 * @param {number} [p.companyId]
 * @param {string|null} [p.status]
 */
async function getDeclarations(p) {
  const cid = p.companyId != null ? Number(p.companyId) : 1;
  const params = [cid];
  let sql = `SELECT * FROM igtf_declarations WHERE company_id = $1`;
  if (p.status != null && String(p.status).trim() !== "") {
    params.push(String(p.status).trim().toUpperCase());
    sql += ` AND UPPER(status::text) = $${params.length}`;
  }
  sql += ` ORDER BY period_year DESC, period_month DESC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getPaymentMethods() {
  const { rows } = await pool.query(
    `SELECT * FROM payment_methods WHERE is_active = TRUE ORDER BY sort_order ASC, id ASC`
  );
  return rows;
}

module.exports = {
  getRate,
  calculateIgtf,
  calculateMultiPaymentIgtf,
  recordSalePayments,
  closePeriod,
  getPeriodSummary,
  getDeclarations,
  getPaymentMethods,
};
