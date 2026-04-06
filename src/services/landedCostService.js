"use strict";

const { pool } = require("../../db-postgres");
const { calculateFreightByCbm } = require("./shippingService");
const { getTodayRate, invalidateTodayRateCache } = require("./currencyService");

async function calculateLandedCost(shipmentId) {
  let client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pre-paso: flete dinámico si hay categorías asignadas.
    const { rows: hasRows } = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM import_shipment_lines l
       JOIN productos p ON p.sku = l.producto_sku
       WHERE l.shipment_id = $1
         AND COALESCE(l.shipping_category_id, p.shipping_category_id) IS NOT NULL`,
      [shipmentId]
    );
    const hasDynamic = hasRows[0] ? Number(hasRows[0].n) : 0;
    if (hasDynamic > 0) {
      await client.query('ROLLBACK');
      client.release();
      await calculateFreightByCbm(shipmentId); // maneja su propia transacción
      client = await pool.connect();
      await client.query('BEGIN');
    }

    const { rows: lineRows } = await client.query(
      `SELECT id, quantity, fob_line_usd, tariff_usd,
              allocated_expenses_usd, freight_line_usd
       FROM import_shipment_lines
       WHERE shipment_id = $1`,
      [shipmentId]
    );

    let totalLanded = 0;
    for (const line of lineRows) {
      const qty = Number(line.quantity || 0);
      const fob = Number(line.fob_line_usd || 0);
      const tariff = Number(line.tariff_usd || 0);
      const allocated = Number(line.allocated_expenses_usd || 0);
      const freightLine = Number(line.freight_line_usd || 0);
      const landedLine = fob + tariff + allocated + freightLine;
      const realUnitCost = qty > 0 ? landedLine / qty : 0;
      totalLanded += landedLine;

      await client.query(
        `UPDATE import_shipment_lines
         SET landed_cost_line_usd = $1,
             real_unit_cost_usd = $2
         WHERE id = $3`,
        [landedLine.toFixed(6), realUnitCost.toFixed(6), line.id]
      );
    }

    await client.query(
      `UPDATE import_shipments
       SET total_landed_cost_usd = $1
       WHERE id = $2`,
      [totalLanded.toFixed(6), shipmentId]
    );

    await client.query("COMMIT");
    return { ok: true, shipment_id: shipmentId, total_landed_cost_usd: Number(totalLanded.toFixed(6)) };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // noop
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  calculateLandedCost,
};

