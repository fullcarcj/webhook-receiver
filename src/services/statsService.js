"use strict";

/**
 * Queries de analytics de solo-lectura para el módulo ERP/CRM.
 * Timezone: America/Caracas (-0400) en todos los DATE_TRUNC y GROUP BY.
 * KPIs de ventas: `getSales` usa `v_sales_unified` (POS + omnicanal).
 * revenue_bs: POS = total_usd×tasa; omnicanal = order_total_amount (Bs).
 */

const { pool }  = require("../../db");
const {
  fillGaps,
  calcChange,
  calcPct,
  V_SALES_UNIFIED_BS_AMOUNT,
} = require("../utils/statsHelpers");

/** Importe en Bs por fila de `v_sales_unified` (alias `vu`). */
const VU_REVENUE_BS = `(
  CASE WHEN vu.source_table = 'sales'
    THEN vu.total_usd * NULLIF(vu.exchange_rate_bs_per_usd, 0)
    ELSE vu.order_total_amount
  END
)`;
/** Importe en USD por fila de `v_sales_unified`. */
const VU_REVENUE_USD = `(
  CASE WHEN vu.source_table = 'sales'
    THEN vu.total_usd
    ELSE vu.order_total_amount / NULLIF(vu.exchange_rate_bs_per_usd, 0)
  END
)`;

// ─── OVERVIEW ─────────────────────────────────────────────────────────────────

