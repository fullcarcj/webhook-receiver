"use strict";

const { pool } = require("../../db");
const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "delivery" });

const DELIVERY_CURRENCIES = ["BS", "USD", "EFECTIVO", "EFECTIVO_BS", "ZELLE", "BINANCE"];

async function getZones() {
  const { rows } = await pool.query(
    `SELECT id, zone_name, description, base_cost_bs, client_price_bs,
            base_cost_usd, currency_pago, estimated_minutes, is_active
     FROM delivery_zones
     WHERE is_active = TRUE
     ORDER BY zone_name ASC`
  );
  return rows;
}

/** Todas las zonas (incl. inactivas) — panel de configuración. */
async function getZonesAll() {
  const { rows } = await pool.query(
    `SELECT id, zone_name, description, base_cost_bs, client_price_bs,
            base_cost_usd, currency_pago, estimated_minutes, is_active,
            created_at, updated_at
     FROM delivery_zones
     ORDER BY is_active DESC, zone_name ASC`
  );
  return rows;
}

async function getZoneById(zoneId) {
  const { rows } = await pool.query(
    `SELECT * FROM delivery_zones WHERE id = $1 AND is_active = TRUE`,
    [zoneId]
  );
  return rows[0] || null;
}

async function createZone(data) {
  const { rows } = await pool.query(
    `INSERT INTO delivery_zones
      (zone_name, description, base_cost_bs, client_price_bs, base_cost_usd, currency_pago, estimated_minutes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
     RETURNING *`,
    [
      data.zone_name,
      data.description || null,
      data.base_cost_bs,
      data.client_price_bs,
      data.base_cost_usd || null,
      data.currency_pago || "BS",
      data.estimated_minutes || 30,
    ]
  );
  return rows[0];
}

async function updateZone(zoneId, patch) {
  const fields = [];
  const values = [];
  let n = 1;
  const allowed = [
    "zone_name",
    "description",
    "base_cost_bs",
    "client_price_bs",
    "base_cost_usd",
    "currency_pago",
    "estimated_minutes",
    "is_active",
  ];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      fields.push(`${k} = $${n++}`);
      values.push(patch[k]);
    }
  }
  if (!fields.length) {
    const { rows } = await pool.query(`SELECT * FROM delivery_zones WHERE id = $1`, [zoneId]);
    return rows[0] || null;
  }
  values.push(zoneId);
  const { rows } = await pool.query(
    `UPDATE delivery_zones
     SET ${fields.join(", ")}, updated_at = NOW()
     WHERE id = $${n}
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function getProviders() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, id_document, preferred_currency, is_active, created_at
     FROM delivery_providers
     ORDER BY is_active DESC, name ASC`
  );
  return rows;
}

async function createProvider(data) {
  const { rows } = await pool.query(
    `INSERT INTO delivery_providers
      (name, phone, id_document, preferred_currency, is_active)
     VALUES ($1,$2,$3,$4,TRUE)
     RETURNING *`,
    [data.name, data.phone || null, data.id_document || null, data.preferred_currency || "BS"]
  );
  return rows[0];
}

