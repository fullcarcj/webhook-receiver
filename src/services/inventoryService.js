'use strict';
const { pool } = require('../../db');
const pino = require('pino');
const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'inventory_service' });

function maybeSyncMlPublicationState(productId, qtyBefore, qtyAfter) {
  if (qtyAfter <= 0 && qtyBefore > 0) {
    const { triggerAutoPause } = require('./mlPublicationsService');
    triggerAutoPause(productId).catch((err) => {
      log.error({ err: err.message, productId }, 'inventory_service: error triggerAutoPause');
    });
  } else if (qtyAfter > 0 && qtyBefore <= 0) {
    const { triggerAutoActivate } = require('./mlPublicationsService');
    triggerAutoActivate(productId, qtyAfter).catch((err) => {
      log.error({ err: err.message, productId }, 'inventory_service: error triggerAutoActivate');
    });
  }
}

// ── Catálogo + Stock ─────────────────────────────────────────────────────────

async function listProducts({ limit = 50, offset = 0, alert, category, brand, search } = {}) {
  const params = [
    alert    !== undefined ? alert    : null,
    category !== undefined ? category : null,
    brand    !== undefined ? brand    : null,
    search   !== undefined ? search   : null,
    limit,
    offset,
  ];

  /**
   * Listado: sin JOIN a inventory_projections (el front solo usa sku, nombre, stock, etc.).
   * Ese JOIN + ventana COUNT(*) era muy caro en catálogos grandes y en cold start Render.
   */
  const listSql = `
    SELECT
      p.id, p.sku, p.name, p.description, p.category, p.brand,
      p.unit_price_usd, p.source, p.is_active,
      i.stock_qty, i.stock_min, i.stock_max, i.stock_alert,
      i.lead_time_days, i.safety_factor, i.supplier_id,
      COUNT(*) OVER() AS total_count
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    WHERE p.is_active = TRUE
      AND ($1::boolean IS NULL OR i.stock_alert = $1)
      AND ($2::text    IS NULL OR p.category = $2)
      AND ($3::text    IS NULL OR p.brand ILIKE '%' || $3 || '%')
      AND ($4::text    IS NULL OR p.sku ILIKE '%' || $4 || '%'
                               OR p.name ILIKE '%' || $4 || '%')
    ORDER BY
      i.stock_alert DESC,
      p.name ASC
    LIMIT $5 OFFSET $6
  `;

  const summarySql = `
    SELECT
      COUNT(*) FILTER (WHERE p.is_active)                        AS total_products,
      COUNT(*) FILTER (WHERE i.stock_alert)                      AS alerts_count,
      COUNT(*) FILTER (WHERE ip.days_to_stockout IS NOT NULL
                         AND ip.days_to_stockout <= i.lead_time_days) AS stockout_count
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
  `;

  const [{ rows }, summaryRes] = await Promise.all([
    pool.query(listSql, params),
    pool.query(summarySql),
  ]);

  const total = rows.length ? Number(rows[0].total_count) : 0;

  const [sumRow] = summaryRes.rows;

  return {
    products: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
    pagination: { total, limit, offset, has_more: offset + rows.length < total },
    summary: {
      total_products:  Number(sumRow.total_products),
      alerts_count:    Number(sumRow.alerts_count),
      stockout_count:  Number(sumRow.stockout_count),
      ok_count:        Number(sumRow.total_products) - Number(sumRow.alerts_count),
    },
  };
}

/** Baja lógica: deja de listarse en catálogo activo. */
async function deactivateProduct(productId) {
  const upd = await pool.query(
    `UPDATE products SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND is_active = TRUE
     RETURNING id`,
    [productId]
  );
  if (upd.rowCount) return { id: productId, deactivated: true };
  const { rows } = await pool.query(
    `SELECT id FROM products WHERE id = $1`,
    [productId]
  );
  if (!rows.length) return null;
  return { id: productId, already_inactive: true };
}