async function getOverview() {
  const [todayRows, yesterdayRows, customersRow, messagesRow, reconcRow, debitRow] =
    await Promise.all([
      // Ventas hoy (POS + omnicanal)
      pool.query(`
        SELECT
          COUNT(*)::bigint AS orders,
          COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0) AS revenue_bs,
          COALESCE(SUM(total_usd), 0) AS revenue_usd,
          COUNT(*) FILTER (WHERE LOWER(status) IN ('pending', 'pending_payment')) AS pending_orders,
          COUNT(*) FILTER (WHERE LOWER(status) = 'payment_overdue') AS overdue_orders,
          COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}) FILTER (WHERE LOWER(status) = 'paid'), 0) AS collected_bs
        FROM v_sales_unified
        WHERE DATE(created_at AT TIME ZONE 'America/Caracas') = CURRENT_DATE
      `),
      // Ventas ayer
      pool.query(`
        SELECT COUNT(*)::bigint AS orders, COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0) AS revenue_bs
        FROM v_sales_unified
        WHERE DATE(created_at AT TIME ZONE 'America/Caracas') = CURRENT_DATE - 1
      `),
      // Clientes nuevos hoy
      pool.query(`
        SELECT COUNT(*) AS new_customers FROM customers
        WHERE DATE(created_at AT TIME ZONE 'America/Caracas') = CURRENT_DATE
      `),
      // Mensajes WhatsApp hoy
      pool.query(`
        SELECT
          COUNT(*)                                               AS messages,
          COUNT(*) FILTER (WHERE direction='inbound')            AS inbound,
          COUNT(*) FILTER (WHERE direction='outbound')           AS outbound
        FROM crm_messages
        WHERE DATE(created_at AT TIME ZONE 'America/Caracas') = CURRENT_DATE
      `).catch(() => ({ rows: [{ messages: 0, inbound: 0, outbound: 0 }] })),
      // Conciliación hoy
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='auto_matched')  AS auto_matched,
          COUNT(*) FILTER (WHERE status='manual_review') AS manual_pending
        FROM reconciliation_log
        WHERE DATE(created_at AT TIME ZONE 'America/Caracas') = CURRENT_DATE
      `).catch(() => ({ rows: [{ auto_matched: 0, manual_pending: 0 }] })),
      // Débitos sin justificar
      pool.query(`
        SELECT COUNT(*) AS unjustified_debits
        FROM bank_statements bs
        LEFT JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
        WHERE bs.tx_type = 'DEBIT' AND dj.id IS NULL
      `).catch(() => ({ rows: [{ unjustified_debits: 0 }] })),
    ]);

  const t = todayRows.rows[0];
  const y = yesterdayRows.rows[0];
  const m = messagesRow.rows[0];
  const r = reconcRow.rows[0];
  const d = debitRow.rows[0];

  const pending_bs = Number(t.revenue_bs) - Number(t.collected_bs);
  const alerts = [];
  if (Number(d.unjustified_debits) > 0)
    alerts.push({ type: "unjustified_debits", count: Number(d.unjustified_debits), severity: "high" });
  if (Number(t.overdue_orders) > 0)
    alerts.push({ type: "overdue_orders", count: Number(t.overdue_orders), severity: "high" });
  if (Number(r.manual_pending) > 0)
    alerts.push({ type: "manual_pending", count: Number(r.manual_pending), severity: "medium" });

  return {
    today: {
      orders_count:      Number(t.orders),
      revenue_bs:        Number(t.revenue_bs),
      revenue_usd:       Number(Number(t.revenue_usd).toFixed(2)),
      collected_bs:      Number(t.collected_bs),
      pending_bs:        Number(pending_bs.toFixed(2)),
      pending_orders:    Number(t.pending_orders),
      overdue_orders:    Number(t.overdue_orders),
      new_customers:     Number(customersRow.rows[0].new_customers),
      messages_received: Number(m.inbound),
      auto_reconciled:   Number(r.auto_matched),
      manual_pending:    Number(r.manual_pending),
    },
    yesterday: {
      orders_count: Number(y.orders),
      revenue_bs:   Number(y.revenue_bs),
    },
    changes: {
      orders_pct:  calcChange(Number(t.orders),      Number(y.orders)),
      revenue_pct: calcChange(Number(t.revenue_bs),  Number(y.revenue_bs)),
    },
    alerts,
  };
}

// ─── REALTIME ─────────────────────────────────────────────────────────────────

async function getRealtime() {
  const [ordersRow, chatsRow, reconcRow] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::bigint AS orders, COALESCE(SUM(${V_SALES_UNIFIED_BS_AMOUNT}), 0) AS revenue_bs
      FROM v_sales_unified WHERE created_at >= NOW() - INTERVAL '60 minutes'
    `),
    pool.query(`
      SELECT COUNT(DISTINCT chat_id) AS chats FROM crm_messages
      WHERE created_at >= NOW() - INTERVAL '60 minutes' AND direction='inbound'
    `).catch(() => ({ rows: [{ chats: 0 }] })),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='auto_matched')  AS matched_today,
        COUNT(*) FILTER (WHERE status='manual_review') AS manual_today,
        MAX(created_at) AS last_match_at
      FROM reconciliation_log
      WHERE DATE(created_at AT TIME ZONE 'America/Caracas') = CURRENT_DATE
    `).catch(() => ({ rows: [{ matched_today: 0, manual_today: 0, last_match_at: null }] })),
  ]);

  return {
    last_60min: {
      orders:     Number(ordersRow.rows[0].orders),
      revenue_bs: Number(ordersRow.rows[0].revenue_bs),
      chats:      Number(chatsRow.rows[0].chats),
    },
    reconciliation_worker: {
      last_match_at:  reconcRow.rows[0].last_match_at,
      matched_today:  Number(reconcRow.rows[0].matched_today),
      manual_today:   Number(reconcRow.rows[0].manual_today),
    },
  };
}

// ─── VENTAS ───────────────────────────────────────────────────────────────────

async function getSales({ start, end, source, seller, label }) {
  const params = [start, end];
  let filter = "";
  if (source) { params.push(source); filter += ` AND vu.source = $${params.length}`; }
  if (seller) { params.push(seller); filter += ` AND vu.sold_by = $${params.length}`; }

  const baseWhere = `
    LOWER(vu.status) != 'cancelled'
    AND vu.created_at >= $1 AND vu.created_at < $2
    ${filter}
  `;

  const [totals, chart, bySrc, bySeller] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) AS orders,
             COALESCE(SUM(${VU_REVENUE_BS}),0) AS total_bs,
             COALESCE(SUM(${VU_REVENUE_USD}),0) AS total_usd
      FROM v_sales_unified vu
      WHERE ${baseWhere}
    `, params),
    pool.query(`
      SELECT
        DATE(vu.created_at AT TIME ZONE 'America/Caracas') AS date,
        COALESCE(SUM(${VU_REVENUE_BS}) FILTER (WHERE vu.source='mercadolibre'),0)  AS mercadolibre,
        COALESCE(SUM(${VU_REVENUE_BS}) FILTER (WHERE vu.source='mostrador'),0)     AS mostrador,
        COALESCE(SUM(${VU_REVENUE_BS}) FILTER (WHERE vu.source='ecommerce'),0)     AS ecommerce,
        COALESCE(SUM(${VU_REVENUE_BS}) FILTER (WHERE vu.source='social_media'),0)  AS social_media,
        COALESCE(SUM(${VU_REVENUE_BS}),0) AS total
      FROM v_sales_unified vu
      WHERE ${baseWhere}
      GROUP BY DATE(vu.created_at AT TIME ZONE 'America/Caracas')
      ORDER BY date ASC
    `, params),
    pool.query(`
      SELECT vu.source,
             COUNT(*) FILTER (WHERE LOWER(vu.status) != 'cancelled') AS orders,
             COALESCE(SUM(${VU_REVENUE_BS}) FILTER (WHERE LOWER(vu.status) != 'cancelled'), 0) AS revenue_bs,
             COUNT(*) FILTER (WHERE LOWER(vu.status) = 'cancelled') AS cancelled_count,
             COUNT(*) AS total_incl_cancelled
      FROM v_sales_unified vu
      WHERE vu.created_at >= $1 AND vu.created_at < $2 ${filter}
      GROUP BY vu.source
    `, params),
    pool.query(`
      SELECT vu.sold_by AS seller, COUNT(*) AS orders,
             COALESCE(SUM(${VU_REVENUE_BS}),0) AS revenue_bs
      FROM v_sales_unified vu
      WHERE LOWER(vu.status) != 'cancelled' AND vu.sold_by IS NOT NULL
        AND vu.created_at >= $1 AND vu.created_at < $2 ${filter}
      GROUP BY vu.sold_by ORDER BY revenue_bs DESC
    `, params),
  ]);

  const t = totals.rows[0];
  const totalBs  = Number(t.total_bs);
  const totalOrd = Number(t.orders);
  const chartFilled = fillGaps(
    chart.rows.map((r) => ({ ...r, date: String(r.date).split("T")[0] })),
    start, new Date(end.getTime() - 86400000),
    { mercadolibre: 0, mostrador: 0, ecommerce: 0, social_media: 0, total: 0 }
  );

  return {
    period:        label,
    total_bs:      totalBs,
    total_usd:     Number(Number(t.total_usd).toFixed(2)),
    total_orders:  totalOrd,
    avg_ticket_bs: totalOrd > 0 ? Number((totalBs / totalOrd).toFixed(2)) : 0,
    chart:         chartFilled,
    by_source: bySrc.rows.map((r) => ({
      source:       r.source,
      orders:       Number(r.orders),
      revenue_bs:   Number(r.revenue_bs),
      pct_of_total: calcPct(Number(r.revenue_bs), totalBs),
      avg_ticket_bs: Number(r.orders) > 0 ? Number((Number(r.revenue_bs) / Number(r.orders)).toFixed(2)) : 0,
      cancelled_pct: calcPct(Number(r.cancelled_count), Number(r.total_incl_cancelled)),
    })),
    by_seller: bySeller.rows.map((r) => ({
      seller:     r.seller,
      orders:     Number(r.orders),
      revenue_bs: Number(r.revenue_bs),
    })),
  };
}

