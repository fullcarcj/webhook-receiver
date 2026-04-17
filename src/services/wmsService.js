"use strict";

const { pool } = require("../../db-postgres");

/**
 * @param {import("pg").PoolClient} client
 * @param {object} p
 */
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

/** Alias documentado (reservas ML, conteo, lotes). */
const setMovementContext = setMovementSessionVars;

function normalizeReasonForSql(reason) {
  const r = reason != null ? String(reason).trim() : "";
  if (!r) return "ADJUSTMENT_UP";
  if (r === "MANUAL_ADJUSTMENT" || r === "MANUAL") return "ADJUSTMENT_UP";
  return r;
}

function mapAdjustStockSqlError(e, binId, sku) {
  const msg = e && e.message ? String(e.message) : "";
  if (msg.includes("unique") || msg.includes("duplicate")) {
    return Object.assign(new Error("Conflicto al ajustar stock"), { code: "CONFLICT", status: 409 });
  }
  if (msg.includes("foreign key") || msg.includes("violates foreign key")) {
    return Object.assign(new Error("SKU o bin inexistente en catálogo"), { code: "INVALID_SKU_OR_BIN", status: 400 });
  }
  console.warn("[wms] adjust_stock SQL:", msg, binId, sku);
  return e;
}

/**
 * Ajuste vía función SQL `adjust_stock` (UPSERT + GREATEST).
 * @param {object} p
 */