async function updateProvider(providerId, patch) {
  const fields = [];
  const values = [];
  let n = 1;
  const allowed = ["name", "phone", "id_document", "preferred_currency", "is_active"];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      fields.push(`${k} = $${n++}`);
      values.push(patch[k]);
    }
  }
  if (!fields.length) {
    const { rows } = await pool.query(`SELECT * FROM delivery_providers WHERE id = $1`, [providerId]);
    return rows[0] || null;
  }
  values.push(providerId);
  const { rows } = await pool.query(
    `UPDATE delivery_providers
     SET ${fields.join(", ")}
     WHERE id = $${n}
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function createDeliveryService(client, { orderId, zoneId, zone }) {
  const { rows } = await client.query(
    `INSERT INTO delivery_services
      (order_id, zone_id, client_amount_bs, provider_amount_bs, payment_currency, status)
     VALUES ($1,$2,$3,$4,$5,'pending_assignment')
     RETURNING *`,
    [orderId, zoneId, zone.client_price_bs, zone.base_cost_bs, zone.currency_pago || "BS"]
  );
  log.info({ orderId, zoneId }, "delivery: service creado");
  return rows[0];
}

async function listServices({ status, providerId, limit = 50, offset = 0, from, to }) {
  const cond = ["1=1"];
  const params = [];
  let n = 1;
  if (status) {
    cond.push(`ds.status = $${n++}`);
    params.push(status);
  }
  if (providerId) {
    cond.push(`ds.provider_id = $${n++}`);
    params.push(providerId);
  }
  if (from) {
    cond.push(`ds.created_at >= $${n++}::timestamptz`);
    params.push(from);
  }
  if (to) {
    cond.push(`ds.created_at <= $${n++}::timestamptz`);
    params.push(to);
  }
  const where = cond.join(" AND ");
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT ds.*, dz.zone_name, dp.name AS provider_name, so.external_order_id
     FROM delivery_services ds
     JOIN delivery_zones dz ON dz.id = ds.zone_id
     LEFT JOIN delivery_providers dp ON dp.id = ds.provider_id
     JOIN sales_orders so ON so.id = ds.order_id
     WHERE ${where}
     ORDER BY ds.created_at DESC
     LIMIT $${n++} OFFSET $${n}`,
    params
  );
  return rows;
}

