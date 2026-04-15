#!/usr/bin/env node
/**
 * Importa data/cod_producto.csv (o ruta --file): columnas #ID compuesto y COD_PRODUCTO (OEM).
 *
 * Por fila (1 transacción):
 *  - Resuelve marca desde el sufijo del #ID (tras el último '_', p. ej. _HN → Honda / brand_id vía mapa).
 *  - Reserva SKU canónico SS-SSS-MMM-NNNN con allocateNextSku(subcategory_id, brand_id).
 *  - INSERT en products + inventory (mismo contrato que createProductWithAllocatedSku).
 *  - INSERT en product_oem_codes: oem_original (CSV), oem_normalized (OEM limpio; mismo rol que oem_clean).
 *
 * Requisitos:
 *  - JSON --brand-map: { "HN": <crm_vehicle_brands.id>, "GM": ... } (sufijos en MAYÚSCULAS).
 *  - --subcategory-id: product_subcategories.id válido para ese catálogo (combo con cada brand_id).
 *
 * Uso:
 *   node scripts/import-cod-producto-csv.js --dry-run --brand-map=scripts/data/mi-map.json --subcategory-id=1 --file=data/cod_producto.csv
 *   node scripts/import-cod-producto-csv.js --brand-map=scripts/data/mi-map.json --subcategory-id=1
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

require("../load-env-local");
const { pool } = require("../db");
const { allocateNextSku } = require("../src/services/skuGeneratorService");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);

const DRY_RUN = Boolean(args["dry-run"]);
const FILE = args.file
  ? path.resolve(String(args.file))
  : path.join(__dirname, "..", "data", "cod_producto.csv");
const BRAND_MAP_PATH = args["brand-map"] ? path.resolve(String(args["brand-map"])) : null;
const SUBCATEGORY_ID = args["subcategory-id"] != null ? parseInt(String(args["subcategory-id"]), 10) : NaN;
const COMPANY_ID =
  args["company-id"] != null ? parseInt(String(args["company-id"]), 10) : 1;
const STOCK_QTY =
  args["stock-qty"] != null ? Number(String(args["stock-qty"])) : 0;
const STOCK_MIN =
  args["stock-min"] != null ? Number(String(args["stock-min"])) : 0;
const UNIT_PRICE_USD =
  args["unit-price-usd"] != null ? Number(String(args["unit-price-usd"])) : 0;
const LIMIT = args.limit != null ? parseInt(String(args.limit), 10) : null;
const SKIP_UNMAPPED = Boolean(args["skip-unmapped"]);

function pickCsvField(row, ...aliases) {
  const keys = Object.keys(row);
  for (const a of aliases) {
    if (row[a] != null && String(row[a]).trim() !== "") return String(row[a]).trim();
  }
  const lower = aliases.map((x) => x.toLowerCase());
  for (const k of keys) {
    const nk = k.replace(/^\uFEFF/, "").trim();
    if (lower.includes(nk.toLowerCase())) return String(row[k] ?? "").trim();
  }
  return "";
}

/**
 * Formato esperado: ..._F0001_XX o variante; el sufijo de marca es el último segmento tras separar por '_'.
 */
function extractBrandSuffix(compoundId) {
  const s = String(compoundId || "").trim();
  if (!s) return null;
  const parts = s.split("_").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const suffix = parts[parts.length - 1].toUpperCase();
  if (suffix.length < 1 || suffix.length > 4) return null;
  return { suffix, refHead: parts[0] };
}

/** OEM tal cual en CSV / oem_original */
function sanitizeOemNormalized(raw) {
  let s = String(raw ?? "").trim().toUpperCase();
  s = s.replace(/[\s\-.]+/g, "");
  s = s.replace(/[^A-Z0-9]/g, "");
  return s.length ? s : null;
}