async function adjustStockSql(p) {
  const binId = Number(p.binId);
  const sku = String(p.sku || p.product_sku || "").trim();
  const delta = Number(p.delta);
  if (!Number.isFinite(binId) || binId <= 0) {
    throw Object.assign(new Error("bin_id inválido"), { code: "INVALID_BIN", status: 400 });
  }
  if (!sku) {
    throw Object.assign(new Error("product_sku requerido"), { code: "INVALID_SKU", status: 400 });
  }
  if (!Number.isFinite(delta) || delta === 0) {
    throw Object.assign(new Error("delta distinto de cero requerido"), { code: "INVALID_DELTA", status: 400 });
  }
  const reason = normalizeReasonForSql(p.reason);
  const refType = p.referenceType != null ? String(p.referenceType) : "";
  const refId = p.referenceId != null ? String(p.referenceId) : "";
  const userId = p.userId != null && p.userId !== "" ? Number(p.userId) : null;
  const notes = p.notes != null ? String(p.notes) : null;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM adjust_stock($1::bigint, $2::text, $3::numeric, $4::text, $5::text, $6::text, $7::int, $8::text)`,
      [binId, sku, delta, reason, refType || null, refId || null, Number.isFinite(userId) ? userId : null, notes]
    );
    return rows[0] || null;
  } catch (e) {
    throw mapAdjustStockSqlError(e, binId, sku);
  }
}

/**
 * Ajuste manual con deltas disponible/reservado (compatibilidad; transacción + trigger).
 */
async function adjustStockDeltas({
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
       WHERE bin_id = $3 AND product_sku = $4
       RETURNING qty_available, qty_reserved, qty_total`,
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
        `INSERT INTO bin_stock (bin_id, product_sku, qty_available, qty_reserved)
         VALUES ($1, $2, $3, $4)
         RETURNING qty_available, qty_reserved, qty_total`,
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
      qty_total: row.qty_total != null ? Number(row.qty_total) : undefined,
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
 * `adjustStock`: si viene `delta` → `adjust_stock` en BD; si no, deltas legacy.
 * Post-commit: dispara sync WMS→ML en setImmediate (no bloquea respuesta).
 */
async function adjustStock(body) {
  let result;
  if (body.delta != null && body.delta !== "") {
    result = await adjustStockSql({
      binId: body.binId != null ? body.binId : body.bin_id,
      sku: body.sku || body.product_sku,
      delta: body.delta,
      reason: body.reason,
      referenceType: body.referenceType || body.reference_type,
      referenceId: body.referenceId || body.reference_id,
      userId: body.userId != null ? body.userId : body.user_id,
      notes: body.notes,
    });
  } else {
    result = await adjustStockDeltas({
      binId: body.binId != null ? body.binId : body.bin_id,
      sku: body.sku || body.product_sku,
      deltaAvailable: body.deltaAvailable != null ? body.deltaAvailable : body.delta_available,
      deltaReserved: body.deltaReserved != null ? body.deltaReserved : body.delta_reserved,
      reason: body.reason,
      referenceId: body.referenceId || body.reference_id,
      referenceType: body.referenceType || body.reference_type,
      userId: body.userId != null ? body.userId : body.user_id,
      notes: body.notes,
    });
  }

  // ── Hook WMS→ML: post-commit, no bloquea ─────────────────────────────
  const sku = String(body.sku || body.product_sku || "").trim();
  if (sku) {
    setImmediate(async () => {
      try {
        const { syncMlStockForSku } = require("./mlPublicationsService");
        await syncMlStockForSku(sku, { updatedBy: "wms_adjust" });
      } catch (err) {
        console.error("[WMS→ML] adjustStock sync error:", err.message);
      }
    });
  }

  return result;
}

async function reserveStockSql({ binId, sku, qty, referenceType, referenceId, userId }) {
  const b = Number(binId);
  const q = Number(qty);
  const skuStr = String(sku || "").trim();
  if (!Number.isFinite(b) || b <= 0) {
    throw Object.assign(new Error("bin_id inválido"), { code: "INVALID_BIN", status: 400 });
  }
  if (!skuStr) {
    throw Object.assign(new Error("product_sku requerido"), { code: "INVALID_SKU", status: 400 });
  }
  if (!Number.isFinite(q) || q <= 0) {
    throw Object.assign(new Error("qty inválida"), { code: "INVALID_QUANTITY", status: 400 });
  }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM reserve_stock($1::bigint, $2::text, $3::numeric, $4::text, $5::text, $6::int)`,
      [
        b,
        skuStr,
        q,
        referenceType != null ? String(referenceType) : null,
        referenceId != null ? String(referenceId) : null,
        userId != null && userId !== "" ? Number(userId) : null,
      ]
    );
    return rows[0];
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (msg.includes("INSUFFICIENT_STOCK")) {
      const { rows } = await pool.query(
        `SELECT qty_available FROM bin_stock WHERE bin_id = $1 AND product_sku = $2`,
        [b, skuStr]
      );
      const available = rows[0] != null ? Number(rows[0].qty_available) : 0;
      throw Object.assign(new Error("Stock insuficiente"), {
        code: "INSUFFICIENT_STOCK",
        status: 409,
        available,
        requested: q,
      });
    }
    throw e;
  }
}

/**
 * Reserva: con `binId` usa `reserve_stock`; sin bin elige bin con más disponible (compat API anterior).
 */
async function reserveStock({ binId, bin_id, sku, product_sku, quantity, qty, referenceId, reference_id, referenceType, reference_type, userId, user_id }) {
  const skuStr = String(sku || product_sku || "").trim();
  const q = Number(qty != null ? qty : quantity);
  const bIn = binId != null ? binId : bin_id;

  if (bIn != null && String(bIn).trim() !== "") {
    const row = await reserveStockSql({
      binId: bIn,
      sku: skuStr,
      qty: q,
      referenceType: referenceType || reference_type,
      referenceId: referenceId || reference_id,
      userId: userId != null ? userId : user_id,
    });
    return { success: true, row, newQtyAvailable: Number(row.qty_available), newQtyReserved: Number(row.qty_reserved) };
  }

  if (!Number.isFinite(q) || q <= 0) {
    throw Object.assign(new Error("quantity inválida"), { code: "INVALID_QUANTITY" });
  }

  const { rows: candidates } = await pool.query(
    `SELECT bs.bin_id, bs.qty_available::numeric AS qty_available
     FROM bin_stock bs
     JOIN warehouse_bins wb ON wb.id = bs.bin_id
     WHERE bs.product_sku = $1 AND bs.qty_available >= $2
     ORDER BY wb.is_primary DESC NULLS LAST, bs.qty_available DESC
     LIMIT 1`,
    [skuStr, q]
  );

  if (candidates.length === 0) {
    const { rows: sumRow } = await pool.query(
      `SELECT COALESCE(SUM(qty_available), 0)::numeric AS available
       FROM bin_stock WHERE product_sku = $1`,
      [skuStr]
    );
    const available = Number(sumRow[0]?.available || 0);
    throw Object.assign(new Error("INSUFFICIENT_STOCK"), {
      code: "INSUFFICIENT_STOCK",
      available,
      requested: q,
    });
  }

  const pickedBin = candidates[0].bin_id;
  const row = await reserveStockSql({
    binId: pickedBin,
    sku: skuStr,
    qty: q,
    referenceType: referenceType || reference_type,
    referenceId: referenceId || reference_id,
    userId: userId != null ? userId : user_id,
  });

  try {
    const { rows: prodRows } = await pool.query(
      `SELECT COALESCE(requires_lot_tracking, FALSE) AS r FROM products WHERE sku = $1`,
      [skuStr]
    );
    if (prodRows[0]?.r === true) {
      console.warn(
        `[wms] SKU ${skuStr} requiere control de lote. Confirmar lote antes del despacho físico vía POST /api/lots/dispatch`
      );
    }
  } catch (e) {
    if (e && e.code === "42703") {
      /* columna opcional */
    } else {
      console.warn("[wms] reserveStock lot-tracking check:", e.message || e);
    }
  }

  return {
    success: true,
    bin_id: pickedBin,
    row,
    newQtyAvailable: Number(row.qty_available),
    newQtyReserved: Number(row.qty_reserved),
  };
}

async function commitBinReservationSql({ binId, sku, qty, referenceType, referenceId, userId }) {
  const b = Number(binId);
  const q = Number(qty);
  const skuStr = String(sku || "").trim();
  let result;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM commit_reservation($1::bigint, $2::text, $3::numeric, $4::text, $5::text, $6::int)`,
      [
        b,
        skuStr,
        q,
        referenceType != null ? String(referenceType) : null,
        referenceId != null ? String(referenceId) : null,
        userId != null && userId !== "" ? Number(userId) : null,
      ]
    );
    result = rows[0];
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (msg.includes("INSUFFICIENT_RESERVATION")) {
      throw Object.assign(new Error("Reserva insuficiente"), {
        code: "INSUFFICIENT_RESERVATION",
        status: 409,
      });
    }
    throw e;
  }

  // ── Hook WMS→ML: despacho → stock baja → sync ML post-commit ─────────
  if (skuStr) {
    setImmediate(async () => {
      try {
        const { syncMlStockForSku } = require("./mlPublicationsService");
        await syncMlStockForSku(skuStr, { updatedBy: "wms_commit" });
      } catch (err) {
        console.error("[WMS→ML] commitBinReservationSql sync error:", err.message);
      }
    });
  }

  return result;
}

