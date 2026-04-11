"use strict";

const { pool } = require("../../db-postgres");
const { getTodayRate } = require("./currencyService");
const { applyBinStockDelta } = require("./lotService");
const igtfService = require("./igtfService");
const taxRetentionService = require("./taxRetentionService");
const fiscalNumberingService = require("./fiscalNumberingService");

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
 * @param {Array<{ payment_method_code?: string, amount_usd?: number }>|null} [p.payments] Desglose POS; si viene, total_usd = subtotal (IGTF absorbido en total_igtf_usd).
 * @param {Array<{ product_sku: string, quantity: number, unit_price_usd: number, landed_cost_usd?: number|null, lot_id?: number|null, bin_id?: number|null }>} p.lines
 * @param {{ rate_applied?: number, rate_type?: string, rate_date?: string }|null} [p.rateSnapshot]
 */
async function createPosSale(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length === 0) {
    throw Object.assign(new Error("Se requiere al menos una línea"), { code: "EMPTY_LINES" });
  }

  const paymentsRaw = p.payments != null && Array.isArray(p.payments) ? p.payments : null;

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

  const usePaymentIgtf = paymentsRaw != null && paymentsRaw.length > 0;
  const insertIgtfUsdLegacy = usePaymentIgtf ? 0 : igtfUsd;
  const insertTotalUsd = usePaymentIgtf
    ? subRounded
    : Math.round((subRounded + igtfUsd) * 10000) / 10000;
  if (!Number.isFinite(insertTotalUsd) || insertTotalUsd <= 0) {
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
  let txResult;
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
        insertIgtfUsdLegacy,
        insertTotalUsd,
        status,
        p.notes != null ? String(p.notes) : null,
      ]
    );
    let sale = insSale.rows[0];
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

    let totalIgtfUsd = 0;
    let totalNetUsd = Number(sale.total_net_usd != null ? sale.total_net_usd : insertTotalUsd);
    let igtfAbsorbed = false;

    let totalIvaRetentionUsd = 0;
    let totalIslrRetentionUsd = 0;
    if (usePaymentIgtf) {
      const igtfCalc = await igtfService.calculateMultiPaymentIgtf(paymentsRaw, saleDate);
      totalIgtfUsd = igtfCalc.total_igtf_usd;
      if (totalIgtfUsd > insertTotalUsd + 0.0001) {
        throw Object.assign(
          new Error("IGTF absorbido supera el total de la venta (revisar montos en divisas)"),
          { code: "IGTF_EXCEEDS_TOTAL" }
        );
      }
      const mergedPay = await taxRetentionService.enrichPaymentsWithTaxRetentions(igtfCalc.payments, saleDate);
      totalIvaRetentionUsd = mergedPay.total_iva_retention_usd;
      totalIslrRetentionUsd = mergedPay.total_islr_retention_usd;
      if (totalIgtfUsd > 0) {
        await client.query(`UPDATE sales SET total_igtf_usd = $1::numeric, updated_at = now() WHERE id = $2`, [
          totalIgtfUsd,
          saleId,
        ]);
      }
      await igtfService.recordSalePayments({
        client,
        saleId,
        payments: mergedPay.payments,
        exchangeRate: rate.rate_applied,
      });
      const { rows: sAgain } = await client.query(`SELECT * FROM sales WHERE id = $1`, [saleId]);
      sale = sAgain[0] || sale;
      totalIgtfUsd = Number(sale.total_igtf_usd || 0);
      totalNetUsd = Number(sale.total_net_usd != null ? sale.total_net_usd : insertTotalUsd - totalIgtfUsd);
      igtfAbsorbed = totalIgtfUsd > 0;
    }

    await client.query("COMMIT");
    // Capturar el resultado ANTES de que finally libere el cliente
    txResult = {
      sale,
      lines: insertedLines,
      rate_snapshot: rate,
      totalIgtfUsd,
      totalNetUsd,
      igtfAbsorbed,
      totalIvaRetentionUsd: usePaymentIgtf ? totalIvaRetentionUsd : 0,
      totalIslrRetentionUsd: usePaymentIgtf ? totalIslrRetentionUsd : 0,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  // ── Emitir factura fiscal ────────────────────────────────────────────
  // Fuera de la transacción principal: un fallo fiscal NO revierte la venta.
  let fiscalDoc = null;
  try {
    let receptorRif = null;
    let receptorName = null;
    let receptorAddress = null;

    if (customerId != null && Number.isFinite(customerId) && customerId > 0) {
      try {
        const { rows: custRows } = await pool.query(
          `SELECT * FROM customers WHERE id = $1 LIMIT 1`,
          [customerId]
        );
        if (custRows.length) {
          const c = custRows[0];
          receptorRif = c.id_number || c.rif || c.tax_id || null;
          receptorName =
            c.full_name ||
            c.name ||
            (c.first_name ? [c.first_name, c.last_name].filter(Boolean).join(" ") : null) ||
            null;
          receptorAddress = c.address || c.direccion || null;
        }
      } catch (_) {
        // Silently ignore: datos de cliente son opcionales para el doc fiscal
      }
    }

    fiscalDoc = await fiscalNumberingService.issueInvoice({
      companyId,
      saleId: txResult.sale.id,
      issueDate: saleDate,
      receptorRif,
      receptorName,
      receptorAddress,
      baseImponibleUsd: subRounded,
      igtfUsd: txResult.totalIgtfUsd || 0,
      notes: null,
    });

    console.log(
      `[fiscal] Factura ${fiscalDoc.doc_number} (${fiscalDoc.control_number}) emitida para venta ${txResult.sale.id}`
    );
  } catch (fiscalErr) {
    console.error(
      `[fiscal] Error emitiendo factura para venta ${txResult.sale.id}:`,
      (fiscalErr && fiscalErr.message) || fiscalErr
    );
  }

  return {
    ...txResult,
    fiscalDocument: fiscalDoc
      ? {
          id: fiscalDoc.id,
          docNumber: fiscalDoc.doc_number,
          controlNumber: fiscalDoc.control_number,
          status: fiscalDoc.status,
          emissionMethod: fiscalDoc.emission_method,
          issueDate: fiscalDoc.issue_date,
        }
      : null,
  };
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

/**
 * Bin por defecto para un SKU (mismo criterio que reservas: primary primero).
 * @param {import('pg').PoolClient} client
 * @param {string} sku
 * @returns {Promise<number|null>}
 */
async function resolveDefaultBinIdForSku(client, sku) {
  const s = String(sku || "").trim();
  if (!s) return null;
  const { rows } = await client.query(
    `SELECT bs.bin_id
     FROM bin_stock bs
     JOIN warehouse_bins wb ON wb.id = bs.bin_id
     WHERE bs.product_sku = $1
     ORDER BY wb.is_primary DESC, bs.bin_id ASC
     LIMIT 1`,
    [s]
  );
  return rows.length ? Number(rows[0].bin_id) : null;
}

/**
 * Recepción en lote dentro de la misma transacción que la compra.
 * @param {import('pg').PoolClient} client
 * @param {object} p
 */
async function applyPurchaseLotReceipt(client, p) {
  const lotId = Number(p.lotId);
  const binId = Number(p.binId);
  const sku = String(p.sku || "").trim();
  const qty = Number(p.qty);
  const purchaseId = Number(p.purchaseId);
  if (!Number.isFinite(lotId) || lotId <= 0) {
    throw Object.assign(new Error("lot_id inválido"), { code: "INVALID_LOT" });
  }
  if (!Number.isFinite(binId) || binId <= 0) {
    throw Object.assign(new Error("bin_id inválido"), { code: "INVALID_BIN" });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error("quantity inválida"), { code: "INVALID_QTY" });
  }
  const { rows: lots } = await client.query(
    `SELECT id, status::text AS status, producto_sku FROM product_lots WHERE id = $1 FOR UPDATE`,
    [lotId]
  );
  if (!lots.length) {
    throw Object.assign(new Error(`Lote no existe: ${lotId}`), { code: "LOT_NOT_FOUND" });
  }
  const lotSku = String(lots[0].producto_sku || "").trim();
  if (lotSku !== sku) {
    throw Object.assign(new Error(`El lote ${lotId} no corresponde al SKU ${sku}`), { code: "LOT_SKU_MISMATCH" });
  }
  const st = String(lots[0].status || "").toUpperCase();
  if (st !== "ACTIVE") {
    throw Object.assign(new Error(`Lote no activo (status=${st})`), { code: "LOT_BAD_STATUS" });
  }

  const up = await client.query(
    `UPDATE lot_bin_stock
     SET qty_available = qty_available + $1::numeric
     WHERE lot_id = $2 AND bin_id = $3
     RETURNING id`,
    [qty, lotId, binId]
  );
  if (!up.rows.length) {
    await client.query(
      `INSERT INTO lot_bin_stock (lot_id, bin_id, producto_sku, qty_available, qty_reserved)
       VALUES ($1, $2, $3, $4::numeric, 0)`,
      [lotId, binId, sku, qty]
    );
  }

  await client.query(
    `INSERT INTO lot_movements (
       lot_id, bin_id, producto_sku, movement_type, qty,
       reference_type, reference_id, user_id, notes
     ) VALUES (
       $1, $2, $3, 'RECEIPT'::lot_movement_type, $4::numeric,
       $5, $6, $7, $8
     )`,
    [
      lotId,
      binId,
      sku,
      qty,
      "purchase",
      String(purchaseId),
      p.userId != null && String(p.userId).trim() !== "" ? String(p.userId) : null,
      p.notes != null ? String(p.notes) : null,
    ]
  );
}

