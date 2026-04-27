"use strict";

/**
 * GET /api/inbox/:chatId/ml-order
 * Devuelve los ítems de la orden ML vinculada al chat con:
 *  - datos del ítem (título, cantidad, precio, variación)
 *  - thumbnail (desde ml_listings)
 *  - datos del producto interno (sku, nombre, categoría)
 *  - ubicaciones WMS (bins con stock disponible)
 */

const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { resolveMercadoLibreListingUrl } = require("../utils/mlItemPublicUrl");
const {
  resolveLinkedMlOrderId,
  resolveExternalMlOrderIdFromSalesLink,
  resolveMlOrderReferenceBs,
  mlOrdersOrderIdFromLinkedValue,
} = require("../utils/chatMlOrderReference");
const { getTodayRate } = require("../services/currencyService");
const { pool } = require("../../db");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "inbox_ml_order_api" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function normalizePath(p) {
  return String(p || "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

function extractListingPicturesFromOrderLine(it) {
  const pics = it?.item?.pictures;
  if (!Array.isArray(pics)) return [];
  const out = [];
  for (const p of pics) {
    const u = p && (p.secure_url || p.url);
    if (u) out.push(String(u).trim());
  }
  return out;
}

/** Parsea los order_items del raw_json de la orden ML */
function parseOrderItems(rawJson) {
  try {
    const obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    const items = obj?.order_items;
    if (!Array.isArray(items)) return [];
    return items.map((it) => ({
      ml_item_id:   it?.item?.id   != null ? String(it.item.id)   : null,
      variation_id: it?.item?.variation_id != null ? String(it.item.variation_id) : null,
      title:        it?.item?.title != null ? String(it.item.title) : null,
      quantity:     it?.quantity    != null ? Number(it.quantity)   : null,
      unit_price:   it?.unit_price  != null ? Number(it.unit_price) : null,
      currency_id:  it?.currency_id != null ? String(it.currency_id) : null,
      seller_sku:   it?.item?.seller_sku != null ? String(it.item.seller_sku).trim() : null,
      listing_pictures: extractListingPicturesFromOrderLine(it),
    }));
  } catch {
    return [];
  }
}

/**
 * Resuelve el SKU canónico de productos internos para un ítem ML.
 * Prioridad:
 *  1. ml_item_sku_map (mapeo explícito item+variación → sku)
 *  2. products.sku_old = seller_sku  (convención de negocio)
 *  3. products.sku = seller_sku      (fallback directo)
 */
async function resolveProductSku(mlItemId, variationId, sellerSku) {
  // 1. Tabla ml_item_sku_map
  if (mlItemId) {
    try {
      const { rows } = await pool.query(
        `SELECT m.product_sku, p.id AS product_id, p.name, p.description, p.category,
                COALESCE(p.precio_usd, p.unit_price_usd) AS price_usd
         FROM ml_item_sku_map m
         JOIN products p ON p.sku = m.product_sku
         WHERE m.ml_item_id = $1
           AND m.is_active = TRUE
           AND (m.ml_variation_id = $2 OR m.ml_variation_id IS NULL)
         ORDER BY m.ml_variation_id NULLS LAST
         LIMIT 1`,
        [mlItemId, variationId || null]
      );
      if (rows.length) return rows[0];
    } catch (e) {
      logger.debug({ err: e.message }, "ml_item_sku_map lookup failed");
    }
  }

  // 2. products.sku_old = seller_sku
  if (sellerSku) {
    try {
      const { rows } = await pool.query(
        `SELECT id AS product_id, sku AS product_sku, name, description, category,
                COALESCE(precio_usd, unit_price_usd) AS price_usd
         FROM products
         WHERE sku_old = $1
         LIMIT 1`,
        [sellerSku]
      );
      if (rows.length) return rows[0];
    } catch (e) {
      logger.debug({ err: e.message }, "products.sku_old lookup failed");
    }

    // 3. products.sku = seller_sku (fallback directo)
    try {
      const { rows } = await pool.query(
        `SELECT id AS product_id, sku AS product_sku, name, description, category,
                COALESCE(precio_usd, unit_price_usd) AS price_usd
         FROM products
         WHERE sku = $1
         LIMIT 1`,
        [sellerSku]
      );
      if (rows.length) return rows[0];
    } catch (e) {
      logger.debug({ err: e.message }, "products.sku direct lookup failed");
    }
  }

  return null;
}

/** Trae las ubicaciones WMS con stock > 0 para un SKU canónico */
async function getWmsLocations(productSku) {
  if (!productSku) return [];
  try {
    const { rows } = await pool.query(
      `SELECT bin_code, aisle_code, shelf_code, qty_available, qty_reserved, warehouse_code
       FROM v_picking_route
       WHERE product_sku = $1
         AND qty_available > 0
       ORDER BY picking_order ASC
       LIMIT 10`,
      [productSku]
    );
    return rows.map((r) => ({
      bin_code:       r.bin_code,
      aisle_code:     r.aisle_code,
      shelf_code:     r.shelf_code,
      warehouse_code: r.warehouse_code,
      qty_available:  Number(r.qty_available),
      qty_reserved:   Number(r.qty_reserved),
    }));
  } catch (e) {
    logger.debug({ err: e.message, productSku }, "wms v_picking_route lookup failed");
    return [];
  }
}

/** Trae thumbnail, permalink y site desde ml_listings por item_id */
async function getMlListingRow(mlItemId) {
  if (!mlItemId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT thumbnail, title, status, permalink, site_id
       FROM ml_listings WHERE item_id = $1 LIMIT 1`,
      [mlItemId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e && e.code === "42703") {
      try {
        const { rows } = await pool.query(
          `SELECT thumbnail, title, status FROM ml_listings WHERE item_id = $1 LIMIT 1`,
          [mlItemId]
        );
        return rows[0] || null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function handleInboxMlOrderRequest(req, res, url) {
  const pathname = normalizePath(url.pathname || "");
  const mGet = pathname.match(/^\/api\/inbox\/(\d+)\/ml-order$/);
  if (!mGet) return false;

  applyCrmApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const user = await requireAdminOrPermission(req, res, "crm");
  if (!user) return true;

  const chatId = Number(mGet[1]);

  try {
    const mlOrderId = await resolveLinkedMlOrderId(pool, chatId);
    if (mlOrderId == null) {
      writeJson(res, 200, null);
      return true;
    }

    // external_order_id puede ser "ml_user_id-order_id"; ml_orders.order_id es solo el id ML (bigint).
    let lookupKey = mlOrdersOrderIdFromLinkedValue(mlOrderId);
    // 2. Obtener raw_json de la orden (ml_orders.order_id = id ML; el chat puede guardar sales_orders.id)
    let { rows: orderRows } = await pool.query(
      `SELECT order_id, status, total_amount, currency_id, date_created, raw_json
       FROM ml_orders
       WHERE order_id = $1
       LIMIT 1`,
      [lookupKey]
    );
    if (!orderRows.length) {
      const altKey = await resolveExternalMlOrderIdFromSalesLink(pool, mlOrderId);
      const lookup2 = mlOrdersOrderIdFromLinkedValue(String(altKey).trim());
      if (lookup2 !== lookupKey) {
        lookupKey = lookup2;
        const again = await pool.query(
          `SELECT order_id, status, total_amount, currency_id, date_created, raw_json
           FROM ml_orders
           WHERE order_id = $1
           LIMIT 1`,
          [lookupKey]
        );
        orderRows = again.rows;
      }
    }
    if (!orderRows.length) {
      const rateRow = await getTodayRate(1).catch(() => null);
      const activeRate =
        rateRow && rateRow.active_rate != null ? Number(rateRow.active_rate) : NaN;
      const ref = await resolveMlOrderReferenceBs(pool, chatId, activeRate);
      const payload = {
        ml_order_id: mlOrderId,
        items: [],
        not_synced: true,
      };
      if (Number.isFinite(ref.referenceBs)) {
        payload.reference_fallback_bs = ref.referenceBs;
        payload.reference_fallback_source =
          ref.meta && ref.meta.source ? String(ref.meta.source) : null;
      }
      writeJson(res, 200, payload);
      return true;
    }
    const mlOrder = orderRows[0];

    // 3. Parsear ítems del raw_json
    const rawItems = parseOrderItems(mlOrder.raw_json);

    // 4. Enriquecer cada ítem con producto + WMS + thumbnail
    const items = await Promise.all(
      rawItems.map(async (it) => {
        const [product, listing] = await Promise.all([
          resolveProductSku(it.ml_item_id, it.variation_id, it.seller_sku),
          getMlListingRow(it.ml_item_id),
        ]);
        const wms_locations = product?.product_sku
          ? await getWmsLocations(product.product_sku)
          : [];
        const picsRaw = Array.isArray(it.listing_pictures) ? it.listing_pictures : [];
        const thumb = listing?.thumbnail ?? null;
        const gallery = [...picsRaw];
        if (thumb && !gallery.includes(thumb)) gallery.unshift(thumb);
        const listingPermalink = resolveMercadoLibreListingUrl(
          listing?.permalink,
          it.ml_item_id,
          listing?.site_id
        );
        return {
          ml_item_id:   it.ml_item_id,
          variation_id: it.variation_id,
          title:        listing?.title ?? it.title,
          quantity:     it.quantity,
          unit_price:   it.unit_price,
          currency_id:  it.currency_id,
          seller_sku:   it.seller_sku,
          thumbnail:    thumb,
          listing_pictures: picsRaw,
          listing_gallery: gallery,
          listing_permalink: listingPermalink,
          listing_status: listing?.status ?? null,
          product: product
            ? {
                sku:         product.product_sku,
                name:        product.name,
                description: product.description,
                category:    product.category,
                price_usd:   product.price_usd != null ? Number(product.price_usd) : null,
              }
            : null,
          wms_locations,
        };
      })
    );

    writeJson(res, 200, {
      ml_order_id:  mlOrder.order_id,
      order_status: mlOrder.status,
      total_amount: mlOrder.total_amount != null ? Number(mlOrder.total_amount) : null,
      currency_id:  mlOrder.currency_id,
      date_created: mlOrder.date_created,
      items,
    });
    return true;
  } catch (err) {
    logger.error({ err: err.message, chatId }, "inbox_ml_order: error");
    writeJson(res, 500, { error: "server_error" });
    return true;
  }
}

module.exports = {
  handleInboxMlOrderRequest,
  parseOrderItems,
  resolveProductSku,
};
