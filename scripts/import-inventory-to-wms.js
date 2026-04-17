#!/usr/bin/env node
/**
 * import-inventory-to-wms.js
 * Migra stock_qty de la tabla `inventory` a bin_stock.qty_available.
 *
 * Actualiza solo las filas que ya existen en bin_stock (ejecutar DESPUÉS
 * de wms:bootstrap-stock). Si inventory está vacía o no tiene filas con
 * stock_qty > 0, reporta y termina sin error.
 *
 * Uso: npm run wms:import-inventory
 */
"use strict";

require("../load-env-local");
const { Client } = require("pg");
const { poolSslOption } = require("./run-sql-file-pg");

async function main() {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) { console.error("[wms:import-inventory] DATABASE_URL no definida"); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: poolSslOption() });
  await client.connect();

  try {
    // ── Verificar que inventory existe ─────────────────────────────────────
    const { rows: tableCheck } = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'inventory'
    `);
    if (!tableCheck.length) {
      console.log("[wms:import-inventory] Tabla inventory no existe.");
      console.log("  → bin_stock inicializado en 0. Carga stock manualmente via:");
      console.log("    POST /api/wms/stock/adjust-simple  { bin_id, product_sku, delta }");
      return;
    }

    // ── Contar filas con stock positivo ───────────────────────────────────
    const { rows: countRows } = await client.query(`
      SELECT COUNT(*)::bigint AS n
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE i.stock_qty > 0 AND p.sku IS NOT NULL
    `);
    const total = Number(countRows[0].n);

    if (total === 0) {
      console.log("[wms:import-inventory] inventory existe pero no tiene filas con stock_qty > 0.");
      console.log("  → bin_stock inicializado en 0. Carga stock manualmente via:");
      console.log("    POST /api/wms/stock/adjust-simple  { bin_id, product_sku, delta }");
      return;
    }

    console.log(`[wms:import-inventory] Filas con stock > 0 en inventory: ${total}`);

    // ── Migrar ────────────────────────────────────────────────────────────
    // Actualiza bin_stock.qty_available desde inventory.stock_qty.
    // Solo actualiza si ya existe la fila en bin_stock (requiere bootstrap previo).
    // No toca qty_reserved.
    const result = await client.query(`
      UPDATE bin_stock bs
      SET qty_available = i.stock_qty,
          updated_at    = NOW()
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE bs.product_sku = p.sku
        AND i.stock_qty > 0
    `);
    const updated = result.rowCount || 0;

    // ── SKUs en inventory sin fila en bin_stock ───────────────────────────
    const { rows: missing } = await client.query(`
      SELECT p.sku, i.stock_qty
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE i.stock_qty > 0
        AND p.sku IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM bin_stock bs WHERE bs.product_sku = p.sku
        )
      ORDER BY i.stock_qty DESC
      LIMIT 20
    `);

    console.log("\n[wms:import-inventory] ─────────── RESULTADO ───────────");
    console.log(`  Filas de inventory con stock > 0: ${total}`);
    console.log(`  Filas de bin_stock actualizadas:  ${updated}`);
    if (missing.length) {
      console.log(`  SKUs sin fila en bin_stock (max 20):`);
      missing.forEach((r) => console.log(`    ${r.sku}  stock=${r.stock_qty}`));
      console.log("  → Ejecutar wms:bootstrap-stock primero y repetir este script.");
    } else {
      console.log("  Todo migrado correctamente.");
    }
    console.log("[wms:import-inventory] OK");

  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[wms:import-inventory] FATAL:", e.message);
  process.exit(1);
});
