"use strict";

const { pool } = require("../../db");
const pino = require("pino");
const { emit } = require("./sseService");
const bundleService = require("./bundleService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "price_review" });

async function enqueueComponentPricing(productId) {
  if (!(await bundleService.tableExists(pool))) return;
  const { rows: product } = await pool.query(
    `SELECT id, sku, descripcion, precio_usd FROM productos WHERE id = $1`,
    [productId]
  );
  if (!product.length) return;

  const suggestion = await bundleService.suggestComponentPrice(productId);
  if (!suggestion) return;

  const { rows: existing } = await pool.query(
    `SELECT id FROM price_review_queue
     WHERE product_id = $1 AND review_type = 'component_pricing' AND status = 'pending'
     LIMIT 1`,
    [productId]
  );
  if (existing.length) return;

  const name = bundleService.productName(product[0]);
  await pool.query(
    `INSERT INTO price_review_queue
       (product_id, sku, product_name, review_type,
        current_price_usd, suggested_price_usd, suggestion_basis)
     VALUES ($1,$2,$3,'component_pricing',$4,$5,$6)`,
    [
      productId,
      product[0].sku,
      name,
      product[0].precio_usd != null ? Number(product[0].precio_usd) : null,
      suggestion.suggested_price_usd,
      suggestion.basis,
    ]
  );

  emit("price_review_added", {
    sku: product[0].sku,
    review_type: "component_pricing",
    current_price: product[0].precio_usd,
    suggested_price: suggestion.suggested_price_usd,
    basis: suggestion.basis,
    message: `${product[0].sku} — revisar precio de componente individual`,
  });

  log.info({ productId, sku: product[0].sku }, "price_review: component_pricing encolado");
}

async function checkHighRotation(productId) {
  if (!(await bundleService.tableExists(pool))) return;
  const { rows: settings } = await pool.query(
    `SELECT setting_value FROM dynamic_prices_settings WHERE setting_key = 'ROTATION_ALERT_THRESHOLD'`
  );
  const threshold = Number(settings[0]?.setting_value ?? 5);

  const { rows: sales } = await pool.query(
    `SELECT COUNT(*)::INT AS c
     FROM sales_order_items soi
     JOIN sales_orders so ON so.id = soi.sales_order_id
     WHERE soi.product_id = $1
       AND so.status IN ('paid','shipped','completed')
       AND so.created_at >= NOW() - INTERVAL '30 days'`,
    [productId]
  );
  const rotationCount = Number(sales[0]?.c ?? 0);
  if (rotationCount < threshold) return;

  const { rows: existing } = await pool.query(
    `SELECT id FROM price_review_queue
     WHERE product_id = $1 AND review_type = 'high_rotation' AND status = 'pending'
     LIMIT 1`,
    [productId]
  );
  if (existing.length) return;

  const { rows: product } = await pool.query(
    `SELECT sku, descripcion, precio_usd FROM productos WHERE id = $1`,
    [productId]
  );
  if (!product.length) return;

  const name = bundleService.productName(product[0]);
  await pool.query(
    `INSERT INTO price_review_queue
       (product_id, sku, product_name, review_type,
        current_price_usd, rotation_count, rotation_threshold, suggestion_basis)
     VALUES ($1,$2,$3,'high_rotation',$4,$5,$6,$7)`,
    [
      productId,
      product[0].sku,
      name,
      product[0].precio_usd != null ? Number(product[0].precio_usd) : null,
      rotationCount,
      threshold,
      `Alta rotación: ${rotationCount} ventas en 30 días (umbral: ${threshold})`,
    ]
  );

  emit("price_review_added", {
    sku: product[0].sku,
    review_type: "high_rotation",
    rotation_count: rotationCount,
    threshold,
    message: `Alta rotación: ${product[0].sku} — ${rotationCount} ventas/30 días`,
  });

  log.warn({ productId, sku: product[0].sku, rotationCount, threshold }, "price_review: high_rotation");
}

async function getPendingReviews(type = null) {
  const params = [];
  let filter = "";
  if (type) {
    params.push(type);
    filter = "AND prq.review_type = $1";
  }
  const { rows } = await pool.query(
    `SELECT prq.* FROM price_review_queue prq
     WHERE prq.status = 'pending' ${filter}
     ORDER BY prq.created_at DESC`,
    params
  );
  return rows;
}

async function resolveReview({ reviewId, status, reviewedBy, notes }) {
  const { rows } = await pool.query(
    `UPDATE price_review_queue
     SET status = $1, reviewed_by = $2, review_notes = $3, reviewed_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [status, reviewedBy, notes ?? null, reviewId]
  );
  if (!rows.length) {
    const e = new Error("NOT_FOUND");
    e.code = "NOT_FOUND";
    throw e;
  }
  log.info({ reviewId, status }, "price_review: resuelto");
  return rows[0];
}

module.exports = {
  enqueueComponentPricing,
  checkHighRotation,
  getPendingReviews,
  resolveReview,
};
