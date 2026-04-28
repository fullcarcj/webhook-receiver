#!/usr/bin/env node
/**
 * Fusiona clientes duplicados por primary_ml_buyer_id y, si aplica, por (company_id, id_type, id_number).
 * - Conserva un "ganador" por grupo (cédula presente > nombre más largo > id menor).
 * - Los demás se fusionan con mergeCustomers(..., { softDeleteDropped: true }).
 * - Al final intenta crear índice único parcial uq_customers_primary_ml_buyer_active.
 *
 * Uso:
 *   node scripts/mergeDuplicateCustomersByMlBuyer.js --dry-run
 *   node scripts/mergeDuplicateCustomersByMlBuyer.js
 *   node scripts/mergeDuplicateCustomersByMlBuyer.js --skip-index
 *
 * Requiere: DATABASE_URL (load-env-local), migración columnas merged_*:
 *   node scripts/run-sql-file-pg.js sql/20260428_customers_merge_soft_unique_ml_buyer.sql
 */
"use strict";

require("../load-env-local");
const path = require("path");
const { pool } = require("../db");
const { runSqlFile } = require("./run-sql-file-pg");
const { mergeCustomers } = require("../src/services/customerMergeService");

function hasFlag(name) {
  return process.argv.includes(name);
}

function pickKeeper(rows) {
  const scored = rows.map((r) => {
    const docScore =
      r.id_number != null && String(r.id_number).trim() !== "" ? 1 : 0;
    const nameLen = String(r.full_name || "").trim().length;
    return { r, docScore, nameLen, id: Number(r.id) };
  });
  scored.sort((a, b) => {
    if (b.docScore !== a.docScore) return b.docScore - a.docScore;
    if (b.nameLen !== a.nameLen) return b.nameLen - a.nameLen;
    return a.id - b.id;
  });
  return scored[0].r;
}

async function mergeGroupByIds(ids, label, dryRun) {
  const { rows: custRows } = await pool.query(
    `SELECT * FROM customers WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids]
  );
  if (custRows.length < 2) return { merged: 0, skipped: custRows.length };
  const keeper = pickKeeper(custRows);
  const losers = custRows
    .filter((c) => Number(c.id) !== Number(keeper.id))
    .sort((a, b) => Number(b.id) - Number(a.id));
  let merged = 0;
  for (const l of losers) {
    // eslint-disable-next-line no-console
    console.log(
      `[${label}] keep id=${keeper.id} "${String(keeper.full_name).slice(0, 60)}" ← drop id=${l.id} "${String(l.full_name).slice(0, 60)}"`,
    );
    if (!dryRun) {
      await mergeCustomers(keeper.id, l.id, {
        triggeredBy: "merge_duplicate_ml_buyer_script",
        softDeleteDropped: true,
      });
      merged += 1;
    }
  }
  return { merged, skipped: 0 };
}

async function main() {
  const dryRun = hasFlag("--dry-run");
  const skipIndex = hasFlag("--skip-index");

  if (!dryRun) {
    await runSqlFile(
      path.join(__dirname, "..", "sql", "20260428_customers_merge_soft_unique_ml_buyer.sql"),
    );
  }

  const dupMl = await pool.query(
    `SELECT primary_ml_buyer_id, array_agg(id ORDER BY id) AS ids
     FROM customers
     WHERE is_active = TRUE AND primary_ml_buyer_id IS NOT NULL
     GROUP BY primary_ml_buyer_id
     HAVING COUNT(*) > 1`,
  );

  let totalMerged = 0;
  for (const row of dupMl.rows) {
    const ids = row.ids.map((x) => Number(x));
    const { merged } = await mergeGroupByIds(ids, `ml_buyer=${row.primary_ml_buyer_id}`, dryRun);
    totalMerged += merged;
  }

  const dupDoc = await pool.query(
    `SELECT company_id, id_type, id_number, array_agg(id ORDER BY id) AS ids
     FROM customers
     WHERE is_active = TRUE
       AND id_type IS NOT NULL
       AND NULLIF(TRIM(id_number), '') IS NOT NULL
     GROUP BY company_id, id_type, id_number
     HAVING COUNT(*) > 1`,
  );

  for (const row of dupDoc.rows) {
    const ids = row.ids.map((x) => Number(x));
    const { merged } = await mergeGroupByIds(
      ids,
      `doc=${row.company_id}/${row.id_type}/${String(row.id_number).slice(0, 20)}`,
      dryRun,
    );
    totalMerged += merged;
  }

  // eslint-disable-next-line no-console
  console.log(
    dryRun
      ? `[dry-run] grupos ml: ${dupMl.rows.length}, grupos doc: ${dupDoc.rows.length} (sin cambios)`
      : `Listo. Fusiones aplicadas: ${totalMerged}. Grupos ml: ${dupMl.rows.length}, grupos doc: ${dupDoc.rows.length}`,
  );

  if (!dryRun && !skipIndex) {
    try {
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_primary_ml_buyer_active
        ON customers (primary_ml_buyer_id)
        WHERE primary_ml_buyer_id IS NOT NULL AND is_active = TRUE
      `);
      // eslint-disable-next-line no-console
      console.log("Índice uq_customers_primary_ml_buyer_active OK (o ya existía).");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        "No se pudo crear el índice único (¿aún hay duplicados activos con mismo buyer?).",
        e && e.message ? e.message : e,
      );
      process.exitCode = 1;
    }
  }

  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
