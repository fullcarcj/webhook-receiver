#!/usr/bin/env node
/**
 * bootstrap-ml-publications.js
 * Pobla ml_publications desde ml_listings + ml_sku_mapping + products + bin_stock.
 *
 * Pre-requisitos:
 *   1. wms:bootstrap-stock  (bin_stock inicializado)
 *   2. wms:import-inventory (stock_qty cargado, opcional)
 *   3. ml:bootstrap-sku-mapping (ml_sku_mapping poblado)
 *
 * Constraints que se respetan:
 *   - ml_publications.ml_item_id UNIQUE
 *   - ml_publications.ml_user_id REFERENCES ml_accounts(ml_user_id) → solo
 *     se insertan publicaciones cuya cuenta existe en ml_accounts.
 *   - ml_status CHECK IN ('active','paused','closed','under_review')
 *
 * Uso: npm run ml:bootstrap-publications
 */
"use strict";

require("../load-env-local");
const { Client } = require("pg");
const { poolSslOption } = require("./run-sql-file-pg");

// Valores válidos de ml_status en ml_publications
const VALID_ML_STATUS = new Set(["active", "paused", "closed", "under_review"]);

async function main() {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) { console.error("[ml:bootstrap-publications] DATABASE_URL no definida"); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: poolSslOption() });
  await client.connect();

  try {
    // ── Verificar pre-requisitos ──────────────────────────────────────────
    const { rows: [{ n: mappingCount }] } = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM ml_sku_mapping`
    );
    if (Number(mappingCount) === 0) {
      console.warn("[ml:bootstrap-publications] ADVERTENCIA: ml_sku_mapping está vacío.");
      console.warn("  → Ejecutar primero: npm run ml:bootstrap-sku-mapping");
    }

    // ── INSERT principal via SQL puro (más eficiente que JS row-by-row) ──
    // Usamos un CTE para preparar los datos y ON CONFLICT para idempotencia.
    // Solo inserta publicaciones cuya ml_user_id existe en ml_accounts.
    const result = await client.query(`
      WITH candidates AS (
        SELECT DISTINCT ON (l.item_id)
          p.id                                        AS product_id,
          p.sku,
          l.item_id                                   AS ml_item_id,
          l.title                                     AS ml_title,
          CASE
            WHEN l.status IN ('active','paused','closed','under_review')
              THEN l.status
            ELSE 'closed'
          END                                         AS ml_status,
          l.price::numeric(10,4)                      AS price_usd,
          m.ml_user_id,
          COALESCE(bs.qty_available, 0)               AS stock_qty
        FROM ml_listings l
        JOIN ml_sku_mapping m    ON m.ml_item_id = l.item_id
        JOIN products p          ON p.sku = m.master_sku
        JOIN ml_accounts acc     ON acc.ml_user_id = m.ml_user_id
        LEFT JOIN bin_stock bs   ON bs.product_sku = p.sku
        ORDER BY l.item_id, bs.qty_available DESC NULLS LAST
      )
      INSERT INTO ml_publications
        (product_id, sku, ml_item_id, ml_title, ml_status,
         stock_qty, price_usd, ml_user_id)
      SELECT
        product_id, sku, ml_item_id, ml_title, ml_status,
        stock_qty, price_usd, ml_user_id
      FROM candidates
      ON CONFLICT (ml_item_id) DO UPDATE
        SET stock_qty      = EXCLUDED.stock_qty,
            price_usd      = EXCLUDED.price_usd,
            ml_title       = EXCLUDED.ml_title,
            ml_status      = EXCLUDED.ml_status,
            ml_user_id     = EXCLUDED.ml_user_id,
            updated_at     = NOW(),
            last_synced_at = NOW()
    `);

    const upserted = result.rowCount || 0;

    // ── Estadísticas post-insert ──────────────────────────────────────────
    const { rows: [stats] } = await client.query(`
      SELECT
        COUNT(*)::bigint                                               AS total,
        COUNT(*) FILTER (WHERE ml_status = 'active')::bigint          AS activas,
        COUNT(*) FILTER (WHERE ml_status = 'paused')::bigint          AS pausadas,
        COUNT(*) FILTER (WHERE ml_status = 'closed')::bigint          AS cerradas,
        COUNT(*) FILTER (WHERE stock_qty  > 0)::bigint                AS con_stock,
        COUNT(*) FILTER (WHERE stock_qty  = 0)::bigint                AS sin_stock
      FROM ml_publications
    `);

    // ── Publicaciones sin ml_user_id en ml_accounts (no insertadas) ───────
    const { rows: [{ n: skippedNoAccount }] } = await client.query(`
      SELECT COUNT(*)::bigint AS n
      FROM ml_listings l
      JOIN ml_sku_mapping m ON m.ml_item_id = l.item_id
      WHERE NOT EXISTS (
        SELECT 1 FROM ml_accounts acc WHERE acc.ml_user_id = m.ml_user_id
      )
    `);

    console.log("\n[ml:bootstrap-publications] ─────────── RESULTADO ───────────");
    console.log(`  Filas upserted en ml_publications: ${upserted}`);
    console.log(`  Total en ml_publications ahora:    ${stats.total}`);
    console.log(`    Activas:   ${stats.activas}`);
    console.log(`    Pausadas:  ${stats.pausadas}`);
    console.log(`    Cerradas:  ${stats.cerradas}`);
    console.log(`    Con stock: ${stats.con_stock}`);
    console.log(`    Sin stock: ${stats.sin_stock}`);
    if (Number(skippedNoAccount) > 0) {
      console.log(`\n  ADVERTENCIA: ${skippedNoAccount} mapeos omitidos por ml_user_id sin cuenta en ml_accounts.`);
      console.log("    → Verificar ml_accounts y re-ejecutar si es necesario.");
    }
    console.log("[ml:bootstrap-publications] OK");

  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[ml:bootstrap-publications] FATAL:", e.message);
  process.exit(1);
});
