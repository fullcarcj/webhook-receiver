"use strict";

/**
 * Agregador "La Lupita" (Bloque 3 · Fase 0): catálogo + WMS + compatibilidad motor.
 * No modifica AI Responder.
 */

const { pool } = require("../../db");
const { getPickingListBySkus } = require("./wmsService");
const { listCompatibilitiesByProduct } = require("./compatibilityService");

/**
 * @param {string} rawSku
 * @returns {Promise<object|null>} null si el SKU no existe en products
 */
async function getProductDetailBySku(rawSku) {
  const sku = String(rawSku || "").trim();
  if (!sku) {
    const err = new Error("SKU requerido");
    err.code = "SKU_REQUIRED";
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT
       p.id,
       p.sku,
       p.name,
       p.description,
       p.category,
       p.brand,
       p.unit_price_usd,
       p.is_active,
       i.stock_qty,
       i.stock_min,
       i.stock_max
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.sku = $1
     LIMIT 1`,
    [sku]
  );

  if (!rows.length) return null;

  const row = rows[0];
  const priceUsd = row.unit_price_usd != null ? Number(row.unit_price_usd) : null;

  let picking;
  try {
    picking = await getPickingListBySkus([sku]);
  } catch (_e) {
    picking = { warehouses: {}, total_locations: 0, missing_stock: [sku] };
  }

  let compatibilities = [];
  try {
    compatibilities = await listCompatibilitiesByProduct(sku);
  } catch (_e) {
    compatibilities = [];
  }

  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    brand: row.brand,
    is_active: row.is_active === true,
    price_usd: Number.isFinite(priceUsd) ? priceUsd : null,
    inventory: {
      stock_qty: row.stock_qty != null ? Number(row.stock_qty) : null,
      stock_min: row.stock_min != null ? Number(row.stock_min) : null,
      stock_max: row.stock_max != null ? Number(row.stock_max) : null,
    },
    /** Foto: sin columna canónica en products; el front puede enriquecer con listing ML por item_id. */
    photo_url: null,
    wms: picking,
    compatibilities,
  };
}

/**
 * Escribe respuesta HTTP JSON para La Lupita (uso desde server.js).
 * @returns {Promise<boolean>} true si manejó la respuesta
 */
async function writeProductDetailHttp(res, rawSku) {
  try {
    const data = await getProductDetailBySku(rawSku);
    if (!data) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "SKU no encontrado" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, data }));
    return true;
  } catch (e) {
    const st = e && e.status ? Number(e.status) : 500;
    res.writeHead(Number.isFinite(st) && st >= 400 && st < 600 ? st : 500, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ ok: false, error: e && e.message ? String(e.message) : "error" }));
    return true;
  }
}

module.exports = { getProductDetailBySku, writeProductDetailHttp };
