#!/usr/bin/env node
/**
 * Vacía la columna `products.sku` (la pone en NULL). En SQL no existe TRUNCATE sobre una columna:
 * se hace UPDATE + quitar NOT NULL si aplica.
 *
 * Respaldo: `sku_old = COALESCE(sku_old, sku)` si existe la columna `sku_old`.
 *
 * Requiere 0 filas hijas con FK a `products(sku)` con valor (salvo --force).
 * Si existe una tabla aparte `public.sku`, además hace TRUNCATE de esa tabla.
 *
 * Uso:
 *   node scripts/clear-products-sku-column.js --dry-run
 *   node scripts/clear-products-sku-column.js --execute --confirm=CLEAR
 */
"use strict";

require("../load-env-local");
const { Client } = require("pg");

function poolSslOption() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!raw || process.env.PGSSLMODE === "disable") return false;
  if (/sslmode=disable/i.test(raw)) return false;
  const local =
    /@localhost[:\/]/i.test(raw) ||
    /@127\.0\.0\.1[:\/]/i.test(raw) ||
    /:\/\/localhost[:\/]/i.test(raw) ||
    /:\/\/127\.0\.0\.1[:\/]/i.test(raw);
  if (local) return false;
  return { rejectUnauthorized: false };
}

function quoteIdent(s) {
  const t = String(s);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) throw new Error(`identificador no seguro: ${t}`);
  return `"${t.replace(/"/g, '""')}"`;
}

/**
 * Tablas con FK a public.products(sku) (columna referenciada = sku).
 * @param {import("pg").Client} client
 */
async function listFksToProductsSku(client) {
  const { rows } = await client.query(`
    SELECT
      nr.nspname AS child_schema,
      r.relname AS child_table,
      a.attname AS child_column
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace nr ON nr.oid = r.relnamespace
    JOIN pg_class fr ON fr.oid = c.confrelid
    JOIN pg_namespace nf ON nf.oid = fr.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] AND NOT a.attisdropped
    JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1] AND NOT fa.attisdropped
    WHERE c.contype = 'f'
      AND nf.nspname = 'public'
      AND fr.relname = 'products'
      AND fa.attname = 'sku'
      AND array_length(c.conkey, 1) = 1
    ORDER BY nr.nspname, r.relname
  `);
  return rows;
}

async function countChildRefs(client, fks) {
  let total = 0;
  const detail = [];
  for (const fk of fks) {
    const fq = `${quoteIdent(fk.child_schema)}.${quoteIdent(fk.child_table)}`;
    const col = quoteIdent(fk.child_column);
    const { rows } = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM ${fq} WHERE ${col} IS NOT NULL AND btrim(${col}::text) <> ''`
    );
    const n = Number(rows[0].n);
    total += n;
    if (n > 0) detail.push({ table: `${fk.child_schema}.${fk.child_table}`, n });
  }
  return { total, detail };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const force = process.argv.includes("--force");
  const confirm = (process.argv.find((a) => a.startsWith("--confirm=")) || "").split("=")[1] || "";

  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url) {
    console.error("DATABASE_URL no definida.");
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: poolSslOption(),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
  });
  await client.connect();

  try {
    const { rows: skuTable } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'sku'
      ) AS exists
    `);
    const hasSkuTable = Boolean(skuTable[0] && skuTable[0].exists);

    const { rows: skuOldCol } = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'sku_old'
      ) AS exists
    `);
    const hasSkuOld = Boolean(skuOldCol[0] && skuOldCol[0].exists);

    const fks = await listFksToProductsSku(client);
    const { total: refTotal, detail: refDetail } = await countChildRefs(client, fks);

    const { rows: prodCount } = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM public.products WHERE sku IS NOT NULL AND btrim(sku::text) <> ''`
    );
    const nProductsWithSku = Number(prodCount[0].n);

    console.log(`Tabla public.sku: ${hasSkuTable ? "existe (se puede TRUNCATE)" : "no existe"}`);
    console.log(`Columna products.sku_old: ${hasSkuOld ? "sí" : "no (solo se respalda si existe)"}`);
    console.log(`Productos con sku no vacío: ${nProductsWithSku}`);
    console.log(`Filas en tablas hijas (FK → products.sku) con valor no vacío: ${refTotal}`);
    if (refDetail.length) {
      refDetail.forEach((d) => console.log(`  - ${d.table}: ${d.n}`));
    }

    if (refTotal > 0 && !force) {
      console.error(
        "\nAborta: hay referencias a SKU desde tablas hijas. Vacía esas tablas primero (p. ej. npm run truncate:product-deps) o usa --force bajo tu responsabilidad."
      );
      process.exit(1);
    }
    if (refTotal > 0 && force) {
      console.warn("\n--force: continuando aunque haya referencias en tablas hijas (FK pueden quedar rotas).\n");
    }

    if (!execute) {
      console.log("\nSimulación. Para ejecutar: node scripts/clear-products-sku-column.js --execute --confirm=CLEAR");
      return;
    }

    if (confirm !== "CLEAR") {
      console.error('Falta --confirm=CLEAR');
      process.exit(1);
    }

    await client.query("BEGIN");

    if (hasSkuTable) {
      await client.query(`TRUNCATE public.sku RESTART IDENTITY CASCADE`);
      console.log("OK: TRUNCATE public.sku RESTART IDENTITY CASCADE");
    }

    if (hasSkuOld) {
      const r = await client.query(`
        UPDATE public.products
        SET sku_old = COALESCE(sku_old, sku)
        WHERE sku IS NOT NULL AND btrim(sku::text) <> ''
      `);
      console.log(`OK: sku_old = COALESCE(sku_old, sku) en ${r.rowCount} fila(s) (no pisa sku_old ya relleno)`);
    }

    await client.query(`ALTER TABLE public.products ALTER COLUMN sku DROP NOT NULL`);

    const cleared = await client.query(`UPDATE public.products SET sku = NULL`);
    console.log(`OK: products.sku = NULL en ${cleared.rowCount} fila(s)`);

    await client.query("COMMIT");
    console.log("\nListo. Ejecutá: node scripts/bulk-assign-sku-from-identity.js");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error(e.message || e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
