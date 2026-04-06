"use strict";

const { pool } = require("../../db-postgres");

/**
 * Replica el patrón de sesión del trigger audit_bin_stock (sin tocar wmsService.js).
 * Debe llamarse en la misma transacción y antes de cada UPDATE en bin_stock.
 */
async function setMovementContext(client, ctx) {
  const reason = ctx.reason != null ? String(ctx.reason) : "";
  const refId = ctx.referenceId != null ? String(ctx.referenceId) : "";
  const refType = ctx.referenceType != null ? String(ctx.referenceType) : "";
  const userId = ctx.userId != null ? String(ctx.userId) : "";
  const notes = ctx.notes != null ? String(ctx.notes) : "";
  await client.query(`SELECT set_config('app.movement_reason', $1, true)`, [reason]);
  await client.query(`SELECT set_config('app.reference_id', $1, true)`, [refId]);
  await client.query(`SELECT set_config('app.reference_type', $1, true)`, [refType]);
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
  await client.query(`SELECT set_config('app.movement_notes', $1, true)`, [notes]);
  await client.query(`SELECT set_config('app.notes', $1, true)`, [notes]);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

/**
 * Líneas de pedido ML → { sku, quantity } con merge por SKU (misma lógica que ml-payload-extract).
 */
function mapOrderItemsForWms(order) {
  const lines = order && order.order_items;
  if (!Array.isArray(lines)) return [];
  const merged = new Map();
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const item = line.item && typeof line.item === "object" ? line.item : {};
    const skuRaw = firstNonEmpty(
      line.seller_sku,
      item.seller_sku,
      line.seller_custom_field,
      item.seller_custom_field,
      item.id != null ? String(item.id) : null,
      line.item_id != null ? String(line.item_id) : null
    );
    const sku = skuRaw != null ? String(skuRaw).trim() : "";
    const quantity = Number(line.quantity) || 0;
    if (!sku || quantity <= 0) continue;
    merged.set(sku, (merged.get(sku) || 0) + quantity);
  }
  return Array.from(merged.entries()).map(([sku, quantity]) => ({ sku, quantity }));
}

const SELECT_BIN_FOR_RESERVE = `
  SELECT
    bs.bin_id,
    bs.qty_available
  FROM bin_stock bs
  JOIN warehouse_bins wb ON wb.id = bs.bin_id
  JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
  JOIN warehouse_aisles wa ON wa.id = ws.aisle_id
  JOIN warehouses w ON w.id = wa.warehouse_id
  WHERE bs.producto_sku = $1
    AND bs.qty_available >= $2
    AND w.is_active = TRUE
  ORDER BY
    wb.is_primary DESC,
    bs.qty_available DESC
  LIMIT 1
  FOR UPDATE OF bs
`;

