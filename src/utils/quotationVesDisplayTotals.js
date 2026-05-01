"use strict";

/**
 * Misma lógica que `frontend/src/lib/quotationVesDisplayTotals.ts` (cotización vista VES / conciliación).
 */

function vesAdjustedUsd(usd, binance, bcv) {
  if (!(bcv > 0) || !(binance > 0)) return usd;
  return Math.round((usd * binance) / bcv) - 0.04;
}

/**
 * @param {object} pool Pool pg (`query`).
 * @param {number} presupuestoId
 * @param {{ bcv_rate?: unknown, binance_rate?: unknown }} rateRow
 * @returns {Promise<number|null>} Total Bs display o null si no aplica (sin líneas / sin tasas).
 */
async function quotationDisplayTotalBsFromLines(pool, presupuestoId, rateRow) {
  if (!rateRow) return null;
  const bcv = Number(rateRow.bcv_rate ?? 0);
  const bin = Number(rateRow.binance_rate ?? 0);
  if (!(bcv > 0) || !(bin > 0)) return null;
  const { rows } = await pool.query(
    `SELECT cantidad::float8 AS cantidad, precio_unitario::float8 AS precio_unitario
     FROM inventario_detallepresupuesto WHERE presupuesto_id = $1`,
    [presupuestoId]
  );
  if (!rows || !rows.length) return null;
  let sumUsd = 0;
  for (const r of rows) {
    const q = Number(r.cantidad) || 0;
    const pu = Number(r.precio_unitario) || 0;
    sumUsd += q * vesAdjustedUsd(pu, bin, bcv);
  }
  if (!Number.isFinite(sumUsd) || sumUsd <= 0) return null;
  return Math.round(sumUsd * bcv * 100) / 100;
}

module.exports = { quotationDisplayTotalBsFromLines, vesAdjustedUsd };
