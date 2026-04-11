"use strict";

const { pool } = require("../../db-postgres");

/**
 * @param {import('pg').PoolClient} client
 * @param {object} p
 */
/** Exportado para `lotService` (misma transacción que movimientos de lote). */
async function setMovementSessionVars(client, p) {
  const reason = p.reason != null ? String(p.reason) : "";
  const refId = p.referenceId != null ? String(p.referenceId) : "";
  const refType = p.referenceType != null ? String(p.referenceType) : "";
  const userId = p.userId != null ? String(p.userId) : "";
  const notes = p.notes != null ? String(p.notes) : "";
  await client.query(`SELECT set_config('app.movement_reason', $1, true)`, [reason]);
  await client.query(`SELECT set_config('app.reference_id', $1, true)`, [refId]);
  await client.query(`SELECT set_config('app.reference_type', $1, true)`, [refType]);
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
  await client.query(`SELECT set_config('app.movement_notes', $1, true)`, [notes]);
  await client.query(`SELECT set_config('app.notes', $1, true)`, [notes]);
}

/**
 * adjustStock — set_config ×5 + UPDATE/INSERT bin_stock (trigger de auditoría).
 */
async function adjustStock({
  binId,
  sku,
  deltaAvailable,
  deltaReserved,
  reason,
  referenceId,
  referenceType,
  userId,
  notes,
}) {
  if (!binId || !Number.isFinite(Number(binId)) || Number(binId) <= 0) {
    throw Object.assign(new Error("bin_id inválido"), { code: "INVALID_BIN" });
  }
  const skuStr = String(sku || "").trim();
  if (!skuStr) {
    throw Object.assign(new Error("sku requerido"), { code: "INVALID_SKU" });
  }
  const da = Number(deltaAvailable) || 0;
  const dr = Number(deltaReserved) || 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setMovementSessionVars(client, {
      reason,
      referenceId,
      referenceType,
      userId,
      notes,
    });

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
        throw Object.assign(new Error("Stock insuficiente o bin/SKU inexistente"), {
          code: "INVALID_ADJUSTMENT",
        });
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
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Cantidades no pueden quedar negativas"), {
          code: "NEGATIVE_STOCK",
        });
      }
    }

    await client.query("COMMIT");
    return {
      success: true,
      newQtyAvailable: Number(row.qty_available),
      newQtyReserved: Number(row.qty_reserved),
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

async function reserveStock({ sku, quantity, referenceId, referenceType, userId }) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    throw Object.assign(new Error("quantity inválida"), { code: "INVALID_QUANTITY" });
  }

  const { rows: candidates } = await pool.query(
    `SELECT bs.bin_id, bs.qty_available::numeric AS qty_available
     FROM bin_stock bs
     JOIN warehouse_bins wb ON wb.id = bs.bin_id
     WHERE bs.producto_sku = $1 AND bs.qty_available >= $2
     ORDER BY wb.is_primary DESC, bs.qty_available DESC
     LIMIT 1`,
    [sku, q]
  );

  if (candidates.length === 0) {
    const { rows: sumRow } = await pool.query(
      `SELECT COALESCE(SUM(qty_available), 0)::numeric AS available
       FROM bin_stock WHERE producto_sku = $1`,
      [sku]
    );
    const available = Number(sumRow[0]?.available || 0);
    throw Object.assign(new Error("INSUFFICIENT_STOCK"), {
      code: "INSUFFICIENT_STOCK",
      available,
      requested: q,
    });
  }

  const binId = candidates[0].bin_id;
  const out = await adjustStock({
    binId,
    sku,
    deltaAvailable: -q,
    deltaReserved: q,
    reason: "RESERVATION",
    referenceId,
    referenceType,
    userId,
    notes: null,
  });

  try {
    const { rows: prodRows } = await pool.query(
      `SELECT COALESCE(requires_lot_tracking, FALSE) AS r FROM products WHERE sku = $1`,
      [String(sku || "").trim()]
    );
    if (prodRows[0]?.r === true) {
      console.warn(
        `[wms] SKU ${String(sku).trim()} requiere control de lote. ` +
          `Confirmar lote antes del despacho físico vía POST /api/lots/dispatch`
      );
    }
  } catch (e) {
    if (e && e.code === "42703") {
      /* columna requires_lot_tracking ausente en products hasta migración lot-management */
    } else {
      console.warn("[wms] reserveStock lot-tracking check:", e.message || e);
    }
  }

  return out;
}

