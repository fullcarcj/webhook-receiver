"use strict";

const { pool } = require("../../db-postgres");
const { setMovementSessionVars } = require("./wmsService");

/**
 * Actualiza bin_stock en la transacción actual (misma lógica que adjustStock, sin segundo pool.connect).
 * @param {import('pg').PoolClient} client
 */
async function applyBinStockDelta(client, { binId, sku, deltaAvailable, deltaReserved, reason, referenceId, referenceType, userId, notes }) {
  await setMovementSessionVars(client, {
    reason,
    referenceId,
    referenceType,
    userId,
    notes,
  });
  const skuStr = String(sku || "").trim();
  const da = Number(deltaAvailable) || 0;
  const dr = Number(deltaReserved) || 0;
  const up = await client.query(
    `UPDATE bin_stock
     SET qty_available = qty_available + $1,
         qty_reserved = qty_reserved + $2
     WHERE bin_id = $3 AND producto_sku = $4
     RETURNING qty_available, qty_reserved`,
    [da, dr, binId, skuStr]
  );
  let row = up.rows[0];
  if (!row) {
    if (da < 0 || dr < 0) {
      throw Object.assign(new Error("Stock insuficiente o bin/SKU inexistente"), { code: "INVALID_ADJUSTMENT" });
    }
    const ins = await client.query(
      `INSERT INTO bin_stock (bin_id, producto_sku, qty_available, qty_reserved)
       VALUES ($1, $2, $3, $4)
       RETURNING qty_available, qty_reserved`,
      [binId, skuStr, da, dr]
    );
    row = ins.rows[0];
  } else {
    if (Number(row.qty_available) < 0 || Number(row.qty_reserved) < 0) {
      throw Object.assign(new Error("Cantidades no pueden quedar negativas"), { code: "NEGATIVE_STOCK" });
    }
  }
  return row;
}

/**
 * @param {object} p
 * @param {number} [p.companyId]
 * @param {string} p.sku
 * @param {string|null} [p.expirationDate] ISO date
 * @param {string|null} [p.manufactureDate]
 * @param {number|null} [p.importShipmentId]
 * @param {number} p.qtyInitial
 * @param {number} p.binId
 * @param {string|null} [p.notes]
 * @param {string|null} [p.supplierLotNumber]
 * @param {string|null} [p.receivedDate] ISO date
 */