// ─── INVENTARIO (WMS + catálogo) ─────────────────────────────────────────────

async function getInventoryStats() {
  const [sumRow, topStock, stockouts, byCat] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*)::bigint FROM products WHERE is_active = true) AS total_skus,
        (SELECT COUNT(DISTINCT product_sku)::bigint FROM bin_stock WHERE qty_available > 0) AS skus_con_stock,
        (SELECT COALESCE(SUM(qty_available), 0)::numeric FROM bin_stock) AS total_units,
        (SELECT COUNT(*)::bigint FROM bin_stock WHERE qty_available = 0) AS stockout_count,
        (
          SELECT COUNT(*)::bigint
          FROM bin_stock bs
          LEFT JOIN products p ON p.sku = bs.product_sku
          LEFT JOIN inventory i ON i.product_id = p.id
          WHERE bs.qty_available > 0
            AND bs.qty_available <= COALESCE(i.stock_min, 0)
        ) AS low_stock_count,
        (
          SELECT COALESCE(SUM(bs.qty_available * COALESCE(p.landed_cost_usd, 0)), 0)::numeric
          FROM bin_stock bs
          LEFT JOIN products p ON p.sku = bs.product_sku
        ) AS stock_value_usd
    `),
    pool.query(`
      SELECT
        bs.product_sku AS sku,
        COALESCE(p.name, '') AS name,
        SUM(bs.qty_available)::numeric AS qty
      FROM bin_stock bs
      LEFT JOIN products p ON p.sku = bs.product_sku
      GROUP BY bs.product_sku, p.name
      ORDER BY qty DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT
        bs.product_sku AS sku,
        COALESCE(p.name, '') AS name,
        p.category
      FROM bin_stock bs
      LEFT JOIN products p ON p.sku = bs.product_sku
      WHERE bs.qty_available = 0
      ORDER BY COALESCE(p.name, bs.product_sku) ASC
      LIMIT 10
    `),
    pool.query(`
      SELECT
        COALESCE(NULLIF(TRIM(p.category), ''), '(sin categoría)') AS category,
        COUNT(DISTINCT bs.product_sku)::bigint AS skus,
        SUM(bs.qty_available)::numeric AS total_units
      FROM bin_stock bs
      LEFT JOIN products p ON p.sku = bs.product_sku
      WHERE bs.qty_available > 0
      GROUP BY 1
      ORDER BY total_units DESC
      LIMIT 10
    `),
  ]);

  const s = sumRow.rows[0] || {};
  return {
    summary: {
      total_skus:       Number(s.total_skus ?? 0),
      skus_con_stock:   Number(s.skus_con_stock ?? 0),
      total_units:      Number(s.total_units ?? 0),
      stockout_count:   Number(s.stockout_count ?? 0),
      low_stock_count:  Number(s.low_stock_count ?? 0),
      stock_value_usd:  Number(Number(s.stock_value_usd ?? 0).toFixed(2)),
    },
    top_stock: topStock.rows.map((r) => ({
      sku:  r.sku,
      name: r.name,
      qty:  Number(r.qty),
    })),
    stockouts: stockouts.rows.map((r) => ({
      sku:      r.sku,
      name:     r.name,
      category: r.category != null ? r.category : null,
    })),
    by_category: byCat.rows.map((r) => ({
      category:    r.category,
      skus:        Number(r.skus),
      total_units: Number(r.total_units),
    })),
  };
}

// ─── VENTAS HOURLY HEATMAP ────────────────────────────────────────────────────

async function getSalesHourly(weeks = 4) {
  const { rows } = await pool.query(`
    SELECT
      EXTRACT(ISODOW FROM created_at AT TIME ZONE 'America/Caracas')::int AS day,
      EXTRACT(HOUR   FROM created_at AT TIME ZONE 'America/Caracas')::int AS hour,
      COUNT(*)                                 AS orders,
      COALESCE(SUM(order_total_amount), 0)    AS revenue_bs
    FROM sales_orders
    WHERE status != 'cancelled'
      AND created_at >= NOW() - ($1 || ' weeks')::interval
    GROUP BY 1, 2
    ORDER BY 1, 2
  `, [weeks]);

  const DAY_NAMES = ["", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const heatmap   = rows.map((r) => ({
    day:       Number(r.day),
    day_name:  DAY_NAMES[Number(r.day)] || `Día ${r.day}`,
    hour:      Number(r.hour),
    orders:    Number(r.orders),
    revenue_bs: Number(r.revenue_bs),
  }));

  const sorted  = [...heatmap].sort((a, b) => b.orders - a.orders);
  const peak    = sorted[0]   || {};
  const slowest = sorted[sorted.length - 1] || {};

  return {
    heatmap,
    peak_hour:    peak.hour    ?? null,
    peak_day:     peak.day_name ?? null,
    slowest_hour: slowest.hour ?? null,
    slowest_day:  slowest.day_name ?? null,
  };
}

// ─── TOP PRODUCTOS ─────────────────────────────────────────────────────────────

async function getSalesProducts({ start, end, limit = 10 }) {
  const { rows } = await pool.query(`
    SELECT
      soi.sku, soi.part_name,
      SUM(soi.quantity)        AS units_sold,
      COALESCE(SUM(soi.subtotal_usd),0)  AS revenue_usd,
      COALESCE(AVG(soi.unit_price_usd),0) AS avg_price_usd,
      COUNT(DISTINCT soi.order_id)        AS orders_count
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.order_id
    WHERE so.status != 'cancelled'
      AND so.created_at >= $1 AND so.created_at < $2
    GROUP BY soi.sku, soi.part_name
    ORDER BY units_sold DESC
    LIMIT $3
  `, [start, end, limit]).catch(() => ({ rows: [] }));

  return {
    top_products: rows.map((r) => ({
      sku:           r.sku,
      part_name:     r.part_name,
      units_sold:    Number(r.units_sold),
      revenue_usd:   Number(Number(r.revenue_usd).toFixed(2)),
      avg_price_usd: Number(Number(r.avg_price_usd).toFixed(2)),
      orders_count:  Number(r.orders_count),
    })),
    chart: rows.map((r) => ({ sku: r.sku, name: r.part_name, value: Number(r.units_sold) })),
  };
}

// ─── CLIENTES ─────────────────────────────────────────────────────────────────

async function getCustomers({ start, end, label }) {
  const [totals, newByDay, bySrc, loyalty, topC] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE crm_status='active')  AS total_active,
        COUNT(*) FILTER (WHERE crm_status='draft')   AS total_draft,
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2) AS new_this_period
      FROM customers
    `, [start, end]),
    pool.query(`
      SELECT DATE(created_at AT TIME ZONE 'America/Caracas') AS date, COUNT(*) AS count
      FROM customers WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY 1
    `, [start, end]),
    pool.query(`
      SELECT ci.source, COUNT(DISTINCT ci.customer_id) AS count
      FROM crm_customer_identities ci GROUP BY ci.source ORDER BY count DESC
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT level, COUNT(*) AS count FROM loyalty_accounts GROUP BY level
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT so.customer_id, c.full_name,
             COALESCE(SUM(so.order_total_amount),0) AS total_spent_bs,
             COUNT(*) AS orders_count,
             MAX(DATE(so.created_at AT TIME ZONE 'America/Caracas')) AS last_purchase
      FROM sales_orders so
      JOIN customers c ON c.id = so.customer_id
      WHERE so.status NOT IN ('cancelled')
        AND so.created_at >= $1 AND so.created_at < $2
      GROUP BY so.customer_id, c.full_name
      ORDER BY total_spent_bs DESC LIMIT 10
    `, [start, end]),
  ]);

  const total   = totals.rows[0];
  const allCust = Number(total.total_active) + Number(total.total_draft);
  const loyTotal = loyalty.rows.reduce((s, r) => s + Number(r.count), 0);

  return {
    total_active:    Number(total.total_active),
    total_draft:     Number(total.total_draft),
    new_this_period: Number(total.new_this_period),
    by_source: bySrc.rows.map((r) => ({
      source: r.source,
      count:  Number(r.count),
      pct:    calcPct(Number(r.count), allCust),
    })),
    loyalty_pyramid: loyalty.rows.map((r) => ({
      level: r.level,
      count: Number(r.count),
      pct:   calcPct(Number(r.count), loyTotal),
    })),
    new_by_day: fillGaps(
      newByDay.rows.map((r) => ({ date: String(r.date).split("T")[0], count: Number(r.count) })),
      start, new Date(end.getTime() - 86400000), { count: 0 }
    ),
    top_customers: topC.rows.map((r) => ({
      customer_id:   Number(r.customer_id),
      full_name:     r.full_name,
      total_spent_bs: Number(r.total_spent_bs),
      orders_count:  Number(r.orders_count),
      last_purchase: r.last_purchase,
    })),
  };
}

