#!/usr/bin/env node
/**
 * Compacta `products.id` a 1..N (según el orden actual por `id` ASC) y actualiza
 * todas las FKs en PostgreSQL que apuntan a `public.products(id)`.
 *
 * Las tablas que referencian `products(sku)` no se tocan (el SKU no cambia).
 *
 * Uso:
 *   node scripts/renumber-product-ids.js --dry-run
 *   node scripts/renumber-product-ids.js --execute
 *
 * Requiere: ventana de mantenimiento; una sola instancia; sin otras transacciones largas en `products`.
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
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
    throw new Error(`identificador no seguro: ${t}`);
  }
  return `"${t.replace(/"/g, '""')}"`;
}

function fqTable(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * @param {import("pg").PoolClient} client
 */
async function listFksToProductsId(client) {
  const { rows } = await client.query(`
    SELECT
      c.conname,
      nr.nspname AS child_schema,
      r.relname AS child_table,
      a.attname AS child_column,
      pg_get_constraintdef(c.oid) AS pgdef
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
      AND fa.attname = 'id'
      AND array_length(c.conkey, 1) = 1
    ORDER BY nr.nspname, r.relname, c.conname
  `);
  return rows;
}

async function main() {
  const execute = process.argv.includes("--execute");
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
    const fks = await listFksToProductsId(client);
    const { rows: prodRows } = await client.query(
      `SELECT COUNT(*)::bigint AS n, MIN(id) AS min_id, MAX(id) AS max_id FROM products`
    );
    const n = Number(prodRows[0].n);
    const minId = prodRows[0].min_id;
    const maxId = prodRows[0].max_id;

    console.log(`Productos: ${n} filas; min(id)=${minId} max(id)=${maxId}`);
    console.log(`FKs hacia public.products(id): ${fks.length}`);
    for (const fk of fks) {
      console.log(`  - ${fk.child_schema}.${fk.child_table}.${fk.child_column}  (${fk.conname})`);
    }

    if (n === 0) {
      console.log("Nada que hacer.");
      return;
    }

    console.log(
      `Objetivo: cada fila quedará con id entre 1 y ${n} (sin huecos: último id = ${n} = total de registros).`
    );

    const { rows: mapPreview } = await client.query(`
      SELECT id AS old_id, ROW_NUMBER() OVER (ORDER BY id)::bigint AS new_id
      FROM products
      ORDER BY id
      LIMIT 15
    `);
    const { rows: mapTail } = await client.query(`
      SELECT id AS old_id, ROW_NUMBER() OVER (ORDER BY id)::bigint AS new_id
      FROM products
      ORDER BY id DESC
      LIMIT 3
    `);
    console.log("Mapeo (primeras filas, orden por id ASC):");
    for (const r of mapPreview) {
      console.log(`  ${r.old_id} -> ${r.new_id}`);
    }
    console.log("Mapeo (últimas 3 filas):");
    for (const r of mapTail.reverse()) {
      console.log(`  ${r.old_id} -> ${r.new_id}`);
    }

    for (const fk of fks) {
      const q = `
        SELECT COUNT(*)::bigint AS c
        FROM ${fqTable(fk.child_schema, fk.child_table)} t
        WHERE t.${quoteIdent(fk.child_column)} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = t.${quoteIdent(fk.child_column)})
      `;
      const { rows: orphan } = await client.query(q);
      const oc = Number(orphan[0].c);
      if (oc > 0) {
        console.warn(
          `ADVERTENCIA: ${fk.child_schema}.${fk.child_table}.${fk.child_column} tiene ${oc} filas con product_id huérfano (no existe en products). Corregir antes de --execute.`
        );
      }
    }

    if (!execute) {
      console.log("\nModo simulación. Para aplicar: node scripts/renumber-product-ids.js --execute");
      return;
    }

    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('renumber-product-ids'))`);

    for (const fk of fks) {
      if (!fk.pgdef) throw new Error(`Sin definición para FK ${fk.conname}`);
      await client.query(
        `ALTER TABLE ${fqTable(fk.child_schema, fk.child_table)} DROP CONSTRAINT ${quoteIdent(fk.conname)}`
      );
    }

    await client.query(`
      CREATE TEMP TABLE _product_id_remap ON COMMIT DROP AS
      SELECT id AS old_id, ROW_NUMBER() OVER (ORDER BY id)::bigint AS new_id
      FROM products
    `);

    for (const fk of fks) {
      const tbl = fqTable(fk.child_schema, fk.child_table);
      const col = quoteIdent(fk.child_column);
      await client.query(`
        UPDATE ${tbl} t
        SET ${col} = -t.${col}
        WHERE t.${col} IS NOT NULL AND t.${col} > 0
      `);
    }

    await client.query(`UPDATE products SET id = -id WHERE id > 0`);

    for (const fk of fks) {
      const tbl = fqTable(fk.child_schema, fk.child_table);
      const col = quoteIdent(fk.child_column);
      await client.query(`
        UPDATE ${tbl} t
        SET ${col} = m.new_id
        FROM _product_id_remap m
        WHERE t.${col} = -m.old_id
      `);
    }

    await client.query(`
      UPDATE products p
      SET id = m.new_id
      FROM _product_id_remap m
      WHERE p.id = -m.old_id
    `);

    for (const fk of fks) {
      await client.query(
        `ALTER TABLE ${fqTable(fk.child_schema, fk.child_table)} ADD CONSTRAINT ${quoteIdent(fk.conname)} ${fk.pgdef}`
      );
    }

    const { rows: seqRow } = await client.query(
      `SELECT pg_get_serial_sequence('public.products', 'id') AS seq`
    );
    const seq = seqRow[0] && seqRow[0].seq;
    if (seq) {
      await client.query(`SELECT setval($1::regclass, COALESCE((SELECT MAX(id) FROM products), 1), true)`, [
        seq,
      ]);
    }

    await client.query("COMMIT");
    console.log("Listo: IDs compactados y secuencia actualizada (si existía serial/bigserial en id).");

    const { rows: check } = await client.query(
      `SELECT COUNT(*)::bigint AS n, MIN(id) AS min_id, MAX(id) AS max_id FROM products`
    );
    const cn = Number(check[0].n);
    const cmin = Number(check[0].min_id);
    const cmax = Number(check[0].max_id);
    console.log(`Verificación: ${cn} filas; min(id)=${cmin} max(id)=${cmax}`);
    if (cn > 0 && (cmin !== 1 || cmax !== cn)) {
      throw new Error(
        `Invariante rota: se esperaba min(id)=1 y max(id)=${cn} (total filas). Obtuvo min=${cmin} max=${cmax}.`
      );
    }
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