async function createLot(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const sku = String(p.sku || "").trim();
  if (!sku) throw Object.assign(new Error("sku requerido"), { code: "INVALID_SKU" });
  const qtyInitial = Number(p.qtyInitial);
  const binId = Number(p.binId);
  if (!Number.isFinite(qtyInitial) || qtyInitial <= 0) {
    throw Object.assign(new Error("qty_initial inválido"), { code: "INVALID_QTY" });
  }
  if (!Number.isFinite(binId) || binId <= 0) {
    throw Object.assign(new Error("bin_id inválido"), { code: "INVALID_BIN" });
  }

  const { rows: prodRows } = await pool.query(
    `SELECT COALESCE(requires_lot_tracking, FALSE) AS r FROM products WHERE sku = $1`,
    [sku]
  );
  if (!prodRows.length) throw Object.assign(new Error("SKU no existe"), { code: "SKU_NOT_FOUND" });
  if (!prodRows[0].r) {
    throw Object.assign(new Error("SKU no requiere control de lote"), { code: "LOT_TRACKING_NOT_REQUIRED" });
  }

  if (p.importShipmentId != null && String(p.importShipmentId).trim() !== "") {
    const sid = Number(p.importShipmentId);
    if (Number.isFinite(sid) && sid > 0) {
      const { rows: sh } = await pool.query(`SELECT id FROM import_shipments WHERE id = $1`, [sid]);
      if (!sh.length) throw Object.assign(new Error("import_shipment_id no existe"), { code: "SHIPMENT_NOT_FOUND" });
    }
  }

  const receivedDate = p.receivedDate ? String(p.receivedDate).slice(0, 10) : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: numRows } = await client.query(
      `SELECT generate_lot_number($1::text, COALESCE($2::date, CURRENT_DATE)) AS lot_number`,
      [sku, receivedDate]
    );
    const lotNumber = numRows[0]?.lot_number;
    if (!lotNumber) throw new Error("generate_lot_number devolvió vacío");

    const insLot = await client.query(
      `INSERT INTO product_lots (
         company_id, producto_sku, lot_number, supplier_lot_number, import_shipment_id,
         manufacture_date, expiration_date, received_date, qty_initial, notes, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::date, $7::date, COALESCE($8::date, CURRENT_DATE), $9, $10,
         'ACTIVE'::lot_status
       )
       RETURNING id, status, expiration_date`,
      [
        companyId,
        sku,
        lotNumber,
        p.supplierLotNumber != null ? String(p.supplierLotNumber).trim() || null : null,
        p.importShipmentId != null && Number(p.importShipmentId) > 0 ? Number(p.importShipmentId) : null,
        p.manufactureDate ? String(p.manufactureDate).slice(0, 10) : null,
        p.expirationDate ? String(p.expirationDate).slice(0, 10) : null,
        receivedDate,
        qtyInitial,
        p.notes != null ? String(p.notes) : null,
      ]
    );
    const lotId = insLot.rows[0].id;
    const lotStatus = insLot.rows[0].status;

    await client.query(
      `INSERT INTO lot_bin_stock (lot_id, bin_id, producto_sku, qty_available, qty_reserved)
       VALUES ($1, $2, $3, $4, 0)`,
      [lotId, binId, sku, qtyInitial]
    );

    await client.query(
      `INSERT INTO lot_movements (
         lot_id, bin_id, producto_sku, movement_type, qty,
         reference_type, reference_id, user_id, notes
       ) VALUES ($1, $2, $3, 'RECEIPT'::lot_movement_type, $4, $5, $6, $7, $8)`,
      [
        lotId,
        binId,
        sku,
        qtyInitial,
        p.importShipmentId ? "import_shipment" : "manual_receipt",
        p.importShipmentId != null ? String(p.importShipmentId) : null,
        p.userId != null ? String(p.userId) : null,
        p.notes != null ? String(p.notes) : null,
      ]
    );

    await applyBinStockDelta(client, {
      binId,
      sku,
      deltaAvailable: qtyInitial,
      deltaReserved: 0,
      reason: "PURCHASE_RECEIPT",
      referenceId: String(lotId),
      referenceType: "product_lot",
      userId: p.userId != null ? String(p.userId) : null,
      notes: `Recepción lote ${lotNumber}`,
    });

    await client.query("COMMIT");
    return {
      lotId,
      lotNumber,
      sku,
      expirationDate: insLot.rows[0].expiration_date,
      qtyInitial,
      status: lotStatus,
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

async function getLotsBySku(sku) {
  const s = String(sku || "").trim();
  if (!s) throw Object.assign(new Error("sku requerido"), { code: "INVALID_SKU" });
  const { rows } = await pool.query(
    `SELECT * FROM v_lots_fefo WHERE producto_sku = $1
     ORDER BY
       CASE WHEN expiration_date IS NULL THEN 1 ELSE 0 END,
       expiration_date ASC NULLS LAST,
       received_date ASC`,
    [s]
  );
  return rows;
}

/**
 * @param {object} p
 * @param {number} p.lotId
 * @param {number} p.binId
 * @param {number} p.qty
 * @param {string|null} [p.referenceType]
 * @param {string|null} [p.referenceId]
 * @param {number|string|null} [p.userId]
 */
async function dispatchFromLot(p) {
  const lotId = Number(p.lotId);
  const binId = Number(p.binId);
  const qty = Number(p.qty);
  if (!Number.isFinite(lotId) || lotId <= 0) throw Object.assign(new Error("lot_id inválido"), { code: "INVALID_LOT" });
  if (!Number.isFinite(binId) || binId <= 0) throw Object.assign(new Error("bin_id inválido"), { code: "INVALID_BIN" });
  if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error("qty inválida"), { code: "INVALID_QTY" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM product_lots WHERE id = $1 FOR UPDATE`, [lotId]);

    const { rows: lotRows } = await client.query(
      `SELECT lot_number, status::text AS status, producto_sku FROM product_lots WHERE id = $1`,
      [lotId]
    );
    if (!lotRows.length) throw Object.assign(new Error("Lote no existe"), { code: "LOT_NOT_FOUND" });
    const lot = lotRows[0];
    if (lot.status === "EXPIRED") {
      throw Object.assign(new Error("Lote vencido"), { code: "LOT_EXPIRED", lotNumber: lot.lot_number });
    }
    if (lot.status === "QUARANTINE") {
      throw Object.assign(new Error("Lote en cuarentena"), { code: "LOT_IN_QUARANTINE", lotNumber: lot.lot_number });
    }
    if (lot.status !== "ACTIVE") {
      throw Object.assign(new Error(`Lote no despachable (status=${lot.status})`), { code: "LOT_BAD_STATUS" });
    }

    const { rows: lbsRows } = await client.query(
      `SELECT id, qty_available FROM lot_bin_stock
       WHERE lot_id = $1 AND bin_id = $2 FOR UPDATE`,
      [lotId, binId]
    );
    if (!lbsRows.length) {
      throw Object.assign(new Error("Sin stock de lote en ese bin"), { code: "LOT_BIN_NOT_FOUND" });
    }
    const available = Number(lbsRows[0].qty_available);
    if (available < qty) {
      throw Object.assign(new Error("Stock de lote insuficiente"), {
        code: "INSUFFICIENT_LOT_STOCK",
        available,
        requested: qty,
      });
    }

    const sku = String(lot.producto_sku);

    await client.query(
      `UPDATE lot_bin_stock
       SET qty_available = qty_available - $1
       WHERE id = $2`,
      [qty, lbsRows[0].id]
    );

    await client.query(
      `INSERT INTO lot_movements (
         lot_id, bin_id, producto_sku, movement_type, qty,
         reference_type, reference_id, user_id, notes
       ) VALUES ($1, $2, $3, 'DISPATCH'::lot_movement_type, $4, $5, $6, $7, $8)`,
      [
        lotId,
        binId,
        sku,
        -qty,
        p.referenceType != null ? String(p.referenceType) : null,
        p.referenceId != null ? String(p.referenceId) : null,
        p.userId != null ? String(p.userId) : null,
        null,
      ]
    );

    await applyBinStockDelta(client, {
      binId,
      sku,
      deltaAvailable: -qty,
      deltaReserved: 0,
      reason: "SALE_DISPATCH",
      referenceId: p.referenceId != null ? String(p.referenceId) : String(lotId),
      referenceType: p.referenceType != null ? String(p.referenceType) : "lot_dispatch",
      userId: p.userId != null ? String(p.userId) : null,
      notes: `Despacho lote ${lot.lot_number}`,
    });

    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(qty_available + qty_reserved), 0)::numeric AS t
       FROM lot_bin_stock WHERE lot_id = $1`,
      [lotId]
    );
    if (Number(sumRows[0]?.t || 0) <= 0) {
      await client.query(`UPDATE product_lots SET status = 'EXHAUSTED'::lot_status WHERE id = $1`, [lotId]);
    }

    await client.query("COMMIT");
    return { success: true, lotNumber: lot.lot_number, qtyDispatched: qty, sku };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function getExpiryAlerts({ companyId = 1, days = 90 } = {}) {
  const d = Math.min(Math.max(Number(days) || 90, 1), 730);
  const { rows } = await pool.query(
    `SELECT * FROM v_expiry_alerts
     WHERE days_remaining IS NOT NULL AND days_remaining <= $1
     ORDER BY expiration_date ASC`,
    [d]
  );
  const grouped = { EXPIRED: [], CRITICAL: [], WARNING: [] };
  for (const r of rows) {
    const lvl = r.alert_level;
    if (grouped[lvl]) grouped[lvl].push(r);
  }
  return { companyId, days: d, grouped, rows };
}

async function runDailyExpiry() {
  const { rows } = await pool.query(`SELECT * FROM expire_lots_daily()`);
  const row = rows[0] || {};
  const expiredCount = row.expired_count != null ? Number(row.expired_count) : 0;
  const skusAffected = Array.isArray(row.skus_affected) ? row.skus_affected : [];
  if (expiredCount > 0) {
    console.log(`[lots] Lotes expirados hoy: ${expiredCount} | SKUs: ${skusAffected.join(", ") || "—"}`);
  }
  return { expiredCount, skusAffected };
}

module.exports = {
  createLot,
  getLotsBySku,
  dispatchFromLot,
  getExpiryAlerts,
  runDailyExpiry,
};