async function getProductById(id) {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.description, p.category, p.brand,
      p.unit_price_usd, p.source, p.source_id, p.is_active, p.created_at, p.updated_at,
      i.stock_qty, i.stock_min, i.stock_max, i.stock_alert,
      i.lead_time_days, i.safety_factor, i.supplier_id, i.last_purchase_at,
      ip.avg_daily_sales, ip.avg_weekly_sales, ip.avg_monthly_sales,
      ip.days_to_stockout, ip.reorder_point, ip.suggested_order_qty,
      ip.velocity_trend, ip.last_calculated_at
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
    WHERE p.id = $1
  `, [id]);
  return rows[0] || null;
}

async function searchProducts(q, { limit = 20 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.brand, p.unit_price_usd,
      i.stock_qty, i.stock_alert,
      ip.days_to_stockout
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
    WHERE p.is_active = TRUE
      AND (p.sku ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
    ORDER BY p.name ASC
    LIMIT $2
  `, [q, limit]);
  return rows;
}

async function getAlerts() {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.stock_min, i.lead_time_days, i.supplier_id,
      ip.days_to_stockout, ip.suggested_order_qty, ip.velocity_trend,
      CASE
        WHEN ip.days_to_stockout IS NOT NULL
          AND ip.days_to_stockout <= i.lead_time_days  THEN 'PEDIR_URGENTE'
        WHEN ip.days_to_stockout IS NOT NULL
          AND ip.days_to_stockout <= i.lead_time_days * 2 THEN 'PEDIR_PRONTO'
        ELSE 'MONITOREAR'
      END AS action
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
    WHERE p.is_active = TRUE AND i.stock_alert = TRUE
    ORDER BY ip.days_to_stockout ASC NULLS LAST
  `);

  const critical = rows.filter(r => r.action === 'PEDIR_URGENTE');
  const warning  = rows.filter(r => r.action !== 'PEDIR_URGENTE');

  const estInvestment = rows.reduce((sum, r) =>
    sum + Number(r.suggested_order_qty || 0) * Number(r.unit_price_usd || 0), 0
  );

  return {
    critical,
    warning,
    total_critical: critical.length,
    total_warning:  warning.length,
    estimated_investment_usd: Number(estInvestment.toFixed(2)),
  };
}

async function getImmStockouts() {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.lead_time_days,
      ip.avg_daily_sales, ip.days_to_stockout,
      ip.suggested_order_qty, ip.velocity_trend
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = p.id
    WHERE ip.days_to_stockout IS NOT NULL
      AND ip.days_to_stockout <= i.lead_time_days
    ORDER BY ip.days_to_stockout ASC
  `);
  return rows;
}

// ── Ajuste manual de stock ───────────────────────────────────────────────────

