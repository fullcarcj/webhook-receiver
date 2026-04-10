'use strict';
const cron = require('node-cron');
const { pool } = require('../../db');
const { triggerAutoPause, triggerAutoActivate } = require('../services/mlPublicationsService');

let log;
try { log = require('pino')(); } catch { log = console; }

const BATCH_SIZE    = 500;
const ANALYSIS_DAYS = 30;

function notifyMlByStockTransition(productId, qtyBefore, qtyAfter) {
  if (qtyAfter <= 0 && qtyBefore > 0) {
    triggerAutoPause(productId).catch((err) => {
      log.error && log.error({ err: err.message, productId }, 'Error auto-pause ML');
    });
    return;
  }
  if (qtyAfter > 0 && qtyBefore <= 0) {
    triggerAutoActivate(productId, qtyAfter).catch((err) => {
      log.error && log.error({ err: err.message, productId }, 'Error auto-activate ML');
    });
  }
}

// ── Proyección individual ────────────────────────────────────────────────────

async function calculateProductProjection(product, stats) {
  // 1. Velocidad de ventas (últimos 30 días)
  const { rows: salesData } = await pool.query(`
    SELECT COALESCE(SUM(soi.quantity), 0) AS total_sold
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    WHERE soi.product_id = $1
      AND so.status IN ('paid','shipped','delivered')
      AND so.created_at >= NOW() - INTERVAL '${ANALYSIS_DAYS} days'
  `, [product.product_id]);

  const totalSold      = Number(salesData[0]?.total_sold ?? 0);
  const avgDailySales  = totalSold / ANALYSIS_DAYS;
  const avgWeeklySales = avgDailySales * 7;
  const avgMonthlySales = avgDailySales * 30;

  // 2. Punto de reorden = avg_daily × lead_time × safety_factor
  const leadTime     = product.lead_time_days || 7;
  const safetyFactor = Number(product.safety_factor) || 1.5;
  const reorderPoint = avgDailySales * leadTime * safetyFactor;

  // 3. Días hasta agotarse
  const stockQty       = Number(product.stock_qty) || 0;
  const daysToStockout = avgDailySales > 0
    ? Math.floor(stockQty / avgDailySales)
    : null;

  // 4. Cantidad sugerida de compra (cubrir 30 días + buffer)
  const targetDays      = 30 + leadTime * safetyFactor;
  const suggestedOrderQty = Math.max(0, avgDailySales * targetDays - stockQty);

  // 5. Tendencia (últimos 15 días vs 15 anteriores)
  const { rows: trendData } = await pool.query(`
    SELECT
      COALESCE(SUM(soi.quantity) FILTER (
        WHERE so.created_at >= NOW() - INTERVAL '15 days'
      ), 0) AS recent_15,
      COALESCE(SUM(soi.quantity) FILTER (
        WHERE so.created_at >= NOW() - INTERVAL '30 days'
          AND so.created_at <  NOW() - INTERVAL '15 days'
      ), 0) AS prev_15
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    WHERE soi.product_id = $1
      AND so.status IN ('paid','shipped','delivered')
  `, [product.product_id]);

  const recent = Number(trendData[0]?.recent_15 ?? 0);
  const prev   = Number(trendData[0]?.prev_15 ?? 0);
  let velocityTrend = 'no_data';
  if (recent > 0 || prev > 0) {
    if      (recent > prev * 1.2) velocityTrend = 'rising';
    else if (recent < prev * 0.8) velocityTrend = 'falling';
    else                          velocityTrend = 'stable';
  }

  // 6. ¿Necesita alerta?
  const needsAlert = reorderPoint > 0 && stockQty <= reorderPoint;

  // 7. Upsert en inventory_projections
  await pool.query(`
    INSERT INTO inventory_projections
      (product_id, avg_daily_sales, avg_weekly_sales, avg_monthly_sales,
       days_to_stockout, reorder_point, suggested_order_qty,
       velocity_trend, last_calculated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (product_id) DO UPDATE SET
      avg_daily_sales     = EXCLUDED.avg_daily_sales,
      avg_weekly_sales    = EXCLUDED.avg_weekly_sales,
      avg_monthly_sales   = EXCLUDED.avg_monthly_sales,
      days_to_stockout    = EXCLUDED.days_to_stockout,
      reorder_point       = EXCLUDED.reorder_point,
      suggested_order_qty = EXCLUDED.suggested_order_qty,
      velocity_trend      = EXCLUDED.velocity_trend,
      last_calculated_at  = NOW()
  `, [
    product.product_id,
    avgDailySales, avgWeeklySales, avgMonthlySales,
    daysToStockout, reorderPoint, suggestedOrderQty,
    velocityTrend,
  ]);

  // 8. Actualizar stock_alert y stock_min en inventory
  await pool.query(`
    UPDATE inventory
    SET stock_min   = $1,
        stock_alert = $2,
        updated_at  = NOW()
    WHERE product_id = $3
  `, [reorderPoint, needsAlert, product.product_id]);

  if (needsAlert) {
    stats.alerts_triggered++;
    try {
      const { emit } = require('../services/sseService');
      emit('inventory_alert', {
        product_id:       product.product_id,
        sku:              product.sku,
        name:             product.name,
        stock_qty:        stockQty,
        reorder_point:    reorderPoint,
        days_to_stockout: daysToStockout,
        suggested_qty:    suggestedOrderQty,
      });
    } catch (_) { /* SSE opcional */ }
  }

  if (daysToStockout !== null && daysToStockout <= leadTime) {
    stats.stockouts_imminent++;
    log.warn && log.warn({
      sku: product.sku, days_to_stockout: daysToStockout, lead_time: leadTime,
    }, 'AGOTAMIENTO INMINENTE');
  }
}

