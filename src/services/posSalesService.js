"use strict";

const { pool } = require("../../db-postgres");
const { getTodayRate } = require("./currencyService");

const ALLOWED_STATUS = new Set(["PENDING", "PAID", "CANCELLED", "REFUNDED"]);
const RATE_TYPES = new Set(["BCV", "BINANCE", "ADJUSTED"]);

/**
 * Tasa a congelar en la venta: override explícito o última fila válida de daily_exchange_rates.
 * @param {number} companyId
 * @param {{ rate_applied?: number, rate_type?: string, rate_date?: string }|null|undefined} override
 */
async function resolveRateSnapshot(companyId, override) {
  const cid = Number(companyId) || 1;
  if (override && override.rate_applied != null && override.rate_type && override.rate_date) {
    const r = Number(override.rate_applied);
    const t = String(override.rate_type || "").trim().toUpperCase();
    const d = String(override.rate_date || "").trim().slice(0, 10);
    if (!Number.isFinite(r) || r <= 0) {
      throw Object.assign(new Error("rate_applied inválido en snapshot manual"), { code: "INVALID_RATE" });
    }
    if (!RATE_TYPES.has(t)) {
      throw Object.assign(new Error("rate_type debe ser BCV, BINANCE o ADJUSTED"), { code: "INVALID_RATE_TYPE" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw Object.assign(new Error("rate_date debe ser YYYY-MM-DD"), { code: "INVALID_RATE_DATE" });
    }
    return { rate_applied: r, rate_type: t, rate_date: d };
  }

  const row = await getTodayRate(cid);
  if (!row || row.active_rate == null || !Number.isFinite(Number(row.active_rate)) || Number(row.active_rate) <= 0) {
    throw Object.assign(
      new Error("No hay tasa activa en daily_exchange_rates para esta empresa (o active_rate es NULL)"),
      { code: "NO_ACTIVE_RATE" }
    );
  }
  const rd = row.rate_date;
  const rateDate =
    rd instanceof Date ? rd.toISOString().slice(0, 10) : rd != null ? String(rd).slice(0, 10) : null;
  if (!rateDate) {
    throw Object.assign(new Error("rate_date ausente en la tasa del día"), { code: "NO_RATE_DATE" });
  }
  return {
    rate_applied: Number(row.active_rate),
    rate_type: String(row.active_rate_type || "BCV").toUpperCase(),
    rate_date: rateDate,
  };
}

/**
 * @param {object} p
 * @param {number} [p.companyId]
 * @param {number|string|null} [p.customerId]
 * @param {number|string|null} [p.mlOrderId]
 * @param {string|null} [p.saleDate] YYYY-MM-DD
 * @param {string|null} [p.notes]
 * @param {string|null} [p.status]
 * @param {number} [p.igtfUsd]
 * @param {Array<{ product_sku: string, quantity: number, unit_price_usd: number, landed_cost_usd?: number|null, lot_id?: number|null, bin_id?: number|null }>} p.lines
 * @param {{ rate_applied?: number, rate_type?: string, rate_date?: string }|null} [p.rateSnapshot]
 */
async function createPosSale(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length === 0) {
    throw Object.assign(new Error("Se requiere al menos una línea"), { code: "EMPTY_LINES" });
  }

  const status = p.status != null ? String(p.status).trim().toUpperCase() : "PENDING";
  if (!ALLOWED_STATUS.has(status)) {
    throw Object.assign(new Error(`status inválido: ${status}`), { code: "INVALID_STATUS" });
  }

  const igtfUsd = p.igtfUsd != null ? Number(p.igtfUsd) : 0;
  if (!Number.isFinite(igtfUsd) || igtfUsd < 0) {
    throw Object.assign(new Error("igtf_usd inválido"), { code: "INVALID_IGTF" });
  }

  const normalizedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i] || {};
    const sku = String(L.product_sku || L.productSku || "").trim();
    const qty = Number(L.quantity);
    const unit = Number(L.unit_price_usd != null ? L.unit_price_usd : L.unitPriceUsd);
    if (!sku) {
      throw Object.assign(new Error(`Línea ${i + 1}: product_sku requerido`), { code: "INVALID_LINE_SKU" });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error(`Línea ${i + 1}: quantity inválida`), { code: "INVALID_LINE_QTY" });
    }
    if (!Number.isFinite(unit) || unit <= 0) {
      throw Object.assign(new Error(`Línea ${i + 1}: unit_price_usd inválido`), { code: "INVALID_LINE_PRICE" });
    }
    const landed =
      L.landed_cost_usd != null && L.landed_cost_usd !== ""
        ? Number(L.landed_cost_usd)
        : null;
    if (landed != null && (!Number.isFinite(landed) || landed < 0)) {
      throw Object.assign(new Error(`Línea ${i + 1}: landed_cost_usd inválido`), { code: "INVALID_LANDED" });
    }
    const lotId = L.lot_id != null && L.lot_id !== "" ? Number(L.lot_id) : null;
    const binId = L.bin_id != null && L.bin_id !== "" ? Number(L.bin_id) : null;
    normalizedLines.push({
      product_sku: sku,
      quantity: qty,
      unit_price_usd: unit,
      landed_cost_usd: landed,
      lot_id: lotId != null && Number.isFinite(lotId) && lotId > 0 ? lotId : null,
      bin_id: binId != null && Number.isFinite(binId) && binId > 0 ? binId : null,
    });
  }

  let subtotalUsd = 0;
  for (const L of normalizedLines) {
    subtotalUsd += L.quantity * L.unit_price_usd;
  }
  if (!Number.isFinite(subtotalUsd) || subtotalUsd <= 0) {
    throw Object.assign(new Error("subtotal calculado debe ser > 0"), { code: "INVALID_SUBTOTAL" });
  }
  const subRounded = Math.round(subtotalUsd * 10000) / 10000;
  const totalUsd = Math.round((subRounded + igtfUsd) * 10000) / 10000;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
    throw Object.assign(new Error("total_usd debe ser > 0"), { code: "INVALID_TOTAL" });
  }

  const rate = await resolveRateSnapshot(companyId, p.rateSnapshot);

  const saleDate =
    p.saleDate != null && String(p.saleDate).trim() !== ""
      ? String(p.saleDate).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

  const customerId =
    p.customerId != null && String(p.customerId).trim() !== "" ? Number(p.customerId) : null;
  const mlOrderId =
    p.mlOrderId != null && String(p.mlOrderId).trim() !== "" ? Number(p.mlOrderId) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const L of normalizedLines) {
      const { rows } = await client.query(`SELECT 1 FROM products WHERE sku = $1 LIMIT 1`, [L.product_sku]);
      if (!rows.length) {
        throw Object.assign(new Error(`SKU no existe en products: ${L.product_sku}`), {
          code: "SKU_NOT_FOUND",
          sku: L.product_sku,
        });
      }
    }

    if (customerId != null && Number.isFinite(customerId) && customerId > 0) {
      const { rows: cr } = await client.query(`SELECT 1 FROM customers WHERE id = $1 LIMIT 1`, [customerId]);
      if (!cr.length) {
        throw Object.assign(new Error(`customer_id no existe: ${customerId}`), { code: "CUSTOMER_NOT_FOUND" });
      }
    }

    const insSale = await client.query(
      `INSERT INTO sales (
         company_id, customer_id, ml_order_id, sale_date,
         rate_applied, rate_type, rate_date,
         subtotal_usd, igtf_usd, total_usd, status, notes
       ) VALUES (
         $1, $2, $3, $4::date,
         $5::numeric, $6::rate_type, $7::date,
         $8::numeric, $9::numeric, $10::numeric, $11, $12
       )
       RETURNING *`,
      [
        companyId,
        customerId != null && customerId > 0 ? customerId : null,
        mlOrderId != null && mlOrderId > 0 ? mlOrderId : null,
        saleDate,
        rate.rate_applied,
        rate.rate_type,
        rate.rate_date,
        subRounded,
        igtfUsd,
        totalUsd,
        status,
        p.notes != null ? String(p.notes) : null,
      ]
    );
    const sale = insSale.rows[0];
    const saleId = sale.id;

    const insertedLines = [];
    for (const L of normalizedLines) {
      const { rows } = await client.query(
        `INSERT INTO sale_lines (
           sale_id, product_sku, quantity, unit_price_usd,
           landed_cost_usd, lot_id, bin_id
         ) VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6, $7)
         RETURNING *`,
        [
          saleId,
          L.product_sku,
          L.quantity,
          L.unit_price_usd,
          L.landed_cost_usd,
          L.lot_id,
          L.bin_id,
        ]
      );
      insertedLines.push(rows[0]);
    }

    await client.query("COMMIT");
    return { sale, lines: insertedLines, rate_snapshot: rate };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {number|string} saleId
 */
async function getPosSaleById(saleId) {
  const id = Number(saleId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error("id inválido"), { code: "INVALID_ID" });
  }
  const { rows: sRows } = await pool.query(`SELECT * FROM sales WHERE id = $1`, [id]);
  if (!sRows.length) {
    throw Object.assign(new Error("Venta no encontrada"), { code: "NOT_FOUND" });
  }
  const { rows: lines } = await pool.query(
    `SELECT sl.*, COALESCE(NULLIF(trim(p.description), ''), p.sku) AS product_description
     FROM sale_lines sl
     JOIN products p ON p.sku = sl.product_sku
     WHERE sl.sale_id = $1
     ORDER BY sl.id`,
    [id]
  );
  return { sale: sRows[0], lines };
}

module.exports = {
  createPosSale,
  getPosSaleById,
  resolveRateSnapshot,
};