function loadBrandMap(p) {
  if (!p || !fs.existsSync(p)) {
    throw new Error(`brand-map no encontrado: ${p}`);
  }
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const map = {};
  for (const [k, v] of Object.entries(j)) {
    if (k.startsWith("_")) continue;
    const key = String(k).toUpperCase();
    const id = Number(v);
    if (!Number.isInteger(id) || id <= 0) continue;
    map[key] = id;
  }
  if (Object.keys(map).length === 0) {
    throw new Error("brand-map vacío o sin ids válidos (reemplazar 0 en el ejemplo por ids reales).");
  }
  return map;
}

async function processOne(client, row, brandMap, stats) {
  const compoundId = pickCsvField(row, "#ID", "ID");
  const codProducto = pickCsvField(row, "COD_PRODUCTO", "cod_producto");

  if (!compoundId || !codProducto) {
    stats.empty++;
    return;
  }

  const oemOriginal = String(codProducto).trim();
  const oemNorm = sanitizeOemNormalized(codProducto);
  if (!oemNorm) {
    stats.badOem++;
    return;
  }

  const parsed = extractBrandSuffix(compoundId);
  if (!parsed) {
    stats.badId++;
    return;
  }

  const brandId = brandMap[parsed.suffix];
  if (!brandId) {
    stats.unmappedSuffix++;
    if (stats.unmappedSamples.length < 30) {
      stats.unmappedSamples.push({ compoundId, suffix: parsed.suffix });
    }
    return;
  }

  const name = `OEM ${oemNorm} (${parsed.suffix})`.slice(0, 500);
  const description = `Importado cod_producto. #ID legacy: ${compoundId}`;

  if (DRY_RUN) {
    stats.wouldInsert++;
    return;
  }

  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '60s'`);

    const sku = await allocateNextSku(client, SUBCATEGORY_ID, brandId);

    const { rows: metaRows } = await client.query(
      `
      SELECT
        ps.category_id,
        cp.category_descripcion,
        b.name AS brand_name
      FROM product_subcategories ps
      JOIN category_products cp ON cp.id = ps.category_id
      JOIN crm_vehicle_brands b ON b.id = $2
      WHERE ps.id = $1
      `,
      [SUBCATEGORY_ID, brandId]
    );
    if (!metaRows.length) {
      throw new Error(`Sin catálogo para subcategory_id=${SUBCATEGORY_ID} brand_id=${brandId}`);
    }
    const meta = metaRows[0];
    const categoryText =
      meta.category_descripcion != null ? String(meta.category_descripcion) : null;
    const brandText = meta.brand_name != null ? String(meta.brand_name) : null;
    const stockAlert = STOCK_QTY <= STOCK_MIN;

    const insProd = await client.query(
      `
      INSERT INTO products (
        sku, name, description, category, brand,
        unit_price_usd, precio_usd, source, is_active,
        subcategory_id, brand_id, category_id, company_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $6, 'manual', TRUE,
        $7, $8, $9, $10
      )
      RETURNING id
      `,
      [
        sku,
        name,
        description,
        categoryText,
        brandText,
        UNIT_PRICE_USD,
        SUBCATEGORY_ID,
        brandId,
        meta.category_id,
        COMPANY_ID,
      ]
    );

    const productId = insProd.rows[0].id;

    await client.query(
      `
      INSERT INTO inventory (product_id, stock_qty, stock_min, stock_alert)
      VALUES ($1, $2, $3, $4)
      `,
      [productId, STOCK_QTY, STOCK_MIN, stockAlert]
    );

    await client.query(
      `
      INSERT INTO product_oem_codes (product_id, oem_original, oem_normalized, source)
      VALUES ($1, $2, $3, 'cod_producto_csv')
      ON CONFLICT (product_id) DO NOTHING
      `,
      [productId, oemOriginal, oemNorm]
    );

    await client.query("COMMIT");
    stats.inserted++;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    stats.errors++;
    if (stats.errorSamples.length < 20) {
      stats.errorSamples.push({ compoundId, message: e.message, code: e.code });
    }
  }
}

async function main() {
  if (!Number.isInteger(SUBCATEGORY_ID) || SUBCATEGORY_ID <= 0) {
    console.error("Obligatorio: --subcategory-id=<product_subcategories.id>");
    process.exit(1);
  }
  if (!BRAND_MAP_PATH) {
    console.error("Obligatorio: --brand-map=<ruta.json> (sufijo 2 letras → crm_vehicle_brands.id)");
    process.exit(1);
  }

  if (!fs.existsSync(FILE)) {
    console.error("No existe el CSV:", FILE);
    process.exit(1);
  }

  const subCheck = await pool.query(`SELECT 1 FROM product_subcategories WHERE id = $1`, [SUBCATEGORY_ID]);
  if (!subCheck.rows.length) {
    console.error(`subcategory_id=${SUBCATEGORY_ID} no existe en product_subcategories`);
    await pool.end();
    process.exit(1);
  }

  const brandMap = loadBrandMap(BRAND_MAP_PATH);
  const raw = fs.readFileSync(FILE, "utf8");
  const rows = parse(raw, {
    columns: true,
    delimiter: ";",
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });

  let list = rows;
  if (LIMIT && Number.isFinite(LIMIT) && LIMIT > 0) {
    list = rows.slice(0, LIMIT);
  }

  console.log(`\nimport-cod-producto-csv  ${DRY_RUN ? "[DRY-RUN]" : ""}`);
  console.log(`  archivo: ${FILE}`);
  console.log(`  filas (tras limit): ${list.length}`);
  console.log(`  subcategory_id: ${SUBCATEGORY_ID}`);
  console.log(`  brand-map: ${BRAND_MAP_PATH} (${Object.keys(brandMap).length} sufijos)\n`);

  const stats = {
    inserted: 0,
    wouldInsert: 0,
    empty: 0,
    badId: 0,
    badOem: 0,
    unmappedSuffix: 0,
    duplicateCsvId: 0,
    errors: 0,
    unmappedSamples: [],
    errorSamples: [],
  };

  const seenCompound = new Set();
  const client = await pool.connect();

  try {
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const compoundId = pickCsvField(row, "#ID", "ID");
      if (compoundId) {
        if (seenCompound.has(compoundId)) {
          stats.duplicateCsvId++;
          continue;
        }
        seenCompound.add(compoundId);
      }
      await processOne(client, row, brandMap, stats);
      if ((i + 1) % 200 === 0) {
        console.log(
          `  … ${i + 1}/${list.length}  ok_ins=${stats.inserted} err=${stats.errors} unmapped=${stats.unmappedSuffix}`
        );
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n── RESUMEN ──`);
  if (DRY_RUN) {
    console.log(`  [dry-run] insertarían producto+oem: ${stats.wouldInsert}`);
  } else {
    console.log(`  insertados (producto + inventario + OEM): ${stats.inserted}`);
  }
  console.log(`  filas vacías / sin campos: ${stats.empty}`);
  console.log(`  #ID inválido (sin sufijo): ${stats.badId}`);
  console.log(`  OEM inválido tras limpieza: ${stats.badOem}`);
  console.log(`  sufijo sin mapa: ${stats.unmappedSuffix}`);
  console.log(`  #ID duplicado en CSV: ${stats.duplicateCsvId}`);
  console.log(`  errores TX: ${stats.errors}`);
  if (stats.unmappedSamples.length) {
    console.log(`  muestra sufijos sin mapa:`, stats.unmappedSamples.slice(0, 10));
  }
  if (stats.errorSamples.length) {
    console.log(`  muestra errores:`, stats.errorSamples.slice(0, 5));
  }
  console.log("");

  if (!SKIP_UNMAPPED && stats.unmappedSuffix > 0) {
    console.error(
      `Salida con código 1: ${stats.unmappedSuffix} sufijos sin entrada en --brand-map. Completá el JSON o usá --skip-unmapped.`
    );
    await pool.end();
    process.exit(1);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