// ─── VEHÍCULOS ────────────────────────────────────────────────────────────────

async function getCustomerVehicles() {
  const [top, byBrand] = await Promise.all([
    pool.query(`
      SELECT vb.name AS brand, vm.name AS model,
             vg.year_from || COALESCE('-' || vg.year_to,'') AS year,
             COUNT(cv.customer_id) AS customers
      FROM crm_customer_vehicles cv
      JOIN crm_vehicle_generations vg ON vg.id = cv.generation_id
      JOIN crm_vehicle_models vb2 ON vb2.id = vg.model_id
      JOIN crm_vehicle_brands vb  ON vb.id  = vb2.brand_id
      LEFT JOIN crm_vehicle_models vm ON vm.id = vg.model_id
      GROUP BY brand, model, year ORDER BY customers DESC LIMIT 20
    `).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT vb.name AS brand, COUNT(cv.customer_id) AS customers
      FROM crm_customer_vehicles cv
      JOIN crm_vehicle_generations vg ON vg.id = cv.generation_id
      JOIN crm_vehicle_models vb2 ON vb2.id = vg.model_id
      JOIN crm_vehicle_brands vb  ON vb.id  = vb2.brand_id
      GROUP BY brand ORDER BY customers DESC
    `).catch(() => ({ rows: [] })),
  ]);

  const total = top.rows.reduce((s, r) => s + Number(r.customers), 0);
  return {
    top_vehicles: top.rows.map((r) => ({
      brand:     r.brand, model: r.model, year: r.year,
      customers: Number(r.customers),
      pct:       calcPct(Number(r.customers), total),
    })),
    by_brand: byBrand.rows.map((r) => ({
      brand:     r.brand,
      customers: Number(r.customers),
      pct:       calcPct(Number(r.customers), total),
    })),
  };
}

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────

async function getWhatsapp({ start, end }) {
  const [msgs, byType, receipts] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction='inbound')                 AS inbound,
        COUNT(DISTINCT chat_id) FILTER (WHERE direction='inbound')  AS chats_inbound
      FROM crm_messages WHERE created_at >= $1 AND created_at < $2
    `, [start, end]).catch(() => ({ rows: [{ inbound: 0, chats_inbound: 0 }] })),
    pool.query(`
      SELECT type, COUNT(*) AS count FROM crm_messages
      WHERE direction='inbound' AND created_at >= $1 AND created_at < $2
      GROUP BY type ORDER BY count DESC
    `, [start, end]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT
        COUNT(*)                                                     AS detected,
        COUNT(*) FILTER (WHERE reconciliation_status='matched')      AS auto_reconciled,
        COUNT(*) FILTER (WHERE reconciliation_status='manual_review') AS manual_review
      FROM payment_attempts WHERE created_at >= $1 AND created_at < $2
    `, [start, end]).catch(() => ({ rows: [{ detected: 0, auto_reconciled: 0, manual_review: 0 }] })),
  ]);

  const inbound    = Number(msgs.rows[0].inbound);
  const totalTypes = byType.rows.reduce((s, r) => s + Number(r.count), 0);
  const rec        = receipts.rows[0];

  return {
    funnel: [
      { stage: "Mensajes recibidos",    count: inbound, pct: 100.0 },
    ],
    message_types: byType.rows.map((r) => ({
      type:  r.type,
      count: Number(r.count),
      pct:   calcPct(Number(r.count), totalTypes),
    })),
    receipts: {
      detected:       Number(rec.detected),
      auto_reconciled: Number(rec.auto_reconciled),
      manual_review:  Number(rec.manual_review),
      auto_pct: calcPct(Number(rec.auto_reconciled), Number(rec.detected)),
    },
  };
}

// ─── MERCADOLIBRE ─────────────────────────────────────────────────────────────

async function getMercadoLibre({ start, end }) {
  const { rows } = await pool.query(`
    SELECT status, COUNT(*) AS count,
           COALESCE(SUM(order_total_amount),0) AS revenue_bs
    FROM sales_orders
    WHERE source = 'mercadolibre' AND created_at >= $1 AND created_at < $2
    GROUP BY status
  `, [start, end]);

  const [allRow] = await pool.query(`
    SELECT COALESCE(SUM(order_total_amount),0) AS total_all
    FROM sales_orders
    WHERE status != 'cancelled' AND created_at >= $1 AND created_at < $2
  `, [start, end]).then((r) => r.rows);

  const mlRevenue = rows
    .filter((r) => r.status !== "cancelled")
    .reduce((s, r) => s + Number(r.revenue_bs), 0);

  return {
    orders_by_status: rows.map((r) => ({
      status:     r.status,
      count:      Number(r.count),
      revenue_bs: Number(r.revenue_bs),
    })),
    ml_revenue_pct_of_total: calcPct(mlRevenue, Number(allRow?.total_all || 0)),
  };
}

// ─── CONCILIACIÓN STATS ───────────────────────────────────────────────────────

async function getReconciliationStats({ start, end, label }) {
  const [summary, bySrc, byLevel, chart, unj] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='auto_matched')  AS auto_matched,
        COUNT(*) FILTER (WHERE status='manual_review') AS manual_review,
        AVG(confidence_score)                          AS avg_confidence
      FROM reconciliation_log WHERE created_at >= $1 AND created_at < $2
    `, [start, end]).catch(() => ({ rows: [{ auto_matched: 0, manual_review: 0, avg_confidence: null }] })),
    pool.query(`
      SELECT source, COUNT(*) AS count FROM reconciliation_log
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY source
    `, [start, end]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT match_level, COUNT(*) AS count FROM reconciliation_log
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY match_level ORDER BY match_level
    `, [start, end]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT DATE(created_at AT TIME ZONE 'America/Caracas') AS date,
             COUNT(*) FILTER (WHERE status='auto_matched')  AS auto,
             COUNT(*) FILTER (WHERE status='manual_review') AS manual
      FROM reconciliation_log WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY 1
    `, [start, end]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT COUNT(*) AS count, COALESCE(SUM(bs.amount),0) AS total_bs, MIN(bs.tx_date) AS oldest_date
      FROM bank_statements bs
      LEFT JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
      WHERE bs.tx_type='DEBIT' AND dj.id IS NULL
    `).catch(() => ({ rows: [{ count: 0, total_bs: 0, oldest_date: null }] })),
  ]);

  const s       = summary.rows[0];
  const total   = Number(s.auto_matched) + Number(s.manual_review);
  const srcTot  = bySrc.rows.reduce((a, r) => a + Number(r.count), 0);
  const lvlTot  = byLevel.rows.reduce((a, r) => a + Number(r.count), 0);
  const LEVELS  = { 1: "Triple match", 2: "Double match", 3: "Revisión manual" };

  return {
    summary: {
      auto_matched:  Number(s.auto_matched),
      manual_review: Number(s.manual_review),
      no_match:      0,
      auto_pct:      calcPct(Number(s.auto_matched), total),
    },
    by_source: bySrc.rows.map((r) => ({
      source: r.source, count: Number(r.count),
      pct:    calcPct(Number(r.count), srcTot),
    })),
    by_level: byLevel.rows.map((r) => ({
      level:  Number(r.match_level),
      label:  LEVELS[Number(r.match_level)] || `Nivel ${r.match_level}`,
      count:  Number(r.count),
      pct:    calcPct(Number(r.count), lvlTot),
    })),
    avg_confidence: s.avg_confidence ? Number(Number(s.avg_confidence).toFixed(3)) : null,
    chart: fillGaps(
      chart.rows.map((r) => ({ date: String(r.date).split("T")[0], auto: Number(r.auto), manual: Number(r.manual) })),
      start, new Date(end.getTime() - 86400000), { auto: 0, manual: 0 }
    ),
    unjustified_debits: {
      count:       Number(unj.rows[0].count),
      total_bs:    Number(unj.rows[0].total_bs),
      oldest_date: unj.rows[0].oldest_date,
    },
  };
}

// ─── CASHFLOW MULTI-MONEDA ────────────────────────────────────────────────────

async function getCashflow({ start, end, label }) {
  const startDate = start.toISOString().split("T")[0];
  const endDate   = new Date(end.getTime() - 86400000).toISOString().split("T")[0];

  const [bsRows, manualRows, rateRow] = await Promise.all([
    pool.query(`
      SELECT DATE(tx_date) AS date,
             COALESCE(SUM(amount) FILTER (WHERE tx_type='CREDIT'),0) AS ingresos,
             COALESCE(SUM(amount) FILTER (WHERE tx_type='DEBIT'),0)  AS egresos
      FROM bank_statements WHERE tx_date >= $1 AND tx_date <= $2
      GROUP BY DATE(tx_date) ORDER BY date
    `, [startDate, endDate]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT currency::text, tx_date::text AS date,
             COALESCE(SUM(amount) FILTER (WHERE type='ingreso'),0) AS ingresos,
             COALESCE(SUM(amount) FILTER (WHERE type IN ('egreso','inversion')),0) AS egresos
      FROM manual_transactions WHERE tx_date >= $1 AND tx_date <= $2
      GROUP BY currency, tx_date ORDER BY currency, tx_date
    `, [startDate, endDate]).catch(() => ({ rows: [] })),
    pool.query(`SELECT bs_per_usd FROM exchange_rates ORDER BY rate_date DESC LIMIT 1`)
      .catch(() => ({ rows: [] })),
  ]);

  const rate = rateRow.rows[0]?.bs_per_usd || null;

  // Construir BS
  const bsChart     = fillGaps(
    bsRows.rows.map((r) => ({ date: String(r.date).split("T")[0], ingresos: Number(r.ingresos), egresos: Number(r.egresos) })),
    start, new Date(end.getTime() - 86400000), { ingresos: 0, egresos: 0 }
  );
  const bsIngresos  = bsChart.reduce((s, r) => s + r.ingresos, 0);
  const bsEgresos   = bsChart.reduce((s, r) => s + r.egresos, 0);

  // Agrupar otras monedas
  const currencies = {};
  for (const r of manualRows.rows) {
    const cur = r.currency;
    if (!currencies[cur]) currencies[cur] = { rows: [], ingresos: 0, egresos: 0 };
    currencies[cur].rows.push({ date: r.date, ingresos: Number(r.ingresos), egresos: Number(r.egresos) });
    currencies[cur].ingresos += Number(r.ingresos);
    currencies[cur].egresos  += Number(r.egresos);
  }

  const byCurrency = {
    BS: {
      ingresos: bsIngresos,
      egresos:  bsEgresos,
      balance:  bsIngresos - bsEgresos,
      chart:    bsChart.map((r) => ({ ...r, balance: r.ingresos - r.egresos })),
    },
  };
  for (const [cur, d] of Object.entries(currencies)) {
    byCurrency[cur] = {
      ingresos: d.ingresos, egresos: d.egresos, balance: d.ingresos - d.egresos,
      chart:    d.rows.map((r) => ({ ...r, balance: r.ingresos - r.egresos })),
    };
  }

  return { period: label, by_currency: byCurrency, exchange_rate: rate };
}