async function getServiceById(id) {
  const { rows } = await pool.query(
    `SELECT ds.*, dz.zone_name, dp.name AS provider_name, so.external_order_id
     FROM delivery_services ds
     JOIN delivery_zones dz ON dz.id = ds.zone_id
     LEFT JOIN delivery_providers dp ON dp.id = ds.provider_id
     JOIN sales_orders so ON so.id = ds.order_id
     WHERE ds.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function assignProvider(deliveryServiceId, providerId) {
  const { rows } = await pool.query(
    `UPDATE delivery_services
     SET provider_id = $1, status = 'assigned', assigned_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND status = 'pending_assignment'
     RETURNING *`,
    [providerId, deliveryServiceId]
  );
  if (!rows.length) {
    const e = new Error("Delivery no existe o no está pendiente de asignación");
    e.code = "INVALID_STATE";
    throw e;
  }
  return rows[0];
}

async function confirmDelivery(deliveryServiceId, notes = null) {
  const { rows } = await pool.query(
    `UPDATE delivery_services
     SET status = 'pending_payment', delivered_at = NOW(), notes = COALESCE($1, notes), updated_at = NOW()
     WHERE id = $2 AND status = 'assigned'
     RETURNING *`,
    [notes, deliveryServiceId]
  );
  if (!rows.length) {
    const e = new Error("Delivery no está en estado assigned");
    e.code = "INVALID_STATE";
    throw e;
  }
  return rows[0];
}

async function getPendingPayments(providerId) {
  const { rows } = await pool.query(
    `SELECT ds.id, ds.order_id, ds.zone_id, ds.provider_amount_bs, ds.payment_currency,
            ds.delivered_at, ds.created_at, dz.zone_name, dp.name AS provider_name,
            so.external_order_id, so.order_total_amount AS order_total_bs
     FROM delivery_services ds
     JOIN delivery_zones dz ON dz.id = ds.zone_id
     JOIN sales_orders so ON so.id = ds.order_id
     LEFT JOIN delivery_providers dp ON dp.id = ds.provider_id
     WHERE ds.provider_id = $1
       AND ds.status = 'pending_payment'
     ORDER BY ds.delivered_at ASC NULLS LAST, ds.created_at ASC`,
    [providerId]
  );

  const total = rows.reduce((sum, r) => sum + Number(r.provider_amount_bs || 0), 0);
  return {
    provider_id: Number(providerId),
    provider_name: rows[0]?.provider_name || null,
    pending_count: rows.length,
    total_owed_bs: Number(total.toFixed(2)),
    deliveries: rows,
  };
}

async function liquidateProvider({ providerId, statementId, manualTxId, deliveryIds, paidBy }) {
  if (!statementId && !manualTxId) {
    const e = new Error("Debe indicar statement_id o manual_tx_id del pago");
    e.code = "MISSING_PAYMENT_REF";
    throw e;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params = [providerId];
    let whereIds = "";
    if (Array.isArray(deliveryIds) && deliveryIds.length) {
      params.push(deliveryIds);
      whereIds = ` AND ds.id = ANY($2::bigint[])`;
    }
    const { rows: pending } = await client.query(
      `SELECT ds.id, ds.provider_amount_bs
       FROM delivery_services ds
       WHERE ds.provider_id = $1
         AND ds.status = 'pending_payment'
         ${whereIds}
       FOR UPDATE`,
      params
    );
    if (!pending.length) {
      const e = new Error("No hay carreras pendientes para este motorizado");
      e.code = "NO_PENDING";
      throw e;
    }
    const ids = pending.map((r) => r.id);
    const total = pending.reduce((sum, r) => sum + Number(r.provider_amount_bs || 0), 0);
    await client.query(
      `UPDATE delivery_services
       SET status = 'paid',
           statement_id = $1,
           manual_tx_id = $2,
           paid_at = NOW(),
           updated_at = NOW()
       WHERE id = ANY($3::bigint[])`,
      [statementId || null, manualTxId || null, ids]
    );
    await client.query("COMMIT");
    return {
      provider_id: Number(providerId),
      deliveries_paid: ids.length,
      total_paid_bs: Number(total.toFixed(2)),
      statement_id: statementId || null,
      manual_tx_id: manualTxId || null,
      paid_by: paidBy || null,
      paid_at: new Date().toISOString(),
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getDebtSummary() {
  const { rows } = await pool.query(
    `SELECT dp.id AS provider_id, dp.name AS provider_name, dp.phone, dp.preferred_currency,
            COUNT(ds.id)::int AS pending_count,
            COALESCE(SUM(ds.provider_amount_bs),0)::numeric AS total_owed_bs,
            MIN(ds.delivered_at) AS oldest_pending
     FROM delivery_providers dp
     LEFT JOIN delivery_services ds
       ON ds.provider_id = dp.id
      AND ds.status = 'pending_payment'
     WHERE dp.is_active = TRUE
     GROUP BY dp.id, dp.name, dp.phone, dp.preferred_currency
     ORDER BY total_owed_bs DESC, provider_name ASC`
  );
  return rows;
}

async function getDeliveryStats(startDate, endDate) {
  const { rows } = await pool.query(
    `SELECT
      COUNT(*)::int AS total_deliveries,
      COUNT(*) FILTER (WHERE status='paid')::int AS paid_count,
      COUNT(*) FILTER (WHERE status='pending_payment')::int AS pending_payment_count,
      COUNT(*) FILTER (WHERE status='pending_assignment')::int AS unassigned_count,
      COALESCE(SUM(client_amount_bs),0)::numeric AS total_collected_bs,
      COALESCE(SUM(provider_amount_bs),0)::numeric AS total_owed_bs,
      COALESCE(SUM(provider_amount_bs) FILTER (WHERE status='paid'),0)::numeric AS total_paid_bs,
      COALESCE(SUM(provider_amount_bs) FILTER (WHERE status='pending_payment'),0)::numeric AS total_pending_bs
     FROM delivery_services
     WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz`,
    [startDate, endDate]
  );
  return rows[0];
}

module.exports = {
  DELIVERY_CURRENCIES,
  getZones,
  getZonesAll,
  getZoneById,
  createZone,
  updateZone,
  getProviders,
  createProvider,
  updateProvider,
  createDeliveryService,
  listServices,
  getServiceById,
  assignProvider,
  confirmDelivery,
  getPendingPayments,
  liquidateProvider,
  getDebtSummary,
  getDeliveryStats,
};
