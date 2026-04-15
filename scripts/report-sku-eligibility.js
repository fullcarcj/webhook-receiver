#!/usr/bin/env node
/**
 * Informe: por cada producto, si puede recibir SKU canónico vía bulk-assign y por qué no (si aplica).
 *
 * Motivos:
 *   missing_identity     — falta brand_id / subcategory_id / category_id
 *   prefix_error         — catálogo de prefijos (subcategoría+marca) inválido o incompleto
 *   already_canonical    — el sku actual ya coincide con SS-SSS-MMM-NNNN del prefijo
 *   blocked_movements    — hay stock_movements, líneas de venta, reservas, etc. (misma regla que el bulk)
 *   eligible             — el bulk podría asignar (salvo error raro al allocate)
 *
 * Opciones:
 *   --only-pending       — solo filas con sku_old no vacío y (sku vacío o NULL) si existe columna sku_old; si no, sku IS NULL
 *   --csv=ruta.csv
 *
 * Uso:
 *   node scripts/report-sku-eligibility.js
 *   node scripts/report-sku-eligibility.js --only-pending --csv=./data/pendientes-sku.csv
 */
"use strict";

const fs = require("fs");
const path = require("path");

require("../load-env-local");
const { pool } = require("../db");
const { getSkuPrefixParts } = require("../src/services/skuGeneratorService");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);
const ONLY_PENDING = Boolean(args["only-pending"]);
const CSV_PATH =
  args.csv != null && String(args.csv).trim() !== "" && args.csv !== true
    ? path.resolve(String(args.csv).trim())
    : null;

const _prefixCache = new Map();
async function getCachedPrefixParts(sid, bid) {
  const key = `${sid}:${bid}`;
  if (_prefixCache.has(key)) return _prefixCache.get(key);
  const parts = await getSkuPrefixParts(sid, bid);
  _prefixCache.set(key, parts);
  return parts;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildMovementCache() {
  const [sm, sl, pl, mlr, mli, bs, pls] = await Promise.all([
    pool.query(`SELECT DISTINCT product_id AS pid FROM stock_movements`),
    pool.query(
      `SELECT DISTINCT product_sku AS sku FROM sale_lines WHERE product_sku IS NOT NULL AND btrim(product_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT product_sku AS sku FROM purchase_lines WHERE product_sku IS NOT NULL AND btrim(product_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT producto_sku AS sku FROM ml_order_reservations WHERE status != 'RELEASED' AND producto_sku IS NOT NULL AND btrim(producto_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT product_sku AS sku FROM ml_order_items WHERE reservation_status != 'NO_SKU_MAP' AND product_sku IS NOT NULL AND btrim(product_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT product_sku AS sku FROM bin_stock WHERE qty_available > 0 AND product_sku IS NOT NULL AND btrim(product_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT producto_sku AS sku FROM product_lots WHERE status != 'EXHAUSTED' AND producto_sku IS NOT NULL AND btrim(producto_sku) <> ''`
    ),
  ]);
  const productIdsWithStock = new Set();
  for (const r of sm.rows) {
    if (r.pid != null) productIdsWithStock.add(Number(r.pid));
  }
  const skusTouched = new Set();
  for (const r of [...sl.rows, ...pl.rows, ...mlr.rows, ...mli.rows, ...bs.rows, ...pls.rows]) {
    if (r.sku != null && String(r.sku).trim() !== "") skusTouched.add(String(r.sku).trim());
  }
  return { productIdsWithStock, skusTouched };
}

function hasMovementFromCache(productId, sku, cache) {
  if (cache.productIdsWithStock.has(Number(productId))) return true;
  const s = sku != null ? String(sku).trim() : "";
  if (s && cache.skusTouched.has(s)) return true;
  return false;
}

async function classify(row, cache) {
  const { id, sku: oldSku, brand_id: bid, subcategory_id: sid, category_id: cid } = row;
  if (bid == null || sid == null || cid == null) {
    return { reason: "missing_identity", detail: "" };
  }
  let expectedPrefix;
  try {
    const parts = await getCachedPrefixParts(sid, bid);
    expectedPrefix = parts.prefix;
  } catch (e) {
    return { reason: "prefix_error", detail: e.message || String(e) };
  }
  const canonicalRe = new RegExp(`^${escapeRe(expectedPrefix)}-[0-9]{4}$`);
  if (canonicalRe.test(String(oldSku || "").trim())) {
    return { reason: "already_canonical", detail: expectedPrefix };
  }
  if (hasMovementFromCache(id, oldSku, cache)) {
    return { reason: "blocked_movements", detail: "" };
  }
  return { reason: "eligible", detail: expectedPrefix };
}

async function main() {
  const { rows: colSkuOld } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'sku_old'
    ) AS x
  `);
  const hasSkuOld = Boolean(colSkuOld[0] && colSkuOld[0].x);

  let sql = `
    SELECT id, sku, brand_id, subcategory_id, category_id
    ${hasSkuOld ? ", sku_old" : ""}
    FROM products
    WHERE 1=1
  `;
  if (ONLY_PENDING) {
    if (hasSkuOld) {
      sql += ` AND sku_old IS NOT NULL AND btrim(sku_old::text) <> ''
               AND (sku IS NULL OR btrim(sku::text) = '')`;
    } else {
      sql += ` AND (sku IS NULL OR btrim(sku::text) = '')`;
    }
  }

  sql += ` ORDER BY id`;

  console.log("report-sku-eligibility");
  console.log(`  only-pending: ${ONLY_PENDING}${hasSkuOld ? " (columna sku_old: sí)" : " (sin sku_old: filtro solo sku vacío)"}\n`);

  const t0 = Date.now();
  const { rows } = await pool.query(sql);
  console.log(`  Filas a clasificar: ${rows.length}`);
  console.log("  Cargando caché de movimientos…");
  const cache = await buildMovementCache();
  console.log(
    `  → ${cache.productIdsWithStock.size} product_id en stock_movements, ${cache.skusTouched.size} SKU en tablas de movimiento (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`
  );

  const counts = {
    missing_identity: 0,
    prefix_error: 0,
    already_canonical: 0,
    blocked_movements: 0,
    eligible: 0,
  };

  const lines = [["id", "reason", "detail", "sku", "sku_old"].join(",")];
  for (const row of rows) {
    const { reason, detail } = await classify(row, cache);
    counts[reason] = (counts[reason] || 0) + 1;
    const skuEsc = row.sku != null ? `"${String(row.sku).replace(/"/g, '""')}"` : "";
    const oldEsc =
      hasSkuOld && row.sku_old != null ? `"${String(row.sku_old).replace(/"/g, '""')}"` : "";
    if (CSV_PATH) {
      lines.push([row.id, reason, `"${String(detail).replace(/"/g, '""')}"`, skuEsc, oldEsc].join(","));
    }
  }

  console.log("  RESUMEN");
  console.log(`    missing_identity     : ${counts.missing_identity}`);
  console.log(`    prefix_error         : ${counts.prefix_error}`);
  console.log(`    already_canonical    : ${counts.already_canonical}`);
  console.log(`    blocked_movements    : ${counts.blocked_movements}`);
  console.log(`    eligible (asignable) : ${counts.eligible}`);
  console.log("");
  console.log(
    "  Cierre de backlog: corregir identidad/prefijos; para blocked_movements vaciar o ajustar tablas hijas, o usar bulk con --ignore-movements --confirm=RIESGO (riesgo de integridad)."
  );

  if (CSV_PATH) {
    fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
    fs.writeFileSync(CSV_PATH, lines.join("\n") + "\n", "utf8");
    console.log(`\n  CSV: ${CSV_PATH}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