/**
 * Compra POS: `purchases` + `purchase_lines`, entrada de stock (misma tasa que ventas).
 * @param {object} p
 * @param {number} [p.companyId]
 * @param {string|null} [p.purchaseDate] YYYY-MM-DD
 * @param {number|string|null} [p.importShipmentId]
 * @param {Array<{ product_sku?: string, productSku?: string, quantity: number, unit_cost_usd?: number, unitCostUsd?: number, bin_id?: number|null, binId?: number|null, lot_id?: number|null, lotId?: number|null }>} p.lines
 * @param {string|null} [p.notes]
 * @param {number|string|null} [p.userId]
 */
async function createPosPurchase(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (lines.length === 0) {
    throw Object.assign(new Error("Se requiere al menos una línea"), { code: "EMPTY_LINES" });
  }

  const normalizedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i] || {};
    const sku = String(L.product_sku || L.productSku || "").trim();
    const qty = Number(L.quantity);
    const unitCost = Number(L.unit_cost_usd != null ? L.unit_cost_usd : L.unitCostUsd);
    if (!sku) {
      throw Object.assign(new Error(`Línea ${i + 1}: falta product_sku`), { code: "INVALID_LINE_SKU" });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error(`Línea ${i + 1}: quantity debe ser > 0`), { code: "INVALID_LINE_QTY" });
    }
    if (!Number.isFinite(unitCost) || unitCost <= 0) {
      throw Object.assign(new Error(`Línea ${i + 1}: unit_cost_usd debe ser > 0`), { code: "INVALID_LINE_COST" });
    }
    const lotId = L.lot_id != null && L.lot_id !== "" ? Number(L.lot_id) : L.lotId != null ? Number(L.lotId) : null;
    const binRaw = L.bin_id != null && L.bin_id !== "" ? Number(L.bin_id) : L.binId != null ? Number(L.binId) : null;
    normalizedLines.push({
      product_sku: sku,
      quantity: qty,
      unit_cost_usd: unitCost,
      lot_id: lotId != null && Number.isFinite(lotId) && lotId > 0 ? lotId : null,
      bin_id: binRaw != null && Number.isFinite(binRaw) && binRaw > 0 ? binRaw : null,
    });
  }

  let subtotalUsd = 0;
  for (const L of normalizedLines) {
    subtotalUsd += L.quantity * L.unit_cost_usd;
  }
  if (!Number.isFinite(subtotalUsd) || subtotalUsd <= 0) {
    throw Object.assign(new Error("subtotal calculado debe ser > 0"), { code: "INVALID_SUBTOTAL" });
  }
  const subRounded = Math.round(subtotalUsd * 10000) / 10000;
  const totalUsd = subRounded;

  const rate = await resolveRateSnapshot(companyId, p.rateSnapshot || null);
  const totalBs = Math.round(totalUsd * Number(rate.rate_applied) * 100) / 100;

  const purchaseDate =
    p.purchaseDate != null && String(p.purchaseDate).trim() !== ""
      ? String(p.purchaseDate).trim().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

  const importShipmentId =
    p.importShipmentId != null && String(p.importShipmentId).trim() !== ""
      ? Number(p.importShipmentId)
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (importShipmentId != null && Number.isFinite(importShipmentId) && importShipmentId > 0) {
      const { rows: sh } = await client.query(`SELECT id FROM import_shipments WHERE id = $1 LIMIT 1`, [
        importShipmentId,
      ]);
      if (!sh.length) {
        throw Object.assign(new Error(`import_shipment_id no existe: ${importShipmentId}`), {
          code: "SHIPMENT_NOT_FOUND",
        });
      }
    }

    for (const L of normalizedLines) {
      const { rows: pr } = await client.query(`SELECT 1 FROM products WHERE sku = $1 LIMIT 1`, [L.product_sku]);
      if (!pr.length) {
        throw Object.assign(new Error(`SKU no existe en products: ${L.product_sku}`), {
          code: "SKU_NOT_FOUND",
          sku: L.product_sku,
        });
      }
    }

    for (const L of normalizedLines) {
      let binId = L.bin_id;
      if (binId == null) {
        const def = await resolveDefaultBinIdForSku(client, L.product_sku);
        if (def == null) {
          throw Object.assign(
            new Error(
              `Línea con SKU ${L.product_sku}: falta bin_id y no hay bin por defecto (sin fila en bin_stock para ese SKU)`
            ),
            { code: "BIN_REQUIRED", sku: L.product_sku }
          );
        }
        binId = def;
      }
      const { rows: wb } = await client.query(`SELECT id FROM warehouse_bins WHERE id = $1 LIMIT 1`, [binId]);
      if (!wb.length) {
        throw Object.assign(new Error(`bin_id no existe: ${binId}`), { code: "BIN_NOT_FOUND" });
      }
      L._resolved_bin_id = binId;
    }

    for (let i = 0; i < normalizedLines.length; i++) {
      const L = normalizedLines[i];
      let requiresLot = false;
      try {
        const { rows: tr } = await client.query(
          `SELECT COALESCE(requires_lot_tracking, FALSE) AS r FROM products WHERE sku = $1`,
          [L.product_sku]
        );
        requiresLot = !!(tr[0] && tr[0].r === true);
      } catch (e) {
        if (e && e.code === "42703") {
          requiresLot = false;
        } else {
          throw e;
        }
      }
      if (requiresLot && !L.lot_id) {
        throw Object.assign(
          new Error(`Línea ${i + 1}: el SKU ${L.product_sku} requiere lot_id (control de lote)`),
          { code: "LOT_ID_REQUIRED" }
        );
      }
    }

    const insPur = await client.query(
      `INSERT INTO purchases (
         company_id, import_shipment_id, purchase_date,
         rate_applied, rate_type, rate_date,
         subtotal_usd, total_usd, status, notes
       ) VALUES (
         $1, $2, $3::date,
         $4::numeric, $5::rate_type, $6::date,
         $7::numeric, $8::numeric, $9, $10
       )
       RETURNING *`,
      [
        companyId,
        importShipmentId != null && Number.isFinite(importShipmentId) && importShipmentId > 0
          ? importShipmentId
          : null,
        purchaseDate,
        rate.rate_applied,
        rate.rate_type,
        rate.rate_date,
        subRounded,
        totalUsd,
        "POSTED",
        p.notes != null ? String(p.notes) : null,
      ]
    );
    const purchase = insPur.rows[0];
    const purchaseId = purchase.id;
    const uid = p.userId != null && String(p.userId).trim() !== "" ? String(p.userId) : null;

    for (const L of normalizedLines) {
      const { rows: lcRows } = await client.query(
        `SELECT landed_cost_usd FROM products WHERE sku = $1 LIMIT 1`,
        [L.product_sku]
      );
      const landedSnap =
        lcRows[0] && lcRows[0].landed_cost_usd != null && lcRows[0].landed_cost_usd !== ""
          ? Number(lcRows[0].landed_cost_usd)
          : null;
      const landedInsert =
        landedSnap != null && Number.isFinite(landedSnap) && landedSnap >= 0 ? landedSnap : null;

      await client.query(
        `INSERT INTO purchase_lines (
           purchase_id, product_sku, lot_id, bin_id,
           quantity, unit_cost_usd, landed_cost_usd
         ) VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric)`,
        [
          purchaseId,
          L.product_sku,
          L.lot_id,
          L._resolved_bin_id,
          L.quantity,
          L.unit_cost_usd,
          landedInsert,
        ]
      );

      if (L.lot_id) {
        await applyPurchaseLotReceipt(client, {
          lotId: L.lot_id,
          binId: L._resolved_bin_id,
          sku: L.product_sku,
          qty: L.quantity,
          purchaseId,
          userId: uid,
          notes: p.notes != null ? String(p.notes) : null,
        });
      }

      await applyBinStockDelta(client, {
        binId: L._resolved_bin_id,
        sku: L.product_sku,
        deltaAvailable: L.quantity,
        deltaReserved: 0,
        reason: "PURCHASE_RECEIPT",
        referenceId: String(purchaseId),
        referenceType: "purchase",
        userId: uid,
        notes: p.notes != null ? String(p.notes) : null,
      });
    }

    await client.query("COMMIT");
    return {
      purchaseId,
      purchaseDate,
      rateApplied: rate.rate_applied,
      rateType: rate.rate_type,
      rateDate: rate.rate_date,
      subtotalUsd: subRounded,
      totalUsd,
      totalBs,
      linesInserted: normalizedLines.length,
      importShipmentId:
        importShipmentId != null && Number.isFinite(importShipmentId) && importShipmentId > 0
          ? importShipmentId
          : null,
    };
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
 * Compra POS por ID (cabecera + líneas).
 * @param {number|string} purchaseId
 */