async function adjustStock(productId, { qty_change, type, notes, created_by, reference_id }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: inv } = await client.query(
      'SELECT stock_qty, stock_min FROM inventory WHERE product_id = $1 FOR UPDATE',
      [productId]
    );
    if (!inv.length) throw Object.assign(new Error('Producto sin registro de inventario'), { code: 'NOT_FOUND' });

    const qtyBefore = Number(inv[0].stock_qty);
    const qtyAfter  = qtyBefore + qty_change;
    if (qtyAfter < 0) throw Object.assign(new Error('Stock resultante negativo'), { code: 'NEGATIVE_STOCK' });

    const stockMin   = Number(inv[0].stock_min || 0);
    const stockAlert = qtyAfter <= stockMin;

    await client.query(`
      UPDATE inventory
      SET stock_qty = $1, stock_alert = $2, updated_at = NOW()
      WHERE product_id = $3
    `, [qtyAfter, stockAlert, productId]);

    await client.query(`
      INSERT INTO stock_movements
        (product_id, type, qty_before, qty_change, qty_after, reference_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [productId, type, qtyBefore, qty_change, qtyAfter, reference_id || null, notes, created_by]);

    await client.query('COMMIT');
    maybeSyncMlPublicationState(productId, qtyBefore, qtyAfter);
    return { product_id: productId, qty_before: qtyBefore, qty_change, qty_after: qtyAfter, stock_alert: stockAlert };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Configurar parámetros de reposición ─────────────────────────────────────

async function updateProductConfig(productId, { lead_time_days, safety_factor, stock_max, supplier_id }) {
  const sets = [];
  const vals = [];
  let idx = 1;

  if (lead_time_days !== undefined) { sets.push(`lead_time_days = $${idx++}`); vals.push(lead_time_days); }
  if (safety_factor  !== undefined) { sets.push(`safety_factor  = $${idx++}`); vals.push(safety_factor); }
  if (stock_max      !== undefined) { sets.push(`stock_max      = $${idx++}`); vals.push(stock_max); }
  if (supplier_id    !== undefined) { sets.push(`supplier_id    = $${idx++}`); vals.push(supplier_id); }

  if (!sets.length) throw Object.assign(new Error('Nada que actualizar'), { code: 'EMPTY_UPDATE' });

  sets.push(`updated_at = NOW()`);
  vals.push(productId);

  const { rows } = await pool.query(
    `UPDATE inventory SET ${sets.join(', ')} WHERE product_id = $${idx} RETURNING *`,
    vals
  );
  if (!rows.length) throw Object.assign(new Error('Producto no encontrado'), { code: 'NOT_FOUND' });
  return rows[0];
}

async function listCategoryProducts() {
  const { rows } = await pool.query(`
    SELECT id, category_descripcion, category_ml
    FROM category_products
    ORDER BY category_descripcion ASC, id ASC
  `);
  return { categories: rows };
}

// ── Proyecciones ─────────────────────────────────────────────────────────────

async function listProjections({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      ip.*,
      p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.lead_time_days, i.stock_alert,
      COUNT(*) OVER() AS total_count
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = ip.product_id
    ORDER BY ip.days_to_stockout ASC NULLS LAST
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    projections: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
    pagination: { total, limit, offset, has_more: offset + rows.length < total },
  };
}

async function getProjectionByProductId(productId) {
  const { rows } = await pool.query(`
    SELECT ip.*, p.sku, p.name, i.stock_qty, i.lead_time_days
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = ip.product_id
    WHERE ip.product_id = $1
  `, [productId]);
  return rows[0] || null;
}

async function getStockouts({ days = 30 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.lead_time_days,
      ip.avg_daily_sales, ip.days_to_stockout,
      ip.suggested_order_qty, ip.velocity_trend,
      (CURRENT_DATE + ip.days_to_stockout)               AS stockout_date,
      (CURRENT_DATE + ip.days_to_stockout - i.lead_time_days) AS must_order_by
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = ip.product_id
    WHERE ip.days_to_stockout IS NOT NULL
      AND ip.days_to_stockout <= $1
    ORDER BY ip.days_to_stockout ASC
  `, [days]);

  const totalInvestment = rows.reduce((sum, r) =>
    sum + Number(r.suggested_order_qty || 0) * Number(r.unit_price_usd || 0), 0
  );

  return {
    days_analyzed:              days,
    stockouts:                  rows,
    total_skus_at_risk:         rows.length,
    total_investment_needed_usd: Number(totalInvestment.toFixed(2)),
  };
}

// ── Órdenes de compra ────────────────────────────────────────────────────────

async function listPurchaseOrders({ limit = 50, offset = 0, status } = {}) {
  const { rows } = await pool.query(`
    SELECT po.*, s.name AS supplier_name, COUNT(*) OVER() AS total_count
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE ($1::text IS NULL OR po.status = $1)
    ORDER BY po.created_at DESC
    LIMIT $2 OFFSET $3
  `, [status || null, limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    orders: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
    pagination: { total, limit, offset, has_more: offset + rows.length < total },
  };
}

async function getPurchaseOrderById(id) {
  const { rows: [order] } = await pool.query(`
    SELECT po.*, s.name AS supplier_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = $1
  `, [id]);
  if (!order) return null;

  const { rows: items } = await pool.query(`
    SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id
  `, [id]);

  return { ...order, items };
}

async function createPurchaseOrder({ supplier_id, notes, items }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const totalUsd = (items || []).reduce((s, i) => s + (Number(i.qty_suggested) * Number(i.unit_price_usd || 0)), 0);
    const { rows: [order] } = await client.query(`
      INSERT INTO purchase_orders (supplier_id, status, total_usd, notes)
      VALUES ($1,'suggested',$2,$3)
      RETURNING *
    `, [supplier_id || null, totalUsd, notes || null]);

    for (const item of (items || [])) {
      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, product_id, sku, name, qty_suggested, unit_price_usd, subtotal_usd, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        order.id, item.product_id, item.sku, item.name,
        item.qty_suggested, item.unit_price_usd,
        Number(item.qty_suggested) * Number(item.unit_price_usd || 0),
        item.reason || null,
      ]);
    }
    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const PO_TRANSITIONS = {
  suggested: ['approved', 'cancelled'],
  approved:  ['ordered', 'cancelled'],
  ordered:   ['received', 'cancelled'],
  received:  [],
  cancelled: [],
};

