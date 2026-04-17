#!/usr/bin/env node
/**
 * bootstrap-wms-stock.js
 * Inicializa bin_stock con qty=0 para todos los SKUs activos.
 *
 * Flujo:
 *   1. Verificar al menos 1 warehouse activo (preferentemente el default).
 *   2. Verificar que existe al menos 1 bin en ese warehouse.
 *      Si no: crear aisle DEFAULT → shelf DEFAULT → bin DEFAULT.
 *   3. Obtener el bin con mayor qty_available (o el primero del warehouse)
 *      como bin de destino para SKUs nuevos.
 *   4. INSERT INTO bin_stock (bin_id, product_sku, qty=0)
 *      ON CONFLICT (bin_id, product_sku) DO NOTHING
 *      en lotes de 500.
 *   5. Reportar totales.
 *
 * Uso: npm run wms:bootstrap-stock
 */
"use strict";

require("../load-env-local");
const { Client } = require("pg");
const { poolSslOption } = require("./run-sql-file-pg");

const BATCH = 500;

async function main() {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) { console.error("[wms:bootstrap-stock] DATABASE_URL no definida"); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: poolSslOption() });
  await client.connect();

  try {
    // ── 1. Warehouse ──────────────────────────────────────────────────────
    const { rows: whs } = await client.query(`
      SELECT id, code, name, is_default
      FROM warehouses
      WHERE is_active = TRUE
      ORDER BY is_default DESC NULLS LAST, id
      LIMIT 1
    `);
    if (!whs.length) {
      console.error("[wms:bootstrap-stock] ERROR: No hay warehouses activos.");
      console.error("  → Crea un warehouse primero con INSERT INTO warehouses ...");
      process.exit(1);
    }
    const wh = whs[0];
    const warehouseId = Number(wh.id);
    console.log(`[wms:bootstrap-stock] Usando warehouse: id=${warehouseId} code=${wh.code} name="${wh.name}"`);

    // ── 2. Buscar bin existente en ese warehouse ────────────────────────
    const { rows: existingBins } = await client.query(`
      SELECT wb.id AS bin_id, wb.bin_code
      FROM warehouse_bins wb
      JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
      JOIN warehouse_aisles wa ON wa.id = ws.aisle_id
      WHERE wa.warehouse_id = $1
      ORDER BY wb.id
      LIMIT 1
    `, [warehouseId]);

    let defaultBinId;

    if (existingBins.length) {
      defaultBinId = Number(existingBins[0].bin_id);
      console.log(`[wms:bootstrap-stock] Bin existente encontrado: id=${defaultBinId} code="${existingBins[0].bin_code || '—'}"`);
    } else {
      // ── 2b. Crear jerarquía: aisle → shelf → bin ──────────────────────
      console.log("[wms:bootstrap-stock] Sin bins en el warehouse. Creando jerarquía DEFAULT...");

      const { rows: [aisle] } = await client.query(`
        INSERT INTO warehouse_aisles (warehouse_id, aisle_code, aisle_number)
        VALUES ($1, 'A-DEFAULT', 1)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [warehouseId]);

      let aisleId;
      if (aisle) {
        aisleId = Number(aisle.id);
      } else {
        const { rows: [existingAisle] } = await client.query(
          `SELECT id FROM warehouse_aisles WHERE warehouse_id=$1 AND aisle_code='A-DEFAULT' LIMIT 1`,
          [warehouseId]
        );
        aisleId = Number(existingAisle.id);
      }
      console.log(`  → Aisle id=${aisleId}`);

      const { rows: [shelf] } = await client.query(`
        INSERT INTO warehouse_shelves (aisle_id, shelf_code, shelf_number)
        VALUES ($1, 'S-DEFAULT', 1)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [aisleId]);

      let shelfId;
      if (shelf) {
        shelfId = Number(shelf.id);
      } else {
        const { rows: [existingShelf] } = await client.query(
          `SELECT id FROM warehouse_shelves WHERE aisle_id=$1 AND shelf_code='S-DEFAULT' LIMIT 1`,
          [aisleId]
        );
        shelfId = Number(existingShelf.id);
      }
      console.log(`  → Shelf id=${shelfId}`);

      const { rows: [bin] } = await client.query(`
        INSERT INTO warehouse_bins (shelf_id, level, bin_code)
        VALUES ($1, 1, 'BIN-DEFAULT')
        RETURNING id
      `, [shelfId]);
      defaultBinId = Number(bin.id);
      console.log(`  → Bin id=${defaultBinId} code="BIN-DEFAULT"`);
    }

    // ── 3. Obtener todos los SKUs activos ─────────────────────────────────
    const { rows: skuRows } = await client.query(`
      SELECT sku FROM products
      WHERE sku IS NOT NULL AND is_active = TRUE
      ORDER BY sku
    `);
    const totalSkus = skuRows.length;
    console.log(`[wms:bootstrap-stock] SKUs activos encontrados: ${totalSkus}`);

    if (totalSkus === 0) {
      console.log("[wms:bootstrap-stock] Ningún SKU activo. Nada que insertar.");
      return;
    }

    // ── 4. Insertar en lotes ──────────────────────────────────────────────
    let inserted = 0;
    let skipped = 0;
    let errored = 0;

    for (let offset = 0; offset < totalSkus; offset += BATCH) {
      const batch = skuRows.slice(offset, offset + BATCH);
      // Construir VALUES parametrizado
      const valuePlaceholders = batch.map((_, i) => `($1, $${i + 2}::text, 0, 0)`).join(", ");
      const params = [defaultBinId, ...batch.map((r) => r.sku)];

      try {
        const result = await client.query(`
          INSERT INTO bin_stock (bin_id, product_sku, qty_available, qty_reserved)
          VALUES ${valuePlaceholders}
          ON CONFLICT (bin_id, product_sku) DO NOTHING
        `, params);
        const rows = result.rowCount || 0;
        inserted += rows;
        skipped += batch.length - rows;
      } catch (e) {
        console.error(`  [lote offset=${offset}] ERROR: ${e.message}`);
        errored += batch.length;
      }

      if (offset % 2000 === 0 && offset > 0) {
        console.log(`  ... procesados ${offset} / ${totalSkus}`);
      }
    }

    console.log("\n[wms:bootstrap-stock] ─────────── RESULTADO ───────────");
    console.log(`  Warehouse:    ${wh.name} (id=${warehouseId})`);
    console.log(`  Bin destino:  id=${defaultBinId}`);
    console.log(`  SKUs totales: ${totalSkus}`);
    console.log(`  Insertados:   ${inserted}`);
    console.log(`  Ya existían:  ${skipped}`);
    if (errored) console.log(`  Con error:    ${errored}`);
    console.log("[wms:bootstrap-stock] OK");

  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[wms:bootstrap-stock] FATAL:", e.message);
  process.exit(1);
});
