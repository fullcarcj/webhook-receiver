"use strict";

/**
 * Kits definidos en `product_bundles` (padre = kit en productos).
 * Alternativas en `bundle_component_alternatives`. Stock siempre en `productos.stock`.
 * Compatibilidad: si no hay filas en product_bundles, salesService usa atributos.kit_components (JSON).
 */

const { pool } = require("../../db");
const pino = require("pino");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "bundle_service" });

function productName(row) {
  return String(row.descripcion || row.sku || "").trim() || row.sku;
}

async function tableExists(q) {
  try {
    const { rows } = await q.query(
      `SELECT to_regclass('public.product_bundles') AS t`
    );
    return rows[0] && rows[0].t != null;
  } catch (_) {
    return false;
  }
}

async function hasDbBundlesForParent(parentProductId, q = pool) {
  if (!(await tableExists(q))) return false;
  try {
    const { rows } = await q.query(
      `SELECT 1 FROM product_bundles WHERE parent_product_id = $1 AND is_active = TRUE LIMIT 1`,
      [parentProductId]
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Kit = filas en product_bundles (activas) o legado JSON kit_components.
 */
async function isKitProduct(productId, atributos) {
  if (await hasDbBundlesForParent(productId)) return true;
  if (!atributos || typeof atributos !== "object") return false;
  const raw = atributos.kit_components;
  return Array.isArray(raw) && raw.length > 0;
}

async function loadAlternativesForBundle(bundleId, q = pool) {
  const { rows } = await q.query(
    `SELECT bca.id, bca.brand_name, bca.is_preferred, bca.alternative_product_id AS product_id,
            p.sku, p.descripcion, p.precio_usd, p.stock AS stock_qty
     FROM bundle_component_alternatives bca
     JOIN productos p ON p.id = bca.alternative_product_id
     WHERE bca.bundle_id = $1
     ORDER BY bca.is_preferred DESC, p.stock DESC`,
    [bundleId]
  );
  return rows.map((r) => ({
    id: r.id,
    brand_name: r.brand_name,
    is_preferred: r.is_preferred,
    product_id: Number(r.product_id),
    sku: r.sku,
    name: productName(r),
    unit_price_usd: r.precio_usd != null ? Number(r.precio_usd) : null,
    stock_qty: Number(r.stock_qty ?? 0),
    has_stock: Number(r.stock_qty ?? 0) > 0,
  }));
}

/**
 * Detalle de kit para UI / availability.
 * @param {import('pg').Pool|import('pg').PoolClient} [q]
 */
async function getKitComponents(kitProductId, q = pool) {
  if (!(await tableExists(q))) return [];
  const { rows: components } = await q.query(
    `SELECT
       pb.id AS bundle_id,
       pb.quantity,
       pb.notes AS component_notes,
       p.id AS product_id,
       p.sku,
       p.descripcion,
       p.precio_usd AS unit_price_usd,
       p.stock AS stock_qty,
       (p.stock > 0) AS has_stock,
       EXISTS (SELECT 1 FROM bundle_component_alternatives bca WHERE bca.bundle_id = pb.id) AS has_alternatives
     FROM product_bundles pb
     JOIN productos p ON p.id = pb.component_product_id
     WHERE pb.parent_product_id = $1 AND pb.is_active = TRUE
     ORDER BY pb.id ASC`,
    [kitProductId]
  );

  const out = [];
  for (const comp of components) {
    const base = {
      bundle_id: Number(comp.bundle_id),
      quantity: Number(comp.quantity),
      component_notes: comp.component_notes,
      product_id: Number(comp.product_id),
      sku: comp.sku,
      name: productName(comp),
      unit_price_usd: comp.unit_price_usd != null ? Number(comp.unit_price_usd) : null,
      stock_qty: Number(comp.stock_qty ?? 0),
      has_stock: comp.has_stock,
      has_alternatives: comp.has_alternatives,
    };
    if (comp.has_alternatives) {
      base.alternatives = await loadAlternativesForBundle(comp.bundle_id, q);
    } else {
      base.alternatives = [];
    }
    out.push(base);
  }
  return out;
}

/**
 * Resuelve qué product_id descontar por cada línea de bundle.
 * selectedComponents: [{ bundle_id, selected_product_id? }] — si omitido, componente principal.
 */
async function validateKitStock(kitProductId, lineQty, selectedComponents = [], q = pool) {
  const components = await getKitComponents(kitProductId, q);
  if (!components.length) {
    return { valid: false, errors: [{ error: "NO_BUNDLE_ROWS", message: "Kit sin componentes en product_bundles" }], components: [] };
  }

  const sel = Array.isArray(selectedComponents) ? selectedComponents : [];
  const errors = [];
  const resolved = [];

  for (const comp of components) {
    const pick = sel.find((s) => Number(s.bundle_id) === comp.bundle_id);
    let chosenId = comp.product_id;
    let chosenSku = comp.sku;
    let chosenName = comp.name;
    let chosenStock = comp.stock_qty;
    const perKitQty = Number(comp.quantity);

    if (pick && pick.selected_product_id != null) {
      const sid = Number(pick.selected_product_id);
      if (sid !== comp.product_id) {
        const alt = (comp.alternatives || []).find((a) => a.product_id === sid);
        if (!alt) {
          errors.push({
            bundle_id: comp.bundle_id,
            error: "INVALID_ALTERNATIVE",
            message: `SKU alternativo no válido para bundle_id ${comp.bundle_id}`,
          });
          continue;
        }
        chosenId = alt.product_id;
        chosenSku = alt.sku;
        chosenName = alt.name;
        chosenStock = alt.stock_qty;
      }
    }

    const need = perKitQty * lineQty;
    if (chosenStock < need) {
      errors.push({
        bundle_id: comp.bundle_id,
        sku: chosenSku,
        name: chosenName,
        required: need,
        available: chosenStock,
        error: "INSUFFICIENT_STOCK",
      });
      continue;
    }

    resolved.push({
      bundle_id: comp.bundle_id,
      product_id: chosenId,
      sku: chosenSku,
      name: chosenName,
      quantity: need,
      stock_qty: chosenStock,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    components: resolved,
  };
}

/**
 * Stock decrements para salesService (mismo shape que resolveSaleLinesAndStock).
 */
async function buildStockDecrementsForDbKit(client, kitProductId, lineQty, selectedComponents) {
  const v = await validateKitStock(kitProductId, lineQty, selectedComponents, client);
  if (!v.valid) {
    const err = new Error(v.errors[0]?.message || "Stock insuficiente en kit");
    err.code = "INSUFFICIENT_STOCK";
    err.kit_errors = v.errors;
    throw err;
  }
  return v.components.map((c) => ({
    product_id: c.product_id,
    sku: c.sku,
    quantity: c.quantity,
  }));
}

async function getAvailabilityPayload(kitProductId) {
  const kit = await pool.query(
    `SELECT id, sku, descripcion FROM productos WHERE id = $1`,
    [kitProductId]
  );
  if (!kit.rows.length) return null;
  const k = kit.rows[0];
  const components = await getKitComponents(kitProductId);
  const blocking = [];
  for (const c of components) {
    const need = Number(c.quantity);
    let ok = false;
    if (!c.has_alternatives) {
      ok = c.stock_qty >= need;
    } else {
      const opts = [
        { stock: c.stock_qty, qty: need },
        ...(c.alternatives || []).map((a) => ({ stock: a.stock_qty, qty: need })),
      ];
      ok = opts.some((o) => o.stock >= o.qty);
    }
    if (!ok) {
      blocking.push({
        sku: c.sku,
        name: c.name,
        required: need,
        available: c.stock_qty,
      });
    }
  }
  const canSell = blocking.length === 0;
  return {
    kit_id: Number(kitProductId),
    kit_sku: k.sku,
    kit_name: productName(k),
    all_available: canSell,
    can_sell: canSell,
    components,
    blocking_components: blocking,
  };
}

/**
 * Precio sugerido componente = precio kit / nº componentes (regla negocio prompt; simplificación).
 */
async function suggestComponentPrice(componentProductId) {
  const { rows: kits } = await pool.query(
    `SELECT
       pb.parent_product_id AS kit_id,
       pb.quantity AS qty_in_kit,
       k.sku AS kit_sku,
       k.descripcion AS kit_desc,
       k.precio_usd AS kit_price_usd,
       (SELECT COUNT(*)::INT FROM product_bundles pb2
        WHERE pb2.parent_product_id = pb.parent_product_id AND pb2.is_active = TRUE) AS total_components
     FROM product_bundles pb
     JOIN productos k ON k.id = pb.parent_product_id
     WHERE pb.component_product_id = $1
       AND pb.is_active = TRUE
       AND k.precio_usd IS NOT NULL
     ORDER BY k.precio_usd DESC
     LIMIT 1`,
    [componentProductId]
  );
  if (!kits.length) return null;
  const kit = kits[0];
  const tc = Math.max(1, Number(kit.total_components || 1));
  const kp = Number(kit.kit_price_usd);
  const suggested = kp / tc;
  return {
    kit_sku: kit.kit_sku,
    kit_name: productName({ descripcion: kit.kit_desc, sku: kit.kit_sku }),
    kit_price_usd: kp,
    total_components: tc,
    suggested_price_usd: Math.round(suggested * 10000) / 10000,
    basis: `Kit ${kit.kit_sku} ($${kp}) / ${tc} componentes`,
  };
}

module.exports = {
  hasDbBundlesForParent,
  isKitProduct,
  getKitComponents,
  validateKitStock,
  buildStockDecrementsForDbKit,
  getAvailabilityPayload,
  suggestComponentPrice,
  productName,
  tableExists,
};
