'use strict';

/**
 * Ferrari ERP — ML Orders: reserva automática de stock por webhook orders_v2.
 *
 * IMPORTANTE: Este módulo es distinto de src/services/mlService.js (gestión
 * de ítems ML: pausa, activar, precio). Este módulo gestiona las ÓRDENES.
 *
 * Integración: server.js llama a processErpWebhook() desde el handler
 * existente de orders_v2, pasando el payload ya resuelto (sin re-fetch).
 * Controlado por ML_ERP_ORDERS_ENABLED=1.
 *
 * No lanza excepciones hacia arriba — cada función captura sus propios errores.
 */

const { pool } = require('../../db-postgres');
const { reserveStock } = require('./wmsService');

const ML_API_BASE = 'https://api.mercadolibre.com';

// ──────────────────────────────────────────────────────────────────────────────
// cancelOrderInMl — POST /orders/:id/cancel en ML API
// NUNCA lanza excepción. Si falla → loggear y retornar false.
// ──────────────────────────────────────────────────────────────────────────────
async function cancelOrderInMl(mlOrderId) {
  const token = String(process.env.ML_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.warn('[mlOrder] ML_ACCESS_TOKEN no definido — no se puede cancelar en ML');
    return false;
  }
  try {
    const res = await fetch(`${ML_API_BASE}/orders/${mlOrderId}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      console.error(`[mlOrder] Error cancelando orden ${mlOrderId} en ML: HTTP ${res.status}`);
      return false;
    }
    console.log(`[mlOrder] Orden ${mlOrderId} cancelada en ML por sin stock`);
    return true;
  } catch (err) {
    console.error(`[mlOrder] Exception cancelando orden ${mlOrderId}:`, err.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// resolveSkuForItem — busca en ml_item_sku_map el SKU y la no_stock_action.
// Primero: match exacto con ml_variation_id.
// Si no:   match con ml_variation_id IS NULL (genérico).
// Retorna { product_sku, no_stock_action } o null si sin mapeo.
// ──────────────────────────────────────────────────────────────────────────────
async function resolveSkuForItem(mlItemId, mlVariationId, companyId) {
  const cid = companyId || 1;
  const { rows: [row] } = await pool.query(
    `SELECT m.product_sku,
            COALESCE(m.no_stock_action,
                     p.ml_no_stock_action,
                     'ALERT_ONLY') AS no_stock_action
     FROM ml_item_sku_map m
     JOIN products p ON p.sku = m.product_sku
     WHERE m.ml_item_id  = $1
       AND m.company_id  = $2
       AND m.is_active   = TRUE
       AND (m.ml_variation_id = $3
            OR m.ml_variation_id IS NULL)
     ORDER BY m.ml_variation_id NULLS LAST
     LIMIT 1`,
    [mlItemId, cid, mlVariationId || null]
  );
  return row || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// findBestBinForSku — bin ACTIVO con más stock disponible para el SKU.
// Primero busca uno con qty >= qtyNeeded.
// Si no → el de mayor qty disponible (para PARTIAL).
// ──────────────────────────────────────────────────────────────────────────────
async function findBestBinForSku(sku, qtyNeeded) {
  const { rows: [sufficient] } = await pool.query(
    `SELECT bs.bin_id, bs.qty_available
     FROM bin_stock bs
     JOIN warehouse_bins wb ON wb.id = bs.bin_id
     WHERE bs.product_sku   = $1
       AND bs.qty_available >= $2
       AND wb.status         = 'ACTIVE'
     ORDER BY bs.qty_available DESC
     LIMIT 1`,
    [sku, qtyNeeded]
  );
  if (sufficient) {
    return { binId: sufficient.bin_id, qtyAvailable: sufficient.qty_available };
  }
  const { rows: [partial] } = await pool.query(
    `SELECT bs.bin_id, bs.qty_available
     FROM bin_stock bs
     JOIN warehouse_bins wb ON wb.id = bs.bin_id
     WHERE bs.product_sku  = $1
       AND bs.qty_available > 0
       AND wb.status        = 'ACTIVE'
     ORDER BY bs.qty_available DESC
     LIMIT 1`,
    [sku]
  );
  return {
    binId:        partial?.bin_id        || null,
    qtyAvailable: partial?.qty_available || 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// upsertOrderItems — upsert de cada ítem de la orden en ml_order_items.
// Llama a resolveSkuForItem() para poblar product_sku.
// ──────────────────────────────────────────────────────────────────────────────
async function upsertOrderItems(orderId, orderItems, companyId) {
  const cid = companyId || 1;
  for (const item of (orderItems || [])) {
    const mlItemId      = item.item && item.item.id   ? String(item.item.id) : null;
    const mlVariationId = item.item && item.item.variation_id
                          ? Number(item.item.variation_id) : null;
    if (!mlItemId) continue;

    const mapped = await resolveSkuForItem(mlItemId, mlVariationId, cid);

    await pool.query(
      `INSERT INTO ml_order_items (
         order_id, company_id, ml_item_id, ml_variation_id,
         title, quantity, unit_price, currency_id, product_sku
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (order_id, ml_item_id) DO UPDATE SET
         quantity    = EXCLUDED.quantity,
         product_sku = EXCLUDED.product_sku,
         updated_at  = now()`,
      [
        orderId, cid, mlItemId, mlVariationId,
        item.item && item.item.title ? item.item.title : null,
        item.quantity || 1,
        item.unit_price || null,
        item.currency_id || null,
        mapped ? mapped.product_sku : null,
      ]
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// processReservations — lógica principal de reserva/alerta por ítem.
// Retorna { reserved, noStock, noSkuMap, backorder, erpStatus }.
// ──────────────────────────────────────────────────────────────────────────────
async function processReservations(orderId, orderItems, companyId) {
  const cid = companyId || 1;
  let reserved  = 0;
  let noStock   = 0;
  let noSkuMap  = 0;
  let backorder = 0;

  for (const item of (orderItems || [])) {
    const mlItemId      = item.item && item.item.id ? String(item.item.id) : null;
    const mlVariationId = item.item && item.item.variation_id
                          ? Number(item.item.variation_id) : null;
    const qtyOrdered    = item.quantity || 1;
    if (!mlItemId) continue;

    const mapped = await resolveSkuForItem(mlItemId, mlVariationId, cid);

    if (!mapped) {
      noSkuMap++;
      await pool.query(
        `INSERT INTO ml_stock_alerts (
           company_id, order_id, ml_item_id,
           qty_ordered, qty_available, alert_type, action_taken
         ) VALUES ($1,$2,$3,$4,0,'NO_SKU_MAP','ALERT_ONLY')
         ON CONFLICT (order_id, ml_item_id) DO NOTHING`,
        [cid, orderId, mlItemId, qtyOrdered]
      );
      await pool.query(
        `UPDATE ml_order_items SET
           reservation_status    = 'NO_SKU_MAP',
           no_stock_action_taken = 'ALERT_ONLY',
           updated_at            = now()
         WHERE order_id = $1 AND ml_item_id = $2`,
        [orderId, mlItemId]
      );
      console.log(`[mlOrder] Sin SKU mapeado: item=${mlItemId} orden=${orderId}`);
      continue;
    }

    const { product_sku: sku, no_stock_action: action } = mapped;
    const { binId, qtyAvailable } = await findBestBinForSku(sku, qtyOrdered);

    if (binId && Number(qtyAvailable) >= qtyOrdered) {
      try {
        await reserveStock({
          binId,
          sku,
          qty:           qtyOrdered,
          referenceType: 'ml_order',
          referenceId:   String(orderId),
          userId:        null,
        });
        await pool.query(
          `UPDATE ml_order_items SET
             reservation_status = 'RESERVED',
             reserved_qty       = $1,
             reserved_bin_id    = $2,
             updated_at         = now()
           WHERE order_id = $3 AND ml_item_id = $4`,
          [qtyOrdered, binId, orderId, mlItemId]
        );
        reserved++;
        console.log(
          `[mlOrder] Reservado: SKU=${sku} QTY=${qtyOrdered} BIN=${binId} orden=${orderId}`
        );
      } catch (err) {
        noStock++;
        console.error(`[mlOrder] Error reserveStock SKU=${sku}:`, err.message);
      }
      continue;
    }

    // Sin stock suficiente → ejecutar acción configurada
    noStock++;
    const alertType = Number(qtyAvailable) > 0 ? 'PARTIAL' : 'NO_STOCK';

    await pool.query(
      `INSERT INTO ml_stock_alerts (
         company_id, order_id, ml_item_id,
         product_sku, qty_ordered, qty_available,
         alert_type, action_taken
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (order_id, ml_item_id) DO NOTHING`,
      [cid, orderId, mlItemId, sku, qtyOrdered, qtyAvailable, alertType, action]
    );

    if (action === 'CANCEL_ML') {
      await cancelOrderInMl(orderId);
      await pool.query(
        `UPDATE ml_order_items SET
           reservation_status    = 'NO_STOCK',
           no_stock_action_taken = 'CANCEL_ML',
           updated_at            = now()
         WHERE order_id = $1 AND ml_item_id = $2`,
        [orderId, mlItemId]
      );
    } else if (action === 'BACKORDER') {
      backorder++;
      await pool.query(
        `UPDATE ml_order_items SET
           reservation_status    = 'BACKORDER',
           no_stock_action_taken = 'BACKORDER',
           updated_at            = now()
         WHERE order_id = $1 AND ml_item_id = $2`,
        [orderId, mlItemId]
      );
    } else {
      // ALERT_ONLY (default)
      await pool.query(
        `UPDATE ml_order_items SET
           reservation_status    = 'NO_STOCK',
           no_stock_action_taken = 'ALERT_ONLY',
           updated_at            = now()
         WHERE order_id = $1 AND ml_item_id = $2`,
        [orderId, mlItemId]
      );
    }

    console.log(
      `[mlOrder] Sin stock: SKU=${sku} disponible=${qtyAvailable}/${qtyOrdered}` +
      ` acción=${action} orden=${orderId}`
    );
  }

  // Calcular erp_status final
  let erpStatus;
  if (reserved > 0 && noStock === 0 && noSkuMap === 0) {
    erpStatus = 'RESERVED';
  } else if (reserved > 0 && (noStock > 0 || noSkuMap > 0)) {
    erpStatus = 'PARTIAL';
  } else if (backorder > 0) {
    erpStatus = 'BACKORDER';
  } else {
    erpStatus = 'NO_STOCK';
  }

  // Si todos los ítems se cancelaron en ML → CANCELLED_NO_STOCK
  try {
    const { rows: [check] } = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (
                WHERE no_stock_action_taken = 'CANCEL_ML'
              ) AS cancelled
       FROM ml_order_items WHERE order_id = $1`,
      [orderId]
    );
    if (check && +check.cancelled > 0 && +check.cancelled === +check.total) {
      erpStatus = 'CANCELLED_NO_STOCK';
    }
  } catch (e) {
    console.error('[mlOrder] Error check CANCEL_ML total:', e.message);
  }

  await pool.query(
    `UPDATE ml_orders SET
       erp_status        = $1,
       reserved_at       = CASE WHEN $1 IN ('RESERVED','PARTIAL')
                           THEN now() ELSE NULL END,
       reservation_error = CASE
         WHEN $1 IN ('NO_STOCK','PARTIAL','CANCELLED_NO_STOCK')
         THEN 'Ver ml_stock_alerts para detalles'
         ELSE NULL
       END,
       updated_at        = now()
     WHERE order_id = $2`,
    [erpStatus, orderId]
  );

  return { reserved, noStock, noSkuMap, backorder, erpStatus };
}

// ──────────────────────────────────────────────────────────────────────────────
// processErpWebhook — punto de entrada desde server.js (orders_v2 handler).
//
// Recibe el payload ya resuelto de ML (sin re-fetch) para evitar
// duplicar la llamada a la API que ya hace scheduleTopicFetchFromWebhook().
//
// NUNCA lanza excepción.
// Controlado por: ML_ERP_ORDERS_ENABLED=1
// ──────────────────────────────────────────────────────────────────────────────
async function processErpWebhook({ orderData, mlUserId }) {
  if (!orderData || typeof orderData !== 'object') return;

  const orderId = orderData.id != null ? Number(orderData.id) : NaN;
  if (!Number.isFinite(orderId) || orderId <= 0) return;

  console.log(`[mlOrder] ERP webhook orden ${orderId} iniciando...`);

  // Verificar si ya fue procesada (erp_status != PENDING)
  let currentErpStatus = 'PENDING';
  try {
    const { rows: [existing] } = await pool.query(
      `SELECT erp_status FROM ml_orders WHERE order_id = $1 LIMIT 1`,
      [orderId]
    );
    if (existing) {
      currentErpStatus = existing.erp_status || 'PENDING';
      // Incrementar webhook_attempts siempre
      await pool.query(
        `UPDATE ml_orders SET
           webhook_attempts = COALESCE(webhook_attempts, 0) + 1,
           updated_at       = now()
         WHERE order_id = $1`,
        [orderId]
      );
    }
  } catch (err) {
    console.error(`[mlOrder] Error consultando erp_status orden ${orderId}:`, err.message);
    return;
  }

  if (currentErpStatus !== 'PENDING') {
    console.log(
      `[mlOrder] Orden ${orderId} ya procesada (erp_status=${currentErpStatus}) — skip`
    );
    return;
  }

  const items = orderData.order_items || [];
  if (items.length === 0) {
    console.log(`[mlOrder] Orden ${orderId} sin ítems — skip reservas`);
    return;
  }

  // Upsert de líneas de la orden
  try {
    await upsertOrderItems(orderId, items, 1);
  } catch (err) {
    console.error(`[mlOrder] Error upsertOrderItems orden ${orderId}:`, err.message);
    return;
  }

  // Reservar stock inmediatamente (sin esperar pago)
  try {
    const result = await processReservations(orderId, items, 1);
    console.log(
      `[mlOrder] Reservas orden ${orderId}: ` +
      `reserved=${result.reserved} noStock=${result.noStock} ` +
      `noSkuMap=${result.noSkuMap} backorder=${result.backorder} ` +
      `erp_status=${result.erpStatus}`
    );
  } catch (err) {
    console.error(`[mlOrder] Error processReservations orden ${orderId}:`, err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// getOrder — detalle de una orden con sus ítems y alertas
// ──────────────────────────────────────────────────────────────────────────────
async function getOrder(mlOrderId) {
  const oid = Number(mlOrderId);
  if (!Number.isFinite(oid) || oid <= 0) return null;

  const { rows: [order] } = await pool.query(
    `SELECT * FROM ml_orders WHERE order_id = $1`,
    [oid]
  );
  if (!order) return null;

  const [{ rows: items }, { rows: alerts }] = await Promise.all([
    pool.query(
      `SELECT moi.*, p.description AS descripcion
       FROM ml_order_items moi
       LEFT JOIN products p ON p.sku = moi.product_sku
       WHERE moi.order_id = $1 ORDER BY moi.id`,
      [oid]
    ),
    pool.query(
      `SELECT * FROM ml_stock_alerts
       WHERE order_id = $1 ORDER BY created_at`,
      [oid]
    ),
  ]);

  return { order, items, alerts };
}

// ──────────────────────────────────────────────────────────────────────────────
// listOrders — ml_orders con filtros ERP opcionales
// ──────────────────────────────────────────────────────────────────────────────
async function listOrders({ erpStatus, paymentStatus, limit = 50, offset = 0 } = {}) {
  const conds  = [];
  const params = [];

  if (erpStatus) {
    params.push(erpStatus);
    conds.push(`erp_status = $${params.length}`);
  }
  if (paymentStatus) {
    params.push(paymentStatus);
    // ml_orders.status es el campo de estado ML (confirmed, paid, cancelled…)
    conds.push(`status = $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const [{ rows: orders }, { rows: [{ count }] }] = await Promise.all([
    pool.query(
      `SELECT * FROM ml_orders ${where}
       ORDER BY id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM ml_orders ${where}`,
      params
    ),
  ]);

  return { orders, total: +count };
}

// ──────────────────────────────────────────────────────────────────────────────
// listAlerts — alertas de stock con filtro de resolución
// ──────────────────────────────────────────────────────────────────────────────
async function listAlerts({ isResolved = false, limit = 50, offset = 0 } = {}) {
  const [{ rows: alerts }, { rows: [{ count }] }] = await Promise.all([
    pool.query(
      `SELECT * FROM ml_stock_alerts WHERE is_resolved = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [isResolved, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM ml_stock_alerts WHERE is_resolved = $1`,
      [isResolved]
    ),
  ]);
  return { alerts, total: +count };
}

// ──────────────────────────────────────────────────────────────────────────────
// resolveAlert — marcar alerta como resuelta
// ──────────────────────────────────────────────────────────────────────────────
async function resolveAlert({ alertId, userId, notes }) {
  const { rows: [alert] } = await pool.query(
    `UPDATE ml_stock_alerts SET
       is_resolved      = TRUE,
       resolved_at      = now(),
       resolved_by      = $1,
       resolution_notes = $2
     WHERE id = $3 RETURNING *`,
    [userId || null, notes || null, alertId]
  );
  return alert || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// addSkuMap — mapear item_id de ML a SKU de Ferrari (upsert)
// ──────────────────────────────────────────────────────────────────────────────
async function addSkuMap({ mlItemId, mlVariationId, productSku, noStockAction, companyId = 1 }) {
  const { rows: [map] } = await pool.query(
    `INSERT INTO ml_item_sku_map (
       company_id, ml_item_id, ml_variation_id,
       product_sku, no_stock_action
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, ml_item_id, ml_variation_id) DO UPDATE SET
       product_sku     = EXCLUDED.product_sku,
       no_stock_action = EXCLUDED.no_stock_action,
       is_active       = TRUE,
       updated_at      = now()
     RETURNING *`,
    [companyId, mlItemId, mlVariationId || null, productSku, noStockAction || null]
  );
  return map;
}

// ──────────────────────────────────────────────────────────────────────────────
// listSkuMaps — listar mapeos SKU activos
// ──────────────────────────────────────────────────────────────────────────────
async function listSkuMaps({ companyId = 1, limit = 100, offset = 0 } = {}) {
  const [{ rows }, { rows: [{ count }] }] = await Promise.all([
    pool.query(
      `SELECT m.*, p.description AS descripcion
       FROM ml_item_sku_map m
       LEFT JOIN products p ON p.sku = m.product_sku
       WHERE m.company_id = $1 AND m.is_active = TRUE
       ORDER BY m.id DESC LIMIT $2 OFFSET $3`,
      [companyId, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM ml_item_sku_map WHERE company_id = $1 AND is_active = TRUE`,
      [companyId]
    ),
  ]);
  return { maps: rows, total: +count };
}

module.exports = {
  processErpWebhook,
  getOrder,
  listOrders,
  listAlerts,
  resolveAlert,
  addSkuMap,
  listSkuMaps,
};
