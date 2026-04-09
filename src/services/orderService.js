"use strict";

const { pool } = require("../../db");
const pino = require("pino");
const { getTransitionSchema } = require("../../schemas/orderSchema");
const loyaltyService = require("./loyaltyService");
const { incrementStockFromOrderLines, fetchOrderItems } = require("./salesService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "orderLifecycle" });

const VALID_TRANSITIONS = {
  pendiente: ["pagada", "anulada"],
  pagada: ["pendiente_entrega", "anulada"],
  anulada: ["pendiente_entrega"],
  pendiente_entrega: ["entregado"],
  entregado: ["archivado"],
  archivado: [],
};

function mapLegacyStatusToLifecycle(status) {
  const s = String(status || "").toLowerCase();
  if (s === "pending") return "pendiente";
  if (s === "paid") return "pagada";
  if (s === "shipped") return "pendiente_entrega";
  if (s === "cancelled") return "anulada";
  if (s === "completed") return "archivado";
  return "pendiente";
}

function lifecycleToLegacy(ls) {
  const m = {
    pendiente: "pending",
    pagada: "paid",
    anulada: "cancelled",
    pendiente_entrega: "shipped",
    entregado: "shipped",
    archivado: "completed",
  };
  return m[ls] || "pending";
}

function effectiveLifecycle(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  return mapLegacyStatusToLifecycle(row.status);
}

async function updateOrderStatus(orderId, transitionData) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    e.status = 400;
    throw e;
  }

  const toStatus = transitionData && transitionData.status;
  const schema = getTransitionSchema(toStatus);
  if (!schema) {
    const e = new Error("VALIDATION_ERROR");
    e.code = "VALIDATION_ERROR";
    e.status = 400;
    e.errors = [{ message: "status debe ser: pagada | anulada | pendiente_entrega | entregado | archivado" }];
    throw e;
  }

  const parsed = schema.safeParse(transitionData);
  if (!parsed.success) {
    const e = new Error("VALIDATION_ERROR");
    e.code = "VALIDATION_ERROR";
    e.status = 400;
    e.errors = parsed.error.issues;
    throw e;
  }
  const data = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id, status, lifecycle_status, source, customer_id, order_total_amount,
              loyalty_points_earned,
              COALESCE(applies_stock, TRUE) AS applies_stock,
              COALESCE(records_cash, TRUE) AS records_cash
       FROM sales_orders WHERE id = $1 FOR UPDATE`,
      [oid]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      const e = new Error("NOT_FOUND");
      e.code = "NOT_FOUND";
      e.status = 404;
      throw e;
    }
    const order = rows[0];
    if (order.source !== "mercadolibre") {
      await client.query("ROLLBACK");
      const e = new Error("Solo órdenes source=mercadolibre");
      e.code = "BAD_REQUEST";
      e.status = 400;
      throw e;
    }

    const cur = effectiveLifecycle(order);
    const validNext = VALID_TRANSITIONS[cur] || [];
    if (!validNext.includes(data.status)) {
      await client.query("ROLLBACK");
      const e = new Error(`No se puede pasar de ${cur} a ${data.status}`);
      e.code = "INVALID_STATUS_TRANSITION";
      e.status = 422;
      throw e;
    }

    const items = await fetchOrderItems(client, oid);
    const totalAmt = Number(order.order_total_amount);
    const legacy = lifecycleToLegacy(data.status);

    await client.query(
      `UPDATE sales_orders SET
         lifecycle_status = $1,
         status = $2,
         updated_at = NOW(),
         aprobado_por_user_id = COALESCE($3, aprobado_por_user_id),
         es_pago_auto_banesco = COALESCE($4, es_pago_auto_banesco),
         motivo_anulacion = COALESCE($5, motivo_anulacion),
         tipo_calificacion_ml = COALESCE($6, tipo_calificacion_ml),
         metodo_despacho = COALESCE($7, metodo_despacho),
         calificacion_ml = COALESCE($8, calificacion_ml)
       WHERE id = $9`,
      [
        data.status,
        legacy,
        data.aprobado_por_user_id ?? null,
        data.es_pago_auto_banesco !== undefined ? data.es_pago_auto_banesco : null,
        data.motivo_anulacion ?? null,
        data.tipo_calificacion_ml ?? null,
        data.metodo_despacho ?? null,
        data.calificacion_ml ?? null,
        oid,
      ]
    );

    await client.query(
      `INSERT INTO sales_order_history (order_id, from_status, to_status, changed_by, motivo, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        oid,
        cur,
        data.status,
        data.changed_by,
        data.motivo_anulacion ?? null,
        JSON.stringify({ ...data, notes: data.notes }),
      ]
    );

    if (data.status === "anulada") {
      const appliesStock = order.applies_stock !== false;
      if (appliesStock) {
        await incrementStockFromOrderLines(client, items);
      }
      if (cur === "pendiente") {
        /* solo stock */
      } else if (cur === "pagada" || cur === "pendiente_entrega" || cur === "entregado") {
        const recordsCash = order.records_cash !== false;
        if (recordsCash) {
          await client.query(
            `INSERT INTO sales_cash_movements (sales_order_id, amount_usd, movement_type) VALUES ($1, $2, 'refund')`,
            [oid, (-totalAmt).toFixed(2)]
          );
        }
        const pts = Number(order.loyalty_points_earned) || 0;
        if (pts > 0 && order.customer_id) {
          await loyaltyService.adjustPointsWithClient(
            client,
            Number(order.customer_id),
            -pts,
            `Anulación ML lifecycle #${oid}`
          );
        }
        await client.query(`UPDATE sales_orders SET loyalty_points_earned = 0 WHERE id = $1`, [oid]);
      }
    }

    if (data.status === "pagada" && cur === "pendiente" && order.customer_id) {
      const prevPts = Number(order.loyalty_points_earned) || 0;
      if (prevPts === 0) {
        const earn = await loyaltyService.earnFromMlOrder({
          customerId: Number(order.customer_id),
          orderId: `SALES-${oid}`,
          amountUsd: totalAmt,
          source: "mercadolibre",
          client,
        });
        const pts = earn.points_earned || 0;
        await client.query(`UPDATE sales_orders SET loyalty_points_earned = $1 WHERE id = $2`, [pts, oid]);
        if (order.records_cash !== false) {
          await client.query(
            `INSERT INTO sales_cash_movements (sales_order_id, amount_usd, movement_type) VALUES ($1, $2, 'sale')`,
            [oid, totalAmt.toFixed(2)]
          );
        }
      }
    }

    await client.query("COMMIT");

    const { rows: updated } = await pool.query(`SELECT * FROM sales_orders WHERE id = $1`, [oid]);
    return updated[0];
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_r) {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

async function getOrderHistory(orderId) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    const e = new Error("id inválido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const { rows } = await pool.query(
    `SELECT id, from_status, to_status, changed_by, motivo, metadata, created_at
     FROM sales_order_history WHERE order_id = $1 ORDER BY created_at DESC`,
    [oid]
  );
  return rows;
}