async function updatePurchaseOrderStatus(id, { status, approved_by, notes }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [po] } = await client.query(
      'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]
    );
    if (!po) throw Object.assign(new Error('Orden no encontrada'), { code: 'NOT_FOUND' });
    if (!PO_TRANSITIONS[po.status]?.includes(status)) {
      throw Object.assign(
        new Error(`Transición inválida: ${po.status} → ${status}`),
        { code: 'INVALID_TRANSITION' }
      );
    }

    const extra = {};
    if (status === 'approved')  { extra.approved_by = approved_by; extra.approved_at = new Date(); }
    if (status === 'ordered')   { extra.ordered_at  = new Date(); }
    if (status === 'received')  { extra.received_at = new Date(); }

    await client.query(`
      UPDATE purchase_orders
      SET status = $1, notes = COALESCE($2, notes),
          approved_by = COALESCE($3, approved_by),
          approved_at = COALESCE($4, approved_at),
          ordered_at  = COALESCE($5, ordered_at),
          received_at = COALESCE($6, received_at)
      WHERE id = $7
    `, [
      status, notes || null,
      extra.approved_by || null, extra.approved_at || null,
      extra.ordered_at  || null, extra.received_at || null,
      id,
    ]);

    // Al recibir: actualizar stock por cada ítem
    if (status === 'received') {
      const mlTransitions = [];
      const { rows: items } = await client.query(
        'SELECT * FROM purchase_order_items WHERE purchase_order_id = $1', [id]
      );
      for (const item of items) {
        const { rows: [inv] } = await client.query(
          'SELECT stock_qty, stock_min FROM inventory WHERE product_id = $1 FOR UPDATE',
          [item.product_id]
        );
        if (!inv) continue;
        const qtyBefore = Number(inv.stock_qty);
        const qtyChange = Number(item.qty_ordered || item.qty_suggested);
        const qtyAfter  = qtyBefore + qtyChange;
        const newAlert  = qtyAfter <= Number(inv.stock_min || 0);

        await client.query(`
          UPDATE inventory
          SET stock_qty = $1, stock_alert = $2, last_purchase_at = NOW(), updated_at = NOW()
          WHERE product_id = $3
        `, [qtyAfter, newAlert, item.product_id]);

        await client.query(`
          INSERT INTO stock_movements
            (product_id, type, qty_before, qty_change, qty_after, reference_id, notes, created_by)
          VALUES ($1,'purchase',$2,$3,$4,$5,'Recepción orden de compra','system')
        `, [item.product_id, qtyBefore, qtyChange, qtyAfter, `PO-${id}`]);

        mlTransitions.push({
          product_id: Number(item.product_id),
          qty_before: qtyBefore,
          qty_after: qtyAfter,
        });
      }
      await client.query('COMMIT');
      for (const t of mlTransitions) {
        maybeSyncMlPublicationState(t.product_id, t.qty_before, t.qty_after);
      }
      return getPurchaseOrderById(id);
    }

    await client.query('COMMIT');
    return getPurchaseOrderById(id);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Proveedores ──────────────────────────────────────────────────────────────

async function listSuppliers() {
  const { rows } = await pool.query(
    'SELECT * FROM suppliers WHERE is_active = TRUE ORDER BY name ASC'
  );
  return rows;
}