// ── Cálculo de todas las proyecciones (por lotes) ────────────────────────────

async function calculateProjections() {
  const stats = {
    processed: 0, alerts_triggered: 0,
    stockouts_imminent: 0, errors: 0,
  };

  let offset  = 0;
  let hasMore = true;

  while (hasMore) {
    const { rows: products } = await pool.query(`
      SELECT
        p.id AS product_id, p.sku, p.name,
        i.stock_qty, i.stock_min, i.lead_time_days,
        i.safety_factor, i.supplier_id
      FROM products p
      JOIN inventory i ON i.product_id = p.id
      WHERE p.is_active = TRUE
      ORDER BY p.id ASC
      LIMIT $1 OFFSET $2
    `, [BATCH_SIZE, offset]);

    if (!products.length) { hasMore = false; break; }

    for (const product of products) {
      try {
        await calculateProductProjection(product, stats);
        stats.processed++;
      } catch (err) {
        stats.errors++;
        log.error && log.error({ err: err.message, sku: product.sku }, 'Error proyección');
      }
    }

    offset += BATCH_SIZE;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  log.info && log.info(stats, 'Worker inventario completado');
  return stats;
}

// ── Generar orden de compra sugerida ─────────────────────────────────────────

async function generateSuggestedPurchaseOrder(supplierId = null) {
  const { rows: items } = await pool.query(`
    SELECT
      p.id AS product_id, p.sku, p.name, p.unit_price_usd,
      ip.suggested_order_qty, ip.days_to_stockout,
      i.stock_qty, i.lead_time_days, i.supplier_id
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = p.id
    WHERE i.stock_alert = TRUE
      AND ip.suggested_order_qty > 0
      AND ($1::bigint IS NULL OR i.supplier_id = $1)
    ORDER BY ip.days_to_stockout ASC NULLS LAST
    LIMIT 200
  `, [supplierId || null]);

  if (!items.length) return null;

  const totalUsd = items.reduce((sum, item) =>
    sum + (Number(item.suggested_order_qty) * Number(item.unit_price_usd || 0)), 0
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(`
      INSERT INTO purchase_orders (supplier_id, status, total_usd)
      VALUES ($1, 'suggested', $2)
      RETURNING id
    `, [supplierId || null, totalUsd]);

    for (const item of items) {
      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, product_id, sku, name,
           qty_suggested, unit_price_usd, subtotal_usd,
           reason, days_to_stockout)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        order.id, item.product_id, item.sku, item.name,
        item.suggested_order_qty, item.unit_price_usd,
        Number(item.suggested_order_qty) * Number(item.unit_price_usd || 0),
        Number(item.stock_qty) <= 0 ? 'out_of_stock' : 'stock_below_min',
        item.days_to_stockout,
      ]);
    }

    await client.query('COMMIT');
    log.info && log.info(
      { order_id: order.id, items: items.length, total_usd: totalUsd },
      'Orden de compra sugerida generada'
    );
    return order.id;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Arranque del worker (cron 2:00 AM Venezuela) ─────────────────────────────

function startInventoryWorker() {
  if (process.env.NODE_ENV === 'test') return;

  cron.schedule('0 2 * * *', async () => {
    log.info && log.info('Worker inventario iniciado — cálculo de proyecciones');
    try {
      await calculateProjections();
      await generateSuggestedPurchaseOrder();
    } catch (err) {
      log.error && log.error({ err: err.message }, 'Error en worker inventario');
    }
  }, { timezone: 'America/Caracas' });

  log.info && log.info('Worker inventario programado — 2:00 AM Venezuela diario');
}

function stopInventoryWorker() {
  // node-cron no expone un método global de stop sencillo;
  // el proceso termina limpiamente al recibir SIGTERM
}

module.exports = {
  startInventoryWorker,
  stopInventoryWorker,
  calculateProjections,
  generateSuggestedPurchaseOrder,
  notifyMlByStockTransition,
};
