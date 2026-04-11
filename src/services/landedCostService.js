"use strict";

const { pool } = require("../../db-postgres");

async function assertShipmentOpen(client, shipmentId) {
  const { rows } = await client.query(
    `SELECT id, status::text AS status FROM import_shipments WHERE id = $1`,
    [shipmentId]
  );
  if (!rows.length) {
    throw Object.assign(new Error("Shipment no encontrado"), { code: "NOT_FOUND", status: 404 });
  }
  const st = String(rows[0].status || "").toUpperCase();
  if (st === "CLOSED") {
    throw Object.assign(new Error("El shipment está cerrado"), { code: "SHIPMENT_CLOSED", status: 409 });
  }
  if (st === "CANCELLED") {
    throw Object.assign(new Error("El shipment está cancelado"), { code: "SHIPMENT_CANCELLED", status: 409 });
  }
  return rows[0];
}

/**
 * @param {object} p
 * @param {number} [p.companyId]
 * @param {string} p.shipmentRef
 * @param {string|null} [p.supplierName]
 * @param {string|null} [p.originCountry]
 * @param {string|null} [p.incoterm]
 * @param {number} [p.totalExpensesUsd]
 * @param {string|null} [p.notes]
 */
async function createShipment(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const shipmentRef = p.shipmentRef != null ? String(p.shipmentRef).trim() : "";
  if (!shipmentRef) {
    throw Object.assign(new Error("shipment_ref es obligatorio"), { code: "INVALID_REF" });
  }
  const totalExpenses = p.totalExpensesUsd != null ? Number(p.totalExpensesUsd) : 0;
  if (!Number.isFinite(totalExpenses) || totalExpenses < 0) {
    throw Object.assign(new Error("total_expenses_usd inválido"), { code: "INVALID_EXPENSES" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO import_shipments (
         company_id, shipment_ref, supplier_name, origin_country, incoterm,
         total_expenses_usd, notes, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN'::shipment_status)
       RETURNING *`,
      [
        companyId,
        shipmentRef,
        p.supplierName != null ? String(p.supplierName) : null,
        p.originCountry != null ? String(p.originCountry) : null,
        p.incoterm != null ? String(p.incoterm) : null,
        totalExpenses,
        p.notes != null ? String(p.notes) : null,
      ]
    );
    return rows[0] || null;
  } catch (e) {
    if (e && e.code === "23505") {
      throw Object.assign(new Error("Ya existe un shipment con ese shipment_ref para la empresa"), {
        code: "DUPLICATE_REF",
        status: 409,
      });
    }
    throw e;
  }
}

/**
 * @param {object} p
 * @param {number|string} p.shipmentId
 * @param {number} p.totalExpensesUsd
 */
async function setExpenses(p) {
  const shipmentId = Number(p.shipmentId);
  const amt = Number(p.totalExpensesUsd);
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  if (!Number.isFinite(amt) || amt < 0) {
    throw Object.assign(new Error("total_expenses_usd inválido"), { code: "INVALID_EXPENSES" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertShipmentOpen(client, shipmentId);
    const { rows } = await client.query(
      `UPDATE import_shipments SET total_expenses_usd = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [amt, shipmentId]
    );
    await client.query("COMMIT");
    return rows[0] || null;
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
 * @param {object} p
 * @param {number|string} p.shipmentId
 * @param {string} p.productSku
 * @param {number} p.quantity
 * @param {number} p.unitFobUsd
 * @param {number} p.unitVolumeCbm
 */
async function addLine(p) {
  const shipmentId = Number(p.shipmentId);
  const sku = String(p.productSku || "").trim();
  const qty = Number(p.quantity);
  const unitFob = Number(p.unitFobUsd);
  const vol = Number(p.unitVolumeCbm);
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  if (!sku) {
    throw Object.assign(new Error("product_sku requerido"), { code: "INVALID_SKU" });
  }
  if (!Number.isFinite(vol) || vol <= 0) {
    throw Object.assign(new Error("unit_volume_cbm es obligatorio y debe ser > 0"), {
      code: "MISSING_VOLUME",
      status: 422,
    });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw Object.assign(new Error("quantity inválida"), { code: "INVALID_QTY" });
  }
  if (!Number.isFinite(unitFob) || unitFob <= 0) {
    throw Object.assign(new Error("unit_fob_usd inválido"), { code: "INVALID_FOB" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertShipmentOpen(client, shipmentId);
    const { rows: pr } = await client.query(`SELECT 1 FROM products WHERE sku = $1 LIMIT 1`, [sku]);
    if (!pr.length) {
      throw Object.assign(new Error(`SKU no existe en products: ${sku}`), { code: "SKU_NOT_FOUND", status: 404 });
    }
    const { rows } = await client.query(
      `INSERT INTO import_shipment_lines (
         shipment_id, product_sku, quantity, unit_fob_usd, unit_volume_cbm
       ) VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric)
       ON CONFLICT (shipment_id, product_sku) DO UPDATE SET
         quantity = EXCLUDED.quantity,
         unit_fob_usd = EXCLUDED.unit_fob_usd,
         unit_volume_cbm = EXCLUDED.unit_volume_cbm,
         updated_at = now()
       RETURNING *`,
      [shipmentId, sku, qty, unitFob, vol]
    );
    await client.query("COMMIT");
    return rows[0] || null;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    if (e && e.code === "23505") {
      throw Object.assign(new Error("Conflicto de unicidad en línea"), { code: "DUPLICATE", status: 409 });
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {object} p
 * @param {number|string} p.shipmentId
 * @param {string} p.productSku
 */
async function removeLine(p) {
  const shipmentId = Number(p.shipmentId);
  const sku = String(p.productSku || "").trim();
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  if (!sku) {
    throw Object.assign(new Error("product_sku requerido"), { code: "INVALID_SKU" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertShipmentOpen(client, shipmentId);
    const { rowCount } = await client.query(
      `DELETE FROM import_shipment_lines WHERE shipment_id = $1 AND product_sku = $2`,
      [shipmentId, sku]
    );
    await client.query("COMMIT");
    return { deleted: rowCount > 0 };
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
 * @param {number|string} shipmentId
 */
async function previewLandedCost(shipmentId) {
  const sid = Number(shipmentId);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  const { rows: exists } = await pool.query(`SELECT 1 FROM import_shipments WHERE id = $1 LIMIT 1`, [sid]);
  if (!exists.length) {
    throw Object.assign(new Error("Shipment no encontrado"), { code: "NOT_FOUND", status: 404 });
  }
  const { rows: meta } = await pool.query(
    `SELECT s.id, s.total_expenses_usd,
            COALESCE(SUM(l.quantity * l.unit_volume_cbm), 0)::numeric AS total_cbm
     FROM import_shipments s
     LEFT JOIN import_shipment_lines l ON l.shipment_id = s.id
     WHERE s.id = $1
     GROUP BY s.id, s.total_expenses_usd`,
    [sid]
  );
  const { rows } = await pool.query(`SELECT * FROM calculate_landed_cost($1::bigint)`, [sid]);
  return {
    shipment_id: sid,
    total_expenses_usd: meta[0] != null ? Number(meta[0].total_expenses_usd) : null,
    total_cbm: meta[0] != null ? Number(meta[0].total_cbm) : null,
    lines: rows,
  };
}

/**
 * @param {object} p
 * @param {number|string} p.shipmentId
 * @param {number|string|null} [p.userId]
 */
async function closeShipment(p) {
  const shipmentId = Number(p.shipmentId);
  const userId = p.userId != null && String(p.userId).trim() !== "" ? Number(p.userId) : null;
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  try {
    const { rows } = await pool.query(`SELECT close_shipment($1::bigint, $2::integer) AS result`, [
      shipmentId,
      Number.isFinite(userId) ? userId : null,
    ]);
    return rows[0]?.result ?? null;
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    if (/ya está cerrado/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: "ALREADY_CLOSED", status: 409, pg: e });
    }
    if (/No hay tasa de cambio/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: "NO_EXCHANGE_RATE", status: 422, pg: e });
    }
    if (/no tiene líneas/i.test(msg) || /Total CBM es 0/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: "CLOSE_PRECONDITION", status: 422, pg: e });
    }
    if (/no encontrado/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: "NOT_FOUND", status: 404, pg: e });
    }
    if (/cancelado/i.test(msg)) {
      throw Object.assign(new Error(msg), { code: "SHIPMENT_CANCELLED", status: 409, pg: e });
    }
    throw e;
  }
}

/**
 * @param {object} p
 * @param {number|string} p.shipmentId
 */
async function reopenShipment(p) {
  const shipmentId = Number(p.shipmentId);
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: sRows } = await client.query(
      `SELECT id, status::text AS status FROM import_shipments WHERE id = $1 FOR UPDATE`,
      [shipmentId]
    );
    if (!sRows.length) {
      throw Object.assign(new Error("Shipment no encontrado"), { code: "NOT_FOUND", status: 404 });
    }
    const st = String(sRows[0].status || "").toUpperCase();
    if (st !== "CLOSED") {
      throw Object.assign(new Error("Solo se puede reabrir un shipment en estado CLOSED"), {
        code: "SHIPMENT_NOT_CLOSED",
        status: 409,
      });
    }
    await client.query(
      `UPDATE import_shipments SET
         status = 'OPEN'::shipment_status,
         rate_applied = NULL,
         rate_date = NULL,
         total_fob_usd = NULL,
         total_landed_usd = NULL,
         closed_at = NULL,
         closed_by = NULL,
         updated_at = now()
       WHERE id = $1`,
      [shipmentId]
    );
    await client.query(
      `UPDATE import_shipment_lines SET
         allocated_expense_usd = NULL,
         landed_cost_usd = NULL,
         applied_to_product = FALSE,
         applied_at = NULL,
         updated_at = now()
       WHERE shipment_id = $1`,
      [shipmentId]
    );
    const { rows } = await client.query(`SELECT * FROM import_shipments WHERE id = $1`, [shipmentId]);
    await client.query("COMMIT");
    return rows[0] || null;
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
 * @param {number|string} shipmentId
 */
async function getShipmentDetail(shipmentId) {
  const sid = Number(shipmentId);
  if (!Number.isFinite(sid) || sid <= 0) {
    throw Object.assign(new Error("shipmentId inválido"), { code: "INVALID_ID" });
  }
  const { rows: sRows } = await pool.query(`SELECT * FROM import_shipments WHERE id = $1`, [sid]);
  if (!sRows.length) {
    throw Object.assign(new Error("Shipment no encontrado"), { code: "NOT_FOUND", status: 404 });
  }
  const { rows: lines } = await pool.query(
    `SELECT
       l.*,
       COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
       COALESCE(p.precio_usd, p.unit_price_usd) AS precio_usd,
       (l.quantity * l.unit_volume_cbm)::numeric(15,6) AS line_volume_cbm,
       p.landed_cost_usd AS product_landed_cost_usd
     FROM import_shipment_lines l
     JOIN products p ON p.sku = l.product_sku
     WHERE l.shipment_id = $1
     ORDER BY l.id`,
    [sid]
  );
  const { rows: tot } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_skus,
       COALESCE(SUM(quantity), 0)::numeric AS total_units,
       COALESCE(SUM(quantity * unit_volume_cbm), 0)::numeric AS total_cbm,
       COALESCE(SUM(line_fob_usd), 0)::numeric AS total_fob_usd,
       (SELECT total_expenses_usd FROM import_shipments WHERE id = $1) AS total_expenses_usd,
       COALESCE(SUM(line_fob_usd), 0)::numeric
         + (SELECT total_expenses_usd FROM import_shipments WHERE id = $1) AS total_landed_usd
     FROM import_shipment_lines WHERE shipment_id = $1`,
    [sid]
  );
  const t = tot[0] || {};
  return {
    shipment: sRows[0],
    lines,
    totals: {
      total_skus: Number(t.total_skus || 0),
      total_units: Number(t.total_units || 0),
      total_cbm: Number(t.total_cbm || 0),
      total_fob_usd: Number(t.total_fob_usd || 0),
      total_expenses_usd: Number(t.total_expenses_usd || 0),
      total_landed_usd: Number(t.total_landed_usd || 0),
    },
  };
}

/**
 * @param {object} p
 * @param {number} [p.companyId]
 * @param {string|null} [p.status] OPEN|CLOSED|CANCELLED
 */
async function listShipments(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const st = p.status != null ? String(p.status).trim().toUpperCase() : null;
  const params = [companyId];
  let sql = `SELECT * FROM v_shipments_summary WHERE company_id = $1`;
  if (st) {
    params.push(st);
    sql += ` AND status::text = $2`;
  }
  sql += ` ORDER BY created_at DESC NULLS LAST`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

module.exports = {
  createShipment,
  setExpenses,
  addLine,
  removeLine,
  previewLandedCost,
  closeShipment,
  reopenShipment,
  getShipmentDetail,
  listShipments,
};