async function getPosPurchaseById(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isFinite(id) || id <= 0) {
    throw Object.assign(new Error("id inválido"), { code: "INVALID_ID" });
  }
  const { rows: pRows } = await pool.query(`SELECT * FROM purchases WHERE id = $1`, [id]);
  if (!pRows.length) {
    throw Object.assign(new Error("Compra no encontrada"), { code: "NOT_FOUND" });
  }
  const { rows: lines } = await pool.query(
    `SELECT pl.*, COALESCE(NULLIF(trim(p.description), ''), p.sku) AS product_description
     FROM purchase_lines pl
     JOIN products p ON p.sku = pl.product_sku
     WHERE pl.purchase_id = $1
     ORDER BY pl.id`,
    [id]
  );
  return { purchase: pRows[0], lines };
}

/**
 * Listado paginado de compras POS.
 * @param {object} opts
 * @param {number} [opts.companyId=1]
 * @param {string|null} [opts.from]       YYYY-MM-DD
 * @param {string|null} [opts.to]         YYYY-MM-DD
 * @param {string|null} [opts.status]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 */
async function listPosPurchases({ companyId = 1, from = null, to = null, status = null, limit = 50, offset = 0 } = {}) {
  const cid = Number(companyId) || 1;
  const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  const off = Math.max(0, Number(offset) || 0);

  const conditions = [`company_id = $1`];
  const params = [cid];
  let p = 2;

  if (from) { conditions.push(`purchase_date >= $${p++}::date`); params.push(from); }
  if (to)   { conditions.push(`purchase_date <= $${p++}::date`); params.push(to); }
  if (status) { conditions.push(`status = $${p++}`); params.push(status.toUpperCase()); }

  const where = conditions.join(" AND ");

  const [{ rows: dataRows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT * FROM purchases WHERE ${where} ORDER BY purchase_date DESC, id DESC LIMIT $${p} OFFSET $${p + 1}`,
      [...params, lim, off]
    ),
    pool.query(`SELECT COUNT(*) AS total FROM purchases WHERE ${where}`, params),
  ]);

  return {
    purchases: dataRows,
    total: Number(countRows[0].total),
    limit:  lim,
    offset: off,
  };
}

module.exports = {
  createPosSale,
  createPosPurchase,
  getPosSaleById,
  getPosPurchaseById,
  listPosPurchases,
  resolveRateSnapshot,
};
