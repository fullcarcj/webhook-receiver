#!/usr/bin/env node
/**
 * Verifica el contrato de sku_prefix:
 * - Dentro de cada tabla, no puede haber dos filas con el mismo sku_prefix (UNIQUE en BD).
 * - Valores deben cumplir CHECK solo A-Z mayúsculas y longitud 2 o 3 según tabla.
 *
 * Uso: node scripts/verify-sku-prefix-contract.js
 */
"use strict";

require("../load-env-local");
const { pool } = require("../db");

const TABLES = [
  {
    name: "category_products",
    len: 2,
    cols: "id, sku_prefix, category_descripcion",
  },
  {
    name: "product_subcategories",
    len: 3,
    cols: "id, sku_prefix, name, category_id",
  },
  {
    name: "crm_vehicle_brands",
    len: 3,
    cols: "id, sku_prefix, name",
    optional: true,
  },
];

function pattern(len) {
  return len === 2 ? "^[A-Z]{2}$" : "^[A-Z]{3}$";
}

async function tableExists(name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return rows.length > 0;
}

async function columnExists(table, col) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, col]
  );
  return rows.length > 0;
}

async function main() {
  let ok = true;

  for (const t of TABLES) {
    if (!(await tableExists(t.name))) {
      if (t.optional) {
        console.log(`[verify-sku-prefix] SKIP tabla opcional no existe: ${t.name}`);
        continue;
      }
      console.error(`[verify-sku-prefix] FAIL tabla requerida no existe: ${t.name}`);
      ok = false;
      continue;
    }

    if (!(await columnExists(t.name, "sku_prefix"))) {
      console.error(`[verify-sku-prefix] FAIL falta columna ${t.name}.sku_prefix — ejecuta npm run db:sku-prefixes`);
      ok = false;
      continue;
    }

    const dup = await pool.query(
      `SELECT sku_prefix, COUNT(*)::int AS n
       FROM ${t.name}
       GROUP BY sku_prefix
       HAVING COUNT(*) > 1`
    );
    if (dup.rows.length > 0) {
      console.error(`[verify-sku-prefix] FAIL duplicados en ${t.name}:`, dup.rows);
      ok = false;
    } else {
      console.log(`[verify-sku-prefix] OK sin duplicados de sku_prefix en ${t.name}`);
    }

    const rx = pattern(t.len);
    const bad = await pool.query(
      `SELECT id, sku_prefix FROM ${t.name} WHERE sku_prefix IS NULL OR sku_prefix !~ $1`,
      [rx]
    );
    if (bad.rows.length > 0) {
      console.error(`[verify-sku-prefix] FAIL valores inválidos (esperado ${t.len} letras A-Z) en ${t.name}:`, bad.rows);
      ok = false;
    } else {
      console.log(`[verify-sku-prefix] OK formato A-Z x${t.len} en ${t.name}`);
    }

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = $1 AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%sku_prefix%'`,
      [t.name]
    );
    if (idx.rows.length === 0) {
      console.warn(`[verify-sku-prefix] WARN no se encontró índice UNIQUE explícito en ${t.name}.sku_prefix (puede ser constraint único con otro nombre).`);
    } else {
      console.log(`[verify-sku-prefix] OK índice/unicidad: ${idx.rows.map((r) => r.indexname).join(", ")}`);
    }
  }

  if (!ok) process.exit(1);
  console.log("[verify-sku-prefix] Contrato cumplido: prefijos únicos dentro de cada tabla + formato letras.");
}

main().catch((e) => {
  console.error("[verify-sku-prefix]", e.message);
  process.exit(1);
});