async function releaseBinReservationSql({ binId, sku, qty, referenceType, referenceId, userId }) {
  const b = Number(binId);
  const q = Number(qty);
  const skuStr = String(sku || "").trim();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM release_reservation($1::bigint, $2::text, $3::numeric, $4::text, $5::text, $6::int)`,
      [
        b,
        skuStr,
        q,
        referenceType != null ? String(referenceType) : null,
        referenceId != null ? String(referenceId) : null,
        userId != null && userId !== "" ? Number(userId) : null,
      ]
    );
    return rows[0];
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (msg.includes("INSUFFICIENT_RESERVATION")) {
      throw Object.assign(new Error("Reserva insuficiente"), {
        code: "INSUFFICIENT_RESERVATION",
        status: 409,
      });
    }
    throw e;
  }
}

async function releaseReservation({ binId, bin_id, sku, product_sku, quantity, qty, referenceId, reference_id, referenceType, reference_type, userId, user_id }) {
  const skuStr = String(sku || product_sku || "").trim();
  const q = Number(qty != null ? qty : quantity);
  const bIn = binId != null ? binId : bin_id;

  if (bIn != null && String(bIn).trim() !== "") {
    const row = await releaseBinReservationSql({
      binId: bIn,
      sku: skuStr,
      qty: q,
      referenceType: referenceType || reference_type,
      referenceId: referenceId || reference_id,
      userId: userId != null ? userId : user_id,
    });
    return { success: true, row, newQtyAvailable: Number(row.qty_available), newQtyReserved: Number(row.qty_reserved) };
  }

  if (!Number.isFinite(q) || q <= 0) {
    throw Object.assign(new Error("quantity inválida"), { code: "INVALID_QUANTITY" });
  }

  let binIdResolved;
  const ref = referenceId != null ? referenceId : reference_id;
  if (ref != null && String(ref).trim() !== "") {
    const { rows: refRows } = await pool.query(
      `SELECT bin_id FROM stock_movements_audit
       WHERE product_sku = $1 AND reason::text = 'RESERVATION' AND reference_id = $2
       ORDER BY id DESC
       LIMIT 1`,
      [skuStr, String(ref).trim()]
    );
    binIdResolved = refRows[0]?.bin_id;
  }
  if (!binIdResolved) {
    const { rows: fb } = await pool.query(
      `SELECT bs.bin_id
       FROM bin_stock bs
       WHERE bs.product_sku = $1 AND bs.qty_reserved >= $2
       ORDER BY bs.qty_reserved DESC
       LIMIT 1`,
      [skuStr, q]
    );
    binIdResolved = fb[0]?.bin_id;
  }

  if (!binIdResolved) {
    throw Object.assign(new Error("No hay reserva liberable para este SKU/referencia"), {
      code: "RELEASE_NOT_FOUND",
      status: 404,
    });
  }

  const row = await releaseBinReservationSql({
    binId: binIdResolved,
    sku: skuStr,
    qty: q,
    referenceType: referenceType || reference_type,
    referenceId: ref,
    userId: userId != null ? userId : user_id,
  });
  return { success: true, bin_id: binIdResolved, row, newQtyAvailable: Number(row.qty_available), newQtyReserved: Number(row.qty_reserved) };
}

async function getStockBySku(sku, warehouseId) {
  const s = String(sku || "").trim();
  const params = [s];
  let wh = "";
  if (warehouseId != null && String(warehouseId).trim() !== "") {
    wh = " AND warehouse_id = $2";
    params.push(Number(warehouseId));
  }
  const { rows } = await pool.query(`SELECT * FROM v_stock_by_sku WHERE product_sku = $1${wh} ORDER BY warehouse_id`, params);
  return rows;
}

async function getStockByBin(binId) {
  const b = Number(binId);
  if (!Number.isFinite(b) || b <= 0) return [];
  const { rows } = await pool.query(
    `SELECT bs.*,
            COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
            COALESCE(p.precio_usd, p.unit_price_usd) AS precio_usd
     FROM bin_stock bs
     JOIN products p ON p.sku = bs.product_sku
     WHERE bs.bin_id = $1 AND bs.qty_total > 0
     ORDER BY bs.product_sku`,
    [b]
  );
  return rows;
}

const PICKING_LIST_MAX_SKUS = 200;

async function getPickingListBySkus(skus, options = {}) {
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
       vr.product_sku,
       COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
       bs.qty_available,
       bs.qty_reserved,
       vr.bin_code,
       wb.level,
       vr.shelf_code,
       vr.shelf_number,
       vr.aisle_code,
       vr.aisle_number,
       w.code AS warehouse_code,
       vr.warehouse_id,
       vr.picking_order AS pick_sort_order
     FROM v_picking_route vr
     JOIN bin_stock bs ON bs.bin_id = vr.bin_id AND bs.product_sku = vr.product_sku
     JOIN products p ON p.sku = vr.product_sku
     JOIN warehouse_bins wb ON wb.id = vr.bin_id
     JOIN warehouses w ON w.id = vr.warehouse_id
     WHERE vr.product_sku = ANY($1::text[])
     ORDER BY vr.warehouse_id, vr.aisle_number, vr.picking_order, vr.shelf_number`,
    [safeSkus]
  );

  const foundSkus = new Set(rows.map((r) => r.product_sku));
  const missing = safeSkus.filter((s) => !foundSkus.has(s));

  const warehouses = {};
  for (const row of rows) {
    const wh = row.warehouse_code != null && String(row.warehouse_code).trim() !== "" ? String(row.warehouse_code) : "_";
    if (!warehouses[wh]) warehouses[wh] = [];
    warehouses[wh].push({
      sku: row.product_sku,
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

async function getPickingListForWarehouse({ warehouseId, skus }) {
  const wid = Number(warehouseId);
  if (!Number.isFinite(wid) || wid <= 0) {
    throw Object.assign(new Error("warehouse_id obligatorio"), { code: "INVALID_WAREHOUSE", status: 400 });
  }
  const clean =
    Array.isArray(skus) && skus.length > 0
      ? [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))].slice(0, PICKING_LIST_MAX_SKUS)
      : null;
  if (clean && clean.length > 0) {
    const { rows } = await pool.query(
      `SELECT vr.*, w.code AS warehouse_code
       FROM v_picking_route vr
       JOIN warehouses w ON w.id = vr.warehouse_id
       WHERE vr.warehouse_id = $1 AND vr.product_sku = ANY($2::text[])
       ORDER BY vr.aisle_number, vr.picking_order, vr.shelf_number`,
      [wid, clean]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT vr.*, w.code AS warehouse_code
     FROM v_picking_route vr
     JOIN warehouses w ON w.id = vr.warehouse_id
     WHERE vr.warehouse_id = $1
     ORDER BY vr.aisle_number, vr.picking_order, vr.shelf_number`,
    [wid]
  );
  return rows;
}

async function getMovementHistory({
  sku,
  binId,
  referenceType,
  referenceId,
  fromDate,
  toDate,
  page,
  pageSize,
  limit,
  offset,
}) {
  const cond = ["TRUE"];
  const params = [];
  let i = 1;
  if (sku != null && String(sku).trim() !== "") {
    cond.push(`product_sku = $${i++}`);
    params.push(String(sku).trim());
  }
  if (binId != null && binId !== "") {
    cond.push(`bin_id = $${i++}`);
    params.push(Number(binId));
  }
  if (referenceType != null && String(referenceType).trim() !== "") {
    cond.push(`reference_type = $${i++}`);
    params.push(String(referenceType).trim());
  }
  if (referenceId != null && String(referenceId).trim() !== "") {
    cond.push(`reference_id = $${i++}`);
    params.push(String(referenceId).trim());
  }
  if (fromDate) {
    cond.push(`created_at >= $${i++}::date`);
    params.push(fromDate);
  }
  if (toDate) {
    cond.push(`created_at < ($${i++}::date + interval '1 day')`);
    params.push(toDate);
  }

  const hasLimit = limit != null && String(limit).trim() !== "";
  const hasOffset = offset != null && String(offset).trim() !== "";
  const useOffset = hasLimit || hasOffset;
  let lim;
  let off;
  if (useOffset) {
    lim = Math.min(Math.max(parseInt(String(limit != null ? limit : 50), 10) || 50, 1), 200);
    off = Math.max(parseInt(String(offset != null ? offset : 0), 10) || 0, 0);
  } else {
    const ps = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 100);
    const p = Math.max(parseInt(page, 10) || 1, 1);
    lim = ps;
    off = (p - 1) * ps;
  }

  const where = `WHERE ${cond.join(" AND ")}`;
  const countSql = `SELECT COUNT(*)::bigint AS c FROM stock_movements_audit ${where}`;
  const limIdx = i;
  const offIdx = i + 1;
  const dataSql = `SELECT * FROM stock_movements_audit ${where}
    ORDER BY id DESC
    LIMIT $${limIdx} OFFSET $${offIdx}`;
  const dataParams = [...params, lim, off];

  const [{ rows: cr }, { rows }] = await Promise.all([
    pool.query(countSql, params),
    pool.query(dataSql, dataParams),
  ]);

  const total = Number(cr[0]?.c || 0);
  if (useOffset) {
    return { movements: rows, total };
  }
  const p = Math.floor(off / lim) + 1;
  return {
    rows,
    movements: rows,
    total,
    page: p,
    pageSize: lim,
  };
}

async function listWarehouses(companyId) {
  const cid = companyId != null ? Number(companyId) : 1;
  const { rows } = await pool.query(
    `SELECT * FROM warehouses WHERE company_id = $1 ORDER BY is_default DESC NULLS LAST, name ASC`,
    [cid]
  );
  return rows;
}

async function listBins({ warehouseId, aisleId, status }) {
  const wid = Number(warehouseId);
  if (!Number.isFinite(wid) || wid <= 0) {
    throw Object.assign(new Error("warehouse_id inválido"), { code: "INVALID_WAREHOUSE", status: 400 });
  }
  const params = [wid];
  let extra = "";
  let idx = 2;
  if (aisleId != null && String(aisleId).trim() !== "") {
    extra += ` AND wa.id = $${idx++}`;
    params.push(Number(aisleId));
  }
  if (status != null && String(status).trim() !== "") {
    extra += ` AND wb.status = $${idx++}`;
    params.push(String(status).trim());
  }

  const { rows } = await pool.query(
    `SELECT
       wb.id,
       wb.shelf_id,
       wb.bin_code,
       wb.level,
       wb.capacity,
       wb.bin_type,
       wb.status,
       wb.notes,
       wb.created_at,
       wb.updated_at,
       wa.aisle_code,
       wa.aisle_number,
       ws.shelf_code,
       ws.shelf_number,
       w.name AS warehouse_name,
       COALESCE(SUM(bs.qty_available), 0)::numeric AS total_available
     FROM warehouse_bins wb
     JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
     JOIN warehouse_aisles wa ON wa.id = ws.aisle_id
     JOIN warehouses w ON w.id = wa.warehouse_id
     LEFT JOIN bin_stock bs ON bs.bin_id = wb.id
     WHERE w.id = $1${extra}
     GROUP BY wb.id, wa.aisle_code, wa.aisle_number, ws.shelf_code, ws.shelf_number, w.name
     ORDER BY wa.aisle_number, ws.shelf_number, wb.level`,
    params
  );
  return rows;
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

/**
 * KPIs agregados para dashboard WMS (bin_stock + inventory.stock_min por producto).
 * bin_stock vacío → ceros. Requiere tablas `products` e `inventory` (LEFT JOIN).
 */
async function getWmsInventorySummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(DISTINCT bs.product_sku)::bigint AS total_skus,
      COALESCE(SUM(bs.qty_available), 0)::numeric AS total_units,
      COUNT(*) FILTER (WHERE bs.qty_available = 0)::bigint AS stockout_count,
      COUNT(*) FILTER (
        WHERE bs.qty_available > 0
          AND inv.stock_min IS NOT NULL
          AND bs.qty_available <= inv.stock_min
      )::bigint AS low_stock_count
    FROM bin_stock bs
    LEFT JOIN products p ON p.sku = bs.product_sku
    LEFT JOIN inventory inv ON inv.product_id = p.id
  `);
  const r = rows[0] || {};
  return {
    total_skus: Number(r.total_skus || 0),
    total_units: Number(r.total_units || 0),
    stockout_count: Number(r.stockout_count || 0),
    low_stock_count: Number(r.low_stock_count || 0),
  };
}

module.exports = {
  setMovementSessionVars,
  setMovementContext,
  adjustStock,
  adjustStockSql,
  adjustStockDeltas,
  reserveStock,
  commitBinReservationSql,
  releaseBinReservationSql,
  releaseReservation,
  getStockBySku,
  getStockByBin,
  getPickingListForWarehouse,
  getPickingListBySkus,
  getMovementHistory,
  listWarehouses,
  listBins,
  getBinByCode,
  createBin,
  getWmsInventorySummary,
};