// ─── GASTOS ───────────────────────────────────────────────────────────────────

async function getExpenses({ start, end }) {
  const startDate = start.toISOString().split("T")[0];
  const endDate   = new Date(end.getTime() - 86400000).toISOString().split("T")[0];

  const [byCat, byType, unjust, rateRow] = await Promise.all([
    pool.query(`
      SELECT ec.name AS category, ec.type, COALESCE(SUM(bs.amount),0) AS amount_bs, COUNT(*) AS transactions
      FROM bank_statements bs
      JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
      JOIN expense_categories ec ON ec.id = dj.expense_category_id
      WHERE bs.tx_type='DEBIT' AND bs.tx_date >= $1 AND bs.tx_date <= $2
      GROUP BY ec.name, ec.type ORDER BY amount_bs DESC
    `, [startDate, endDate]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT ec.type, COALESCE(SUM(bs.amount),0) AS amount_bs
      FROM bank_statements bs
      JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
      JOIN expense_categories ec ON ec.id = dj.expense_category_id
      WHERE bs.tx_type='DEBIT' AND bs.tx_date >= $1 AND bs.tx_date <= $2
      GROUP BY ec.type
    `, [startDate, endDate]).catch(() => ({ rows: [] })),
    pool.query(`
      SELECT bs.id, bs.tx_date, bs.amount AS amount_bs, bs.description,
             bs.reference_number, bs.payment_type,
             CURRENT_DATE - bs.tx_date AS days_pending
      FROM bank_statements bs
      LEFT JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
      WHERE bs.tx_type='DEBIT' AND dj.id IS NULL
      ORDER BY bs.tx_date ASC LIMIT 50
    `).catch(() => ({ rows: [] })),
    pool.query(`SELECT bs_per_usd FROM exchange_rates ORDER BY rate_date DESC LIMIT 1`)
      .catch(() => ({ rows: [] })),
  ]);

  const rate    = Number(rateRow.rows[0]?.bs_per_usd || 0);
  const totalBs = byCat.rows.reduce((s, r) => s + Number(r.amount_bs), 0);
  const typeTot = byType.rows.reduce((s, r) => s + Number(r.amount_bs), 0);

  return {
    total_bs:       totalBs,
    total_usd_equiv: rate > 0 ? Number((totalBs / rate).toFixed(2)) : null,
    by_category: byCat.rows.map((r) => ({
      category:     r.category,
      type:         r.type,
      amount_bs:    Number(r.amount_bs),
      pct:          calcPct(Number(r.amount_bs), totalBs),
      transactions: Number(r.transactions),
    })),
    by_type: byType.rows.map((r) => ({
      type:      r.type,
      amount_bs: Number(r.amount_bs),
      pct:       calcPct(Number(r.amount_bs), typeTot),
    })),
    unjustified_debits: unjust.rows.map((r) => ({
      id:               Number(r.id),
      tx_date:          r.tx_date,
      amount_bs:        Number(r.amount_bs),
      description:      r.description,
      reference_number: r.reference_number,
      days_pending:     Number(r.days_pending || 0),
    })),
  };
}

// ─── P&L ──────────────────────────────────────────────────────────────────────

async function getPnl({ start, end, label }) {
  const startDate = start.toISOString().split("T")[0];
  const endDate   = new Date(end.getTime() - 86400000).toISOString().split("T")[0];

  const [revenueRow, expRow, monthRows] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(order_total_amount) FILTER (WHERE source='mercadolibre'),0)  AS mercadolibre,
        COALESCE(SUM(order_total_amount) FILTER (WHERE source='mostrador'),0)     AS mostrador,
        COALESCE(SUM(order_total_amount) FILTER (WHERE source='ecommerce'),0)     AS ecommerce,
        COALESCE(SUM(order_total_amount) FILTER (WHERE source='social_media'),0)  AS social_media,
        COALESCE(SUM(order_total_amount),0)                                       AS total_bs,
        COALESCE(SUM(order_total_amount / NULLIF(exchange_rate_bs_per_usd,0)),0)  AS total_usd
      FROM sales_orders WHERE status='paid' AND created_at >= $1 AND created_at < $2
    `, [start, end]),
    pool.query(`
      SELECT COALESCE(SUM(bs.amount),0) AS total_debit
      FROM bank_statements bs
      WHERE bs.tx_type='DEBIT' AND bs.tx_date >= $1 AND bs.tx_date <= $2
    `, [startDate, endDate]).catch(() => ({ rows: [{ total_debit: 0 }] })),
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at AT TIME ZONE 'America/Caracas'), 'YYYY-MM') AS month,
        COALESCE(SUM(order_total_amount) FILTER (WHERE status='paid'),0) AS revenue_bs
      FROM sales_orders WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY 1
    `, [start, end]),
  ]);

  const rev       = revenueRow.rows[0];
  const totalRev  = Number(rev.total_bs);
  const totalExp  = Number(expRow.rows[0].total_debit);
  const grossProfit = totalRev - totalExp;

  return {
    period:   label,
    revenue: {
      mercadolibre: Number(rev.mercadolibre),
      mostrador:    Number(rev.mostrador),
      ecommerce:    Number(rev.ecommerce),
      social_media: Number(rev.social_media),
      total_bs:     totalRev,
      total_usd:    Number(Number(rev.total_usd).toFixed(2)),
    },
    expenses: { total_bs: totalExp },
    gross_profit_bs:  Number(grossProfit.toFixed(2)),
    gross_margin_pct: calcPct(grossProfit, totalRev),
    chart_monthly: monthRows.rows.map((r) => ({
      month:       r.month,
      revenue_bs:  Number(r.revenue_bs),
    })),
  };
}

// ─── TASAS DE CAMBIO ─────────────────────────────────────────────────────────

async function getExchangeRates({ start, end }) {
  const { rows } = await pool.query(`
    SELECT rate_date, bs_per_usd FROM exchange_rates
    WHERE rate_date >= $1 AND rate_date <= $2
    ORDER BY rate_date ASC
  `, [start.toISOString().split("T")[0], new Date(end.getTime() - 86400000).toISOString().split("T")[0]])
    .catch(() => ({ rows: [] }));

  const latest    = rows[rows.length - 1];
  const first     = rows[0];
  const changePct = first && latest && first.bs_per_usd !== latest.bs_per_usd
    ? calcChange(Number(latest.bs_per_usd), Number(first.bs_per_usd))
    : 0;

  return {
    current_rate:      latest ? Number(latest.bs_per_usd) : null,
    rate_date:         latest ? latest.rate_date : null,
    chart:             rows.map((r) => ({ date: String(r.rate_date).split("T")[0], bs_per_usd: Number(r.bs_per_usd) })),
    change_pct_month:  changePct,
  };
}

module.exports = {
  getOverview,
  getRealtime,
  getSales,
  getSalesHourly,
  getSalesProducts,
  getCustomers,
  getCustomerVehicles,
  getWhatsapp,
  getMercadoLibre,
  getReconciliationStats,
  getCashflow,
  getExpenses,
  getPnl,
  getExchangeRates,
  getInventoryStats,
};
