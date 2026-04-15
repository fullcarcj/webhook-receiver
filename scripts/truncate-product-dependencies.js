#!/usr/bin/env node
/**
 * Vacía tablas que dependen de `public.products` por cadena de FKs (incl. hijas de hijas,
 * p. ej. ml_paused_publications → ml_publications → products).
 *
 * Modos:
 *   --children-only   Solo tablas asociadas; NO borra filas de `products` (útil antes de renumerar id).
 *   --including-products  Trunca `products` y todo lo que cuelga (catálogo vacío + dependientes).
 *
 * Uso:
 *   node scripts/truncate-product-dependencies.js --dry-run
 *   node scripts/truncate-product-dependencies.js --execute --children-only --confirm=VACIAR
 *   node scripts/truncate-product-dependencies.js --execute --including-products --confirm=VACIAR
 *
 * Destructivo: backup antes. Requiere ventana sin escrituras concurrentes.
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

function parseArgs(argv) {
  const out = { dryRun: true, execute: false, childrenOnly: false, includingProducts: false, confirm: "" };
  for (const a of argv) {
    if (a === "--execute") out.execute = true;
    if (a === "--dry-run") out.execute = false;
    if (a === "--children-only") out.childrenOnly = true;
    if (a === "--including-products") out.includingProducts = true;
    const m = /^--confirm=(.+)$/.exec(a);
    if (m) out.confirm = String(m[1]).trim();
  }
  if (!out.childrenOnly && !out.includingProducts) out.childrenOnly = true;
  return out;
}

/**
 * Tablas en `public` que referencian `products` o referencian a otra tabla de la cadena (recursivo).
 * @param {import("pg").Client} client
 */
async function listDependentTables(client) {
  const { rows } = await client.query(`
    WITH RECURSIVE chain AS (
      SELECT c.conrelid AS tbl
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f'
        AND n.nspname = 'public'
        AND c.confrelid = 'public.products'::regclass
      UNION
      SELECT c.conrelid
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      JOIN chain ch ON c.confrelid = ch.tbl
      WHERE c.contype = 'f'
        AND n.nspname = 'public'
    )
    SELECT DISTINCT tbl
    FROM chain
  `);
  return rows.map((r) => r.tbl).filter((oid) => oid != null);
}

async function countRows(client, fqName) {
  const { rows } = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${fqName}`);
  return Number(rows[0].n);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.childrenOnly && opts.includingProducts) {
    console.error("Usa solo uno: --children-only o --including-products");
    process.exit(1);
  }

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
    const { rows: prodOid } = await client.query(`SELECT 'public.products'::regclass::oid AS oid`);
    const productsOid = prodOid[0].oid;

    const oids = await listDependentTables(client);
    const { rows: names } = await client.query(
      `
      SELECT c.oid, n.nspname AS schema, c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = ANY($1::oid[])
        AND c.relkind = 'r'
      ORDER BY n.nspname, c.relname
    `,
      [oids]
    );

    const tables = names.map((r) => ({
      oid: r.oid,
      fq: `"${String(r.schema).replace(/"/g, '""')}"."${String(r.name).replace(/"/g, '""')}"`,
      label: `${r.schema}.${r.name}`,
    }));

    console.log(`Modo: ${opts.includingProducts ? "incluye products (nuclear)" : "solo tablas hijas (conserva products)"}`);
    console.log(`Tablas dependientes de public.products (cadena FK): ${tables.length}`);
    for (const t of tables) {
      const n = await countRows(client, t.fq);
      console.log(`  ${t.label}  ${n} filas`);
    }

    const { rows: pc } = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.products`);
    console.log(`public.products  ${Number(pc[0].n)} filas`);

    if (!opts.execute) {
      console.log(
        "\nSimulación. Para ejecutar: --execute --children-only --confirm=VACIAR   (o --including-products)"
      );
      return;
    }

    if (opts.confirm !== "VACIAR") {
      console.error('Añade --confirm=VACIAR para confirmar borrado destructivo.');
      process.exit(1);
    }

    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('truncate-product-dependencies'))`);

    if (opts.includingProducts) {
      await client.query(`TRUNCATE public.products RESTART IDENTITY CASCADE`);
      console.log("OK: TRUNCATE public.products RESTART IDENTITY CASCADE");
    } else {
      if (tables.length === 0) {
        console.log("No hay tablas hijas que vaciar.");
        await client.query("COMMIT");
        return;
      }
      const list = tables.map((t) => t.fq).join(", ");
      await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
      console.log(`OK: TRUNCATE ${tables.length} tabla(s) RESTART IDENTITY CASCADE (products intacto).`);
    }

    await client.query("COMMIT");
    console.log("Listo. Puedes ejecutar scripts/renumber-product-ids.js si renumeras id.");
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
