#!/usr/bin/env node
/**
 * Repuebla product_oem_codes desde CSV (fuente de verdad).
 * - Columna #ID = valor exacto de products.sku_old
 * - Columna COD_PRODUCTO = OEM correcto (oem_original tal cual; oem_normalized = mayúsculas + solo alfanumérico)
 *
 * Uso:
 *   node scripts/migrate-oem-from-csv.js data/cod_producto.csv
 *   node scripts/migrate-oem-from-csv.js --dry-run data/cod_producto.csv
 *
 * Requiere: load-env-local + DATABASE_URL (mismo patrón que assign-product-identity.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

require("../load-env-local");
const { pool } = require("../db");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const posArgs = argv.filter((a) => !a.startsWith("--"));
const CSV_PATH = posArgs[0] ? path.resolve(posArgs[0]) : null;

const BATCH_SIZE = 200;

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

function normalizeOem(s) {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function loadSkuOldToProductId() {
  const { rows } = await pool.query(`
    SELECT id, sku_old::text AS sku_old
    FROM products
    WHERE sku_old IS NOT NULL AND btrim(sku_old::text) <> ''
  `);
  const map = new Map();
  for (const r of rows) {
    const k = String(r.sku_old).trim();
    if (k) map.set(k, Number(r.id));
  }
  return map;
}

async function main() {
  if (!CSV_PATH || !fs.existsSync(CSV_PATH)) {
    console.error("Uso: node scripts/migrate-oem-from-csv.js [--dry-run] <ruta/archivo.csv>");
    process.exit(1);
  }

  console.log(`\nmigrate-oem-from-csv  ${DRY_RUN ? "[DRY-RUN]" : ""}`);
  console.log(`  CSV: ${CSV_PATH}\n`);

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const csvRows = parse(raw, {
    columns: true,
    delimiter: ";",
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });

  console.log(`  Filas CSV: ${csvRows.length}`);
  console.log(`  Cargando índice products.sku_old → id…`);
  const skuOldToId = await loadSkuOldToProductId();
  console.log(`  → ${skuOldToId.size} sku_old distintos en products\n`);

  /** Una entrada por fila CSV (orden preservado) para lotes y logs */
  const records = [];
  let csvEmpty = 0;
  let csvBadOem = 0;

  for (const row of csvRows) {
    const legacyId = pickCsvField(row, "#ID", "ID");
    const cod = pickCsvField(row, "COD_PRODUCTO", "cod_producto");
    if (!legacyId) {
      csvEmpty++;
      records.push({ kind: "sin_id", legacyId: "", product_id: null, oem_original: "", oem_normalized: "" });
      continue;
    }
    const oemOriginal = String(cod).trim();
    const oemNorm = normalizeOem(cod);
    if (!oemNorm) {
      csvBadOem++;
      records.push({ kind: "oem_invalido", legacyId, product_id: null, oem_original: oemOriginal, oem_normalized: "" });
      continue;
    }
    const pid = skuOldToId.get(legacyId);
    records.push({
      kind: pid == null ? "no_encontrado" : "ok",
      legacyId,
      product_id: pid,
      oem_original: oemOriginal,
      oem_normalized: oemNorm,
    });
  }

  const totalOk = records.filter((r) => r.kind === "ok").length;
  const totalNoEncontrado = records.filter((r) => r.kind === "no_encontrado").length;

  console.log(`  Filas con producto encontrado: ${totalOk}`);
  console.log(`  Filas sin producto (sku_old no coincide): ${totalNoEncontrado}`);
  console.log(`  CSV sin #ID: ${csvEmpty}`);
  console.log(`  CSV sin OEM normalizable: ${csvBadOem}\n`);

  if (DRY_RUN) {
    console.log("  [dry-run] no se ejecuta TRUNCATE ni INSERT.\n");
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE public.product_oem_codes RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");
    console.log("  OK: TRUNCATE public.product_oem_codes RESTART IDENTITY CASCADE\n");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("  Error en TRUNCATE:", e.message);
    await pool.end();
    process.exit(1);
  } finally {
    client.release();
  }

  let sumInserted = 0;
  let sumErrors = 0;
  const batches = Math.ceil(records.length / BATCH_SIZE) || 0;

  for (let b = 0; b < batches; b++) {
    const slice = records.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (slice.length === 0) continue;

    const noEncontrados = slice.filter((r) => r.kind === "no_encontrado").length;

    const toInsert = slice.filter((r) => r.kind === "ok");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      let inserted = 0;
      let omitidosConflicto = 0;
      if (toInsert.length > 0) {
        const ids = toInsert.map((x) => x.product_id);
        const origs = toInsert.map((x) => x.oem_original);
        const norms = toInsert.map((x) => x.oem_normalized);
        const ins = await c.query(
          `
          INSERT INTO product_oem_codes (product_id, oem_original, oem_normalized, source)
          SELECT u.product_id, u.oem_original, u.oem_normalized, 'csv_migration'
          FROM unnest($1::bigint[], $2::text[], $3::text[]) AS u(product_id, oem_original, oem_normalized)
          ON CONFLICT (product_id) DO NOTHING
          RETURNING product_id
          `,
          [ids, origs, norms]
        );
        inserted = ins.rowCount;
        omitidosConflicto = toInsert.length - inserted;
      }
      await c.query("COMMIT");
      sumInserted += inserted;
      console.log(
        `  Lote ${b + 1}/${batches}: insertados=${inserted} no_encontrados=${noEncontrados} omitidos_conflicto=${omitidosConflicto} errores=0 (filas_lote=${slice.length})`
      );
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      sumErrors++;
      console.error(
        `  Lote ${b + 1}/${batches}: insertados=0 no_encontrados=${noEncontrados} errores=1 (filas_lote=${slice.length}) → ${e.message || e}`
      );
    } finally {
      c.release();
    }
  }

  console.log(`\n── RESUMEN ──`);
  console.log(`  insertados (RETURNING acumulado): ${sumInserted}`);
  console.log(`  no_encontrados (sku_old sin producto, acumulado): ${totalNoEncontrado}`);
  console.log(`  CSV sin #ID: ${csvEmpty}`);
  console.log(`  OEM vacío tras normalizar: ${csvBadOem}`);
  console.log(`  errores de lote (TX): ${sumErrors}`);

  const { rows: ver } = await pool.query(`
    SELECT
      COUNT(*)::bigint AS total_products,
      COUNT(poc.product_id)::bigint AS con_oem,
      (COUNT(*) - COUNT(poc.product_id))::bigint AS sin_oem
    FROM products p
    LEFT JOIN product_oem_codes poc ON p.id = poc.product_id
  `);

  console.log(`\n  Verificación:`);
  console.log(`    total_products: ${ver[0].total_products}`);
  console.log(`    con_oem:        ${ver[0].con_oem}`);
  console.log(`    sin_oem:        ${ver[0].sin_oem}\n`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