async function reserveForOrder({ mlOrderId, mlResourceUrl, items, userId }) {
  const oid = Number(mlOrderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    return { success: false, reason: "BAD_ORDER_ID", mlOrderId };
  }
  const merged = Array.isArray(items) ? mergeItems(items) : [];
  if (merged.length === 0) {
    return { success: false, reason: "NO_ITEMS", mlOrderId: oid };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [String(oid)]);

    const { rows: existing } = await client.query(
      `SELECT id FROM ml_order_reservations
       WHERE ml_order_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [oid]
    );
    if (existing.length > 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "ALREADY_RESERVED", mlOrderId: oid };
    }

    const shortages = [];
    const selections = [];

    for (const { sku, quantity } of merged) {
      const { rows: prod } = await client.query(`SELECT 1 FROM productos WHERE sku = $1 LIMIT 1`, [
        sku,
      ]);
      if (prod.length === 0) {
        const { rows: sumRow } = await client.query(
          `SELECT COALESCE(SUM(qty_available), 0)::numeric AS available
           FROM bin_stock WHERE producto_sku = $1`,
          [sku]
        );
        shortages.push({
          sku,
          available: Number(sumRow[0]?.available || 0),
          requested: quantity,
          reason: "NO_PRODUCTO_LOCAL",
        });
        continue;
      }

      const { rows: binRows } = await client.query(SELECT_BIN_FOR_RESERVE, [sku, quantity]);
      if (binRows.length === 0) {
        const { rows: sumRow } = await client.query(
          `SELECT COALESCE(SUM(qty_available), 0)::numeric AS available
           FROM bin_stock WHERE producto_sku = $1`,
          [sku]
        );
        shortages.push({
          sku,
          available: Number(sumRow[0]?.available || 0),
          requested: quantity,
        });
        continue;
      }
      selections.push({
        sku,
        quantity,
        binId: binRows[0].bin_id,
      });
    }

    if (shortages.length > 0) {
      await client.query("ROLLBACK");
      return { success: false, code: "INSUFFICIENT_STOCK", shortages };
    }

    const resourceUrl = mlResourceUrl != null ? String(mlResourceUrl) : "";

    for (const sel of selections) {
      await setMovementContext(client, {
        reason: "RESERVATION",
        referenceId: String(oid),
        referenceType: "ml_order",
        userId,
        notes: resourceUrl,
      });
      const up = await client.query(
        `UPDATE bin_stock
         SET qty_available = qty_available - $1,
             qty_reserved = qty_reserved + $1
         WHERE bin_id = $2 AND producto_sku = $3
           AND qty_available >= $1
         RETURNING id`,
        [sel.quantity, sel.binId, sel.sku]
      );
      if (up.rowCount === 0) {
        await client.query("ROLLBACK");
        return {
          success: false,
          code: "INSUFFICIENT_STOCK",
          shortages: [{ sku: sel.sku, available: 0, requested: sel.quantity, reason: "RACE" }],
        };
      }
      await client.query(
        `INSERT INTO ml_order_reservations
          (ml_order_id, ml_resource_url, producto_sku, bin_id, qty_reserved)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ml_order_id, producto_sku, bin_id) DO NOTHING`,
        [oid, resourceUrl || null, sel.sku, sel.binId, sel.quantity]
      );
    }

    await client.query("COMMIT");
    return { success: true, mlOrderId: oid, itemsReserved: selections.length };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

function mergeItems(items) {
  const m = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const sku = String(it.sku || "").trim();
    const q = Number(it.quantity) || 0;
    if (!sku || q <= 0) continue;
    m.set(sku, (m.get(sku) || 0) + q);
  }
  return Array.from(m.entries()).map(([sku, quantity]) => ({ sku, quantity }));
}

async function commitReservation({ mlOrderId, userId }) {
  const oid = Number(mlOrderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    return { success: false, reason: "BAD_ORDER_ID", mlOrderId };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [String(oid)]);

    const { rows: rowsRes } = await client.query(
      `SELECT id, producto_sku, bin_id, qty_reserved
       FROM ml_order_reservations
       WHERE ml_order_id = $1 AND status = 'ACTIVE'
       FOR UPDATE`,
      [oid]
    );
    if (rowsRes.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "NO_ACTIVE_RESERVATION", mlOrderId: oid };
    }

    for (const r of rowsRes) {
      await setMovementContext(client, {
        reason: "SALE_DISPATCH",
        referenceId: String(oid),
        referenceType: "ml_order",
        userId,
        notes: "",
      });
      await client.query(
        `UPDATE bin_stock
         SET qty_reserved = qty_reserved - $1
         WHERE bin_id = $2 AND producto_sku = $3
           AND qty_reserved >= $1`,
        [r.qty_reserved, r.bin_id, r.producto_sku]
      );
    }

    await client.query(
      `UPDATE ml_order_reservations
       SET status = 'COMMITTED', resolved_at = now()
       WHERE ml_order_id = $1 AND status = 'ACTIVE'`,
      [oid]
    );

    await client.query("COMMIT");
    return { success: true, mlOrderId: oid, itemsCommitted: rowsRes.length };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function releaseReservation({ mlOrderId, userId }) {
  const oid = Number(mlOrderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    return { success: false, reason: "BAD_ORDER_ID", mlOrderId };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [String(oid)]);

    const { rows: rowsRes } = await client.query(
      `SELECT id, producto_sku, bin_id, qty_reserved
       FROM ml_order_reservations
       WHERE ml_order_id = $1 AND status = 'ACTIVE'
       FOR UPDATE`,
      [oid]
    );
    if (rowsRes.length === 0) {
      await client.query("ROLLBACK");
      return { success: false, reason: "NO_ACTIVE_RESERVATION", mlOrderId: oid };
    }

    for (const r of rowsRes) {
      await setMovementContext(client, {
        reason: "RESERVATION_CANCEL",
        referenceId: String(oid),
        referenceType: "ml_order",
        userId,
        notes: "",
      });
      await client.query(
        `UPDATE bin_stock
         SET qty_available = qty_available + $1,
             qty_reserved = qty_reserved - $1
         WHERE bin_id = $2 AND producto_sku = $3
           AND qty_reserved >= $1`,
        [r.qty_reserved, r.bin_id, r.producto_sku]
      );
    }

    await client.query(
      `UPDATE ml_order_reservations
       SET status = 'RELEASED', resolved_at = now()
       WHERE ml_order_id = $1 AND status = 'ACTIVE'`,
      [oid]
    );

    await client.query("COMMIT");
    return { success: true, mlOrderId: oid, itemsReleased: rowsRes.length };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  reserveForOrder,
  commitReservation,
  releaseReservation,
  mapOrderItemsForWms,
};