async function releaseReservation({ sku, quantity, referenceId, userId }) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    throw Object.assign(new Error("quantity inválida"), { code: "INVALID_QUANTITY" });
  }

  let binId;
  if (referenceId != null && String(referenceId).trim() !== "") {
    const ref = String(referenceId).trim();
    const { rows: refRows } = await pool.query(
      `SELECT bin_id FROM stock_movements_audit
       WHERE producto_sku = $1 AND reason = 'RESERVATION' AND reference_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [sku, ref]
    );
    binId = refRows[0]?.bin_id;
  }
  if (!binId) {
    const { rows: fb } = await pool.query(
      `SELECT bs.bin_id
       FROM bin_stock bs
       WHERE bs.producto_sku = $1 AND bs.qty_reserved >= $2
       ORDER BY bs.qty_reserved DESC
       LIMIT 1`,
      [sku, q]
    );
    binId = fb[0]?.bin_id;
  }

  if (!binId) {
    throw Object.assign(new Error("No hay reserva liberable para este SKU/referencia"), {
      code: "RELEASE_NOT_FOUND",
    });
  }

  return adjustStock({
    binId,
    sku,
    deltaAvailable: q,
    deltaReserved: -q,
    reason: "RESERVATION_CANCEL",
    referenceId,
    referenceType: null,
    userId,
    notes: null,
  });
}

async function getStockBySku(sku) {
  const { rows } = await pool.query(`SELECT * FROM v_stock_by_sku WHERE producto_sku = $1`, [sku]);
  return rows[0] || null;
}

const PICKING_LIST_MAX_SKUS = 200;

/**
 * Rutas de picking desde `v_picking_route` (orden serpentín: warehouse_id, pick_sort_order).
 * Enriquece columnas no incluidas en la vista vía JOIN (sin duplicar la lógica de la vista en SQL).
 * @param {string[]} skus
 * @param {{ orderId?: number|string|null }} [options]
 */
async function getPickingList(skus, options = {}) {
  if (!Array.isArray(skus) || skus.length === 0) {
    throw new Error("skus debe ser un array no vacío");
  }
  const clean = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
  if (clean.length === 0) {
    throw new Error("skus debe ser un array no vacío");
  }

  const inputCount = clean.length;
  const safeSkus = clean.slice(0, PICKING_LIST_MAX_SKUS);
  const warning =
    inputCount > PICKING_LIST_MAX_SKUS
      ? `Se procesaron ${PICKING_LIST_MAX_SKUS} de ${inputCount} SKUs solicitados`
      : undefined;

  const { rows } = await pool.query(
    `SELECT
       vr.producto_sku,
       p.descripcion,
       bs.qty_available,
       bs.qty_reserved,
       vr.bin_code,
       wb.level,
       ws.shelf_code,
       ws.shelf_number,
       wa.aisle_code,
       wa.aisle_number,
       vr.warehouse_code,
       vr.warehouse_id,
       vr.pick_sort_order
     FROM v_picking_route vr
     JOIN bin_stock bs ON bs.bin_id = vr.bin_id AND bs.producto_sku = vr.producto_sku
     JOIN productos p ON p.sku = vr.producto_sku
     JOIN warehouse_bins wb ON wb.id = vr.bin_id
     JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
     JOIN warehouse_aisles wa ON wa.id = ws.aisle_id
     WHERE vr.producto_sku = ANY($1::text[])
     ORDER BY vr.warehouse_id, vr.pick_sort_order`,
    [safeSkus]
  );

  const foundSkus = new Set(rows.map((r) => r.producto_sku));
  const missing = safeSkus.filter((s) => !foundSkus.has(s));

  const warehouses = {};
  for (const row of rows) {
    const wh = row.warehouse_code != null && String(row.warehouse_code).trim() !== "" ? String(row.warehouse_code) : "_";
    if (!warehouses[wh]) warehouses[wh] = [];
    warehouses[wh].push({
      sku: row.producto_sku,
      descripcion: row.descripcion,
      bin_code: row.bin_code,
      aisle: row.aisle_code,
      shelf: row.shelf_code,
      level: row.level != null ? Number(row.level) : null,
      qty_available: Number(row.qty_available),
      qty_reserved: Number(row.qty_reserved),
      pick_sort_order: Number(row.pick_sort_order),
    });
  }

  const out = {
    warehouses,
    total_locations: rows.length,
    missing_stock: missing,
  };
  if (warning) out.warning = warning;
  const oid = options.orderId;
  if (oid != null && String(oid).trim() !== "") {
    const n = Number(oid);
    if (Number.isFinite(n) && n > 0) out.order = n;
  }
  return out;
}

async function getMovementHistory({ sku, binId, fromDate, toDate, page, pageSize }) {
  const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 100);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (p - 1) * ps;

  const cond = [`producto_sku = $1`];
  const params = [sku];
  let i = 2;
  if (binId != null && binId !== "") {
    cond.push(`bin_id = $${i++}`);
    params.push(Number(binId));
  }
  if (fromDate) {
    cond.push(`created_at >= $${i++}::date`);
    params.push(fromDate);
  }
  if (toDate) {
    cond.push(`created_at < ($${i++}::date + interval '1 day')`);
    params.push(toDate);
  }

  const where = `WHERE ${cond.join(" AND ")}`;
  const countSql = `SELECT COUNT(*)::bigint AS c FROM stock_movements_audit ${where}`;
  const limIdx = i;
  const offIdx = i + 1;
  const dataSql = `SELECT * FROM stock_movements_audit ${where}
    ORDER BY id DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  const dataParams = [...params, ps, offset];

  const [{ rows: cr }, { rows }] = await Promise.all([
    pool.query(countSql, params),
    pool.query(dataSql, dataParams),
  ]);

  return {
    rows,
    total: Number(cr[0]?.c || 0),
    page: p,
    pageSize: ps,
  };
}

async function getBinByCode(binCode) {
  const { rows } = await pool.query(
    `SELECT
       wb.id AS bin_id,
       wb.bin_code,
       wb.level,
       wb.is_primary,
       wb.max_weight_kg,
       wb.max_volume_cbm,
       wb.notes AS bin_notes,
       wb.created_at AS bin_created_at,
       wb.updated_at AS bin_updated_at,
       ws.id AS shelf_id,
       ws.shelf_code,
       ws.shelf_number,
       wa.id AS aisle_id,
       wa.aisle_code,
       wa.aisle_number,
       w.id AS warehouse_id,
       w.code AS warehouse_code,
       w.name AS warehouse_name,
       w.company_id
     FROM warehouse_bins wb
     JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
     JOIN warehouse_aisles wa ON wa.id = ws.aisle_id
     JOIN warehouses w ON w.id = wa.warehouse_id
     WHERE wb.bin_code = $1`,
    [binCode]
  );
  return rows[0] || null;
}

async function createBin({ shelfId, level, maxWeightKg, maxVolumeCbm, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO warehouse_bins (shelf_id, level, max_weight_kg, max_volume_cbm, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [shelfId, level, maxWeightKg ?? null, maxVolumeCbm ?? null, notes ?? null]
  );
  return rows[0] || null;
}

module.exports = {
  setMovementSessionVars,
  /** Alias documentado (conteo cíclico y otros flujos): mismo comportamiento que setMovementSessionVars. */
  setMovementContext: setMovementSessionVars,
  adjustStock,
  reserveStock,
  releaseReservation,
  getStockBySku,
  getPickingList,
  getMovementHistory,
  getBinByCode,
  createBin,
};
