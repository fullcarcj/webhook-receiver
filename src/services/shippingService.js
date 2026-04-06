"use strict";

const { pool } = require("../../db-postgres");

async function validateShippingData(shipmentId) {
  const { rows } = await pool.query(
    `SELECT
       l.id,
       l.producto_sku,
       COALESCE(l.shipping_category_id, p.shipping_category_id) AS cat_id,
       COALESCE(p.volume_cbm, sc.avg_volume_cbm)                AS volume_resolved,
       sc.rate_per_cbm,
       sc.min_charge_cbm,
       sc.is_active,
       sc.name AS category_name
     FROM import_shipment_lines l
     JOIN productos p ON p.sku = l.producto_sku
     LEFT JOIN shipping_categories sc
       ON sc.id = COALESCE(l.shipping_category_id, p.shipping_category_id)
     WHERE l.shipment_id = $1`,
    [shipmentId]
  );

  const errors = [];
  for (const row of rows) {
    if (!row.cat_id) {
      errors.push({ sku: row.producto_sku, reason: "Sin shipping_category_id asignada" });
      continue;
    }
    if (!row.is_active) {
      errors.push({ sku: row.producto_sku, reason: `Categoría "${row.category_name}" inactiva` });
      continue;
    }
    if (!row.volume_resolved || Number(row.volume_resolved) <= 0) {
      errors.push({
        sku: row.producto_sku,
        reason: "Sin volumen: ni volume_cbm en producto ni avg_volume_cbm en categoría",
      });
    }
    if (!row.rate_per_cbm || Number(row.rate_per_cbm) <= 0) {
      errors.push({ sku: row.producto_sku, reason: "rate_per_cbm inválido o cero en la categoría" });
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      code: "MISSING_SHIPPING_DATA",
      detail: `${errors.length} SKU(s) sin datos de envío completos`,
      errors,
    };
  }
  return { valid: true, lines: rows };
}

async function calculateFreightByCbm(shipmentId) {
  const validation = await validateShippingData(shipmentId);
  if (!validation.valid) {
    const err = new Error(validation.detail);
    err.code = validation.code;
    err.details = validation.errors;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: shipmentRows } = await client.query(
      `SELECT status FROM import_shipments WHERE id = $1 FOR UPDATE`,
      [shipmentId]
    );
    const shipment = shipmentRows[0];
    if (!shipment) throw new Error(`Shipment ${shipmentId} no encontrado`);
    if (["CLOSED", "CANCELLED"].includes(String(shipment.status || "").toUpperCase())) {
      throw new Error(`No se puede recalcular un shipment en estado ${shipment.status}`);
    }

    const { rows: lines } = await client.query(
      `SELECT
         l.id,
         l.quantity,
         l.producto_sku,
         COALESCE(l.shipping_category_id, p.shipping_category_id) AS cat_id,
         COALESCE(p.volume_cbm, sc.avg_volume_cbm)                AS volume_unit,
         sc.rate_per_cbm,
         sc.min_charge_cbm
       FROM import_shipment_lines l
       JOIN productos p ON p.sku = l.producto_sku
       JOIN shipping_categories sc
         ON sc.id = COALESCE(l.shipping_category_id, p.shipping_category_id)
       WHERE l.shipment_id = $1`,
      [shipmentId]
    );

    let totalFreight = 0;
    for (const line of lines) {
      const qty = Number(line.quantity);
      const volUnit = Number(line.volume_unit);
      const rate = Number(line.rate_per_cbm);
      const minCharge = Number(line.min_charge_cbm);

      const volTotalLine = volUnit * qty;
      const fleteReal = volTotalLine * rate;
      const fleteMinimo = minCharge * rate;
      const freightLine = Math.max(fleteReal, fleteMinimo);
      totalFreight += freightLine;

      await client.query(
        `UPDATE import_shipment_lines SET
           shipping_category_id = $1,
           volume_cbm_used      = $2,
           freight_line_usd     = $3,
           rate_snapshot_cbm    = $4,
           freight_source       = 'DYNAMIC_CBM'
         WHERE id = $5`,
        [line.cat_id, volTotalLine.toFixed(6), freightLine.toFixed(4), rate.toFixed(4), line.id]
      );
    }

    const { rowCount: deletedFreight } = await client.query(
      `DELETE FROM import_expenses
       WHERE shipment_id = $1 AND expense_type = 'FREIGHT'`,
      [shipmentId]
    );
    if (deletedFreight > 0) {
      console.log(
        "[shippingService] Eliminados %s registros FREIGHT manuales del shipment %s - reemplazados por cálculo dinámico CBM",
        deletedFreight,
        shipmentId
      );
    }

    await client.query("COMMIT");
    return {
      success: true,
      shipmentId,
      linesProcessed: lines.length,
      totalFreightUsd: Number(totalFreight.toFixed(4)),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function assignCategoryToProducts(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new Error("assignments debe ser un array no vacío");
  }
  if (assignments.length > 500) {
    throw new Error("Máximo 500 asignaciones por llamada. Usar el script bulk para más.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let updated = 0;
    const notFound = [];

    for (const a of assignments) {
      const { rowCount } = await client.query(
        `UPDATE productos SET
           shipping_category_id = $1,
           volume_cbm           = COALESCE($2, volume_cbm)
         WHERE sku = $3`,
        [a.shipping_category_id, a.volume_cbm || null, a.sku]
      );
      if (rowCount === 0) notFound.push(a.sku);
      else updated++;
    }
    await client.query("COMMIT");
    return { success: true, updated, notFound };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getUnassignedProducts({ page = 1, pageSize = 100 } = {}) {
  const limit = Math.min(parseInt(pageSize, 10) || 100, 500);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  const { rows } = await pool.query(
    `SELECT sku, descripcion, precio_usd, volume_cbm
     FROM productos
     WHERE shipping_category_id IS NULL
     ORDER BY descripcion
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: cntRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM productos WHERE shipping_category_id IS NULL`
  );
  return { products: rows, total: cntRows[0] ? Number(cntRows[0].total) : 0, page, pageSize: limit };
}

module.exports = {
  validateShippingData,
  calculateFreightByCbm,
  assignCategoryToProducts,
  getUnassignedProducts,
};

