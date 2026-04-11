"use strict";

const { pool } = require("../../db-postgres");

/**
 * Parámetros globales vigentes a una fecha.
 * @param {string|null} [asOfDate] YYYY-MM-DD
 */
async function getGlobals(asOfDate) {
  const d =
    asOfDate != null && String(asOfDate).trim() !== ""
      ? String(asOfDate).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM tax_retention_globals
     WHERE effective_from <= $1::date
     ORDER BY effective_from DESC
     LIMIT 1`,
    [d]
  );
  return (
    rows[0] || {
      vat_aliquota_pct: 0.16,
      iva_retained_fraction_of_vat: 0.75,
      effective_from: d,
    }
  );
}

/**
 * @param {object} p
 * @param {number} p.amountUsd
 * @param {string} p.paymentMethodCode
 * @param {string|null} [p.date] YYYY-MM-DD
 */
async function calculatePaymentRetention(p) {
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
    `SELECT * FROM calculate_payment_tax_retentions($1::numeric, $2::text, $3::date)`,
    [amt, code, d]
  );
  const r = rows[0] || {};
  const iva = Number(r.iva_retention_usd ?? 0);
  const islr = Number(r.islr_retention_usd ?? 0);
  return {
    ivaRetentionEnabled: !!r.iva_retention_enabled,
    vatAliquotaPct: r.vat_aliquota_pct != null ? Number(r.vat_aliquota_pct) : 0.16,
    ivaRetainedFractionOfVat:
      r.iva_retained_fraction_of_vat != null ? Number(r.iva_retained_fraction_of_vat) : 0.75,
    ivaRetentionUsd: Number.isFinite(iva) ? iva : 0,
    islrRetentionPct: r.islr_retention_pct != null ? Number(r.islr_retention_pct) : 0,
    islrRetentionUsd: Number.isFinite(islr) ? islr : 0,
  };
}

/**
 * Enriquece filas de pago (p. ej. salida de calculateMultiPaymentIgtf) con retenciones IVA/ISLR.
 * @param {Array<object>} payments cada objeto debe incluir payment_method_code y amount_usd
 * @param {string|null} [asOfDate]
 */
async function enrichPaymentsWithTaxRetentions(payments, asOfDate) {
  const list = Array.isArray(payments) ? payments : [];
  const dateStr =
    asOfDate != null && String(asOfDate).trim() !== ""
      ? String(asOfDate).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const out = [];
  let totalIvaRetentionUsd = 0;
  let totalIslrRetentionUsd = 0;
  for (const row of list) {
    const code = String(row.payment_method_code || "").trim();
    const amountUsd = Number(row.amount_usd);
    const ret = await calculatePaymentRetention({
      amountUsd,
      paymentMethodCode: code,
      date: dateStr,
    });
    totalIvaRetentionUsd += ret.ivaRetentionUsd;
    totalIslrRetentionUsd += ret.islrRetentionUsd;
    out.push({
      ...row,
      iva_retention_enabled: ret.ivaRetentionEnabled,
      vat_aliquota_pct: ret.vatAliquotaPct,
      iva_retained_fraction_of_vat: ret.ivaRetainedFractionOfVat,
      iva_retention_usd: ret.ivaRetentionUsd,
      islr_retention_pct: ret.islrRetentionPct,
      islr_retention_usd: ret.islrRetentionUsd,
    });
  }
  return {
    payments: out,
    total_iva_retention_usd: Math.round(totalIvaRetentionUsd * 10000) / 10000,
    total_islr_retention_usd: Math.round(totalIslrRetentionUsd * 10000) / 10000,
  };
}

/**
 * Solo retenciones (sin IGTF). Útil para preview.
 * @param {Array<{ payment_method_code: string, amount_usd: number }>} payments
 * @param {string|null} [asOfDate]
 */
async function calculateMultiPaymentRetentions(payments, asOfDate) {
  return enrichPaymentsWithTaxRetentions(payments, asOfDate);
}

module.exports = {
  getGlobals,
  calculatePaymentRetention,
  enrichPaymentsWithTaxRetentions,
  calculateMultiPaymentRetentions,
};