async function listPendingRatingAlerts(type = "all") {
  const t = String(type || "all").toLowerCase();
  const h = String(Math.max(1, parseInt(process.env.ALERT_WARNING_HOURS || "24", 10) || 24));

  let sql = `
    SELECT
      so.id, so.status, so.lifecycle_status, so.created_at, so.rating_deadline_at,
      so.is_rating_alert,
      EXTRACT(EPOCH FROM (so.rating_deadline_at - NOW())) / 3600 AS hours_remaining,
      c.full_name AS customer_name,
      c.id AS customer_id
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.source = 'mercadolibre'
      AND (so.lifecycle_status IS NULL OR so.lifecycle_status NOT IN ('archivado', 'anulada'))
      AND so.rating_deadline_at IS NOT NULL`;

  const params = [];
  if (t === "overdue") {
    sql += ` AND so.rating_deadline_at < NOW()`;
  } else if (t === "near_deadline") {
    sql += ` AND so.rating_deadline_at > NOW()
      AND so.rating_deadline_at <= NOW() + ($1::text || ' hours')::interval
      AND so.is_rating_alert = TRUE`;
    params.push(h);
  }

  sql += ` ORDER BY so.rating_deadline_at ASC LIMIT 50`;

  const { rows } = params.length ? await pool.query(sql, params) : await pool.query(sql);

  const { rows: sn } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM sales_orders so WHERE so.source='mercadolibre'
     AND (so.lifecycle_status IS NULL OR so.lifecycle_status NOT IN ('archivado','anulada'))
     AND so.rating_deadline_at IS NOT NULL
     AND so.rating_deadline_at > NOW()
     AND so.rating_deadline_at <= NOW() + ($1::text || ' hours')::interval
     AND so.is_rating_alert = TRUE`,
    [h]
  );
  const { rows: so } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM sales_orders so WHERE so.source='mercadolibre'
     AND (so.lifecycle_status IS NULL OR so.lifecycle_status NOT IN ('archivado','anulada'))
     AND so.rating_deadline_at IS NOT NULL AND so.rating_deadline_at < NOW()`
  );

  return {
    alerts: rows.map((r) => ({
      order_id: Number(r.id),
      customer_name: r.customer_name,
      customer_id: r.customer_id != null ? Number(r.customer_id) : null,
      status: r.status,
      lifecycle_status: r.lifecycle_status,
      rating_deadline_at: r.rating_deadline_at,
      hours_remaining: r.hours_remaining != null ? Math.round(Number(r.hours_remaining) * 10) / 10 : null,
      is_rating_alert: r.is_rating_alert,
    })),
    summary: {
      near_deadline: Number(sn[0].c),
      overdue: Number(so[0].c),
      total: rows.length,
    },
  };
}

module.exports = {
  updateOrderStatus,
  getOrderHistory,
  listPendingRatingAlerts,
  VALID_TRANSITIONS,
  log,
};