async function createSupplier(data) {
  const { rows: [s] } = await pool.query(`
    INSERT INTO suppliers (name, country, lead_time_days, currency, contact_info)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
  `, [data.name, data.country || 'Venezuela', data.lead_time_days || 7, data.currency || 'USD', JSON.stringify(data.contact_info || {})]);
  return s;
}

async function updateSupplier(id, data) {
  const sets = [];
  const vals = [];
  let idx = 1;
  ['name','country','lead_time_days','currency','is_active'].forEach(k => {
    if (data[k] !== undefined) { sets.push(`${k} = $${idx++}`); vals.push(data[k]); }
  });
  if (!sets.length) throw Object.assign(new Error('Nada que actualizar'), { code: 'EMPTY_UPDATE' });
  vals.push(id);
  const { rows: [s] } = await pool.query(
    `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals
  );
  return s;
}

// ── Stats del módulo ─────────────────────────────────────────────────────────

async function getInventoryStats() {
  const [catalog, alerts, proj, pos, value, lastCalc] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)                              AS total_skus,
        COUNT(*) FILTER (WHERE is_active)     AS active_skus
      FROM products
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE i.stock_alert)                               AS critical,
        COUNT(*) FILTER (WHERE NOT i.stock_alert AND i.stock_qty <= 0)      AS zero_stock,
        COUNT(*) FILTER (WHERE i.stock_qty > 0 AND NOT i.stock_alert)       AS ok
      FROM products p JOIN inventory i ON i.product_id = p.id
      WHERE p.is_active = TRUE
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE days_to_stockout <= 7)  AS stockouts_7d,
        COUNT(*) FILTER (WHERE days_to_stockout <= 15) AS stockouts_15d,
        COUNT(*) FILTER (WHERE days_to_stockout <= 30) AS stockouts_30d
      FROM inventory_projections
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'suggested')                                AS suggested,
        COUNT(*) FILTER (WHERE status = 'approved')                                 AS approved,
        COUNT(*) FILTER (WHERE status = 'ordered')                                  AS ordered,
        COUNT(*) FILTER (WHERE status = 'received'
          AND received_at >= DATE_TRUNC('month', NOW()))                            AS received_this_month
      FROM purchase_orders
    `),
    pool.query(`
      SELECT COALESCE(SUM(i.stock_qty * COALESCE(p.unit_price_usd, 0)), 0) AS inventory_value_usd
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE p.is_active = TRUE
    `),
    pool.query(`
      SELECT MAX(last_calculated_at) AS last_worker_run FROM inventory_projections
    `),
  ]);

  const c = catalog.rows[0];
  const a = alerts.rows[0];

  return {
    catalog: {
      total_skus:       Number(c.total_skus),
      active_skus:      Number(c.active_skus),
      skus_with_stock:  Number(c.active_skus) - Number(a.zero_stock || 0),
      skus_zero_stock:  Number(a.zero_stock || 0),
    },
    alerts: {
      critical: Number(a.critical),
      warning:  0,
      ok:       Number(a.ok),
    },
    projections: {
      stockouts_7d:  Number(proj.rows[0].stockouts_7d),
      stockouts_15d: Number(proj.rows[0].stockouts_15d),
      stockouts_30d: Number(proj.rows[0].stockouts_30d),
    },
    purchase_orders: {
      suggested:           Number(pos.rows[0].suggested),
      approved:            Number(pos.rows[0].approved),
      ordered:             Number(pos.rows[0].ordered),
      received_this_month: Number(pos.rows[0].received_this_month),
    },
    inventory_value_usd: Number(Number(value.rows[0].inventory_value_usd).toFixed(2)),
    last_worker_run:     lastCalc.rows[0].last_worker_run || null,
  };
}

module.exports = {
  listProducts,
  deactivateProduct,
  getProductById,
  searchProducts,
  getAlerts,
  getImmStockouts,
  adjustStock,
  updateProductConfig,
  listProjections,
  getProjectionByProductId,
  getStockouts,
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  listSuppliers,
  createSupplier,
  updateSupplier,
  getInventoryStats,
  listCategoryProducts,
};
