#!/usr/bin/env node
/**
 * bootstrap-ml-sku-mapping.js
 * Extrae el SELLER_SKU del raw_json de ml_listings y pobla:
 *   - ml_sku_mapping   (master_sku, seller_custom_field, ml_item_id, ml_user_id)
 *   - ml_item_sku_map  (company_id, ml_item_id, product_sku, is_active)
 *
 * El SELLER_SKU vive en raw_json->'attributes' como el objeto { id: 'SELLER_SKU', value_name }.
 *
 * Constraints reales (verificadas contra BD):
 *   ml_sku_mapping:   UNIQUE (master_sku, ml_user_id)  → uq_ml_sku_seller
 *   ml_item_sku_map:  UNIQUE (company_id, ml_item_id, ml_variation_id) → uq_ml_item_map
 *     (ml_variation_id NULL → se usa INSERT WHERE NOT EXISTS para evitar duplicados)
 *
 * Uso: npm run ml:bootstrap-sku-mapping
 */
"use strict";

require("../load-env-local");
const { Client } = require("pg");
const { poolSslOption } = require("./run-sql-file-pg");

const BATCH = 200;
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);

async function main() {
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) { console.error("[ml:bootstrap-sku-mapping] DATABASE_URL no definida"); process.exit(1); }

  const client = new Client({ connectionString: url, ssl: poolSslOption() });
  await client.connect();

  try {
    // ── Cargar todos los SKUs activos del catálogo ──────────────────────
    // Incluye sku_nuevo y sku_old para resolver el mapeo en ambas direcciones.
    // Los productos migraron a un nuevo formato de SKU (TD-*, MO-*, EE-*).
    // El SELLER_SKU en ML usa el formato antiguo (sku_old / sku_nuevo).
    const { rows: productRows } = await client.query(`
      SELECT sku, sku_nuevo, sku_old
      FROM products
      WHERE sku IS NOT NULL AND is_active = TRUE
    `);

    // Map: valor_alternativo → sku_maestro (products.sku)
    // Prioridad: sku exacto > sku_nuevo > sku_old > prefijos de sku_old
    const skuByAlias = new Map(); // alias → master_sku
    const productSkuSet = new Set();
    for (const r of productRows) {
      productSkuSet.add(r.sku);
      skuByAlias.set(r.sku, r.sku);
      if (r.sku_nuevo) skuByAlias.set(String(r.sku_nuevo).trim(), r.sku);
      if (r.sku_old)   skuByAlias.set(String(r.sku_old).trim(), r.sku);
    }

    // También indexar prefijos de sku_old (antes del primer _):
    // "AM0045_F0001_DX" → "AM0045" apunta al mismo master_sku
    for (const r of productRows) {
      if (r.sku_old) {
        const oldStr = String(r.sku_old).trim();
        const parts = oldStr.split("_");
        // Guardar todos los prefijos que no existan ya como alias
        for (let i = parts.length - 1; i >= 1; i--) {
          const prefix = parts.slice(0, i).join("_");
          if (!skuByAlias.has(prefix)) {
            skuByAlias.set(prefix, r.sku);
          }
        }
      }
    }

    console.log(`[ml:bootstrap-sku-mapping] SKUs en products: ${productSkuSet.size}`);
    console.log(`[ml:bootstrap-sku-mapping] Alias (sku + sku_nuevo + sku_old + prefijos): ${skuByAlias.size}`);

    // ── Leer ml_listings en lotes ──────────────────────────────────────
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM ml_listings WHERE raw_json IS NOT NULL`
    );
    const total = Number(countRows[0].n);
    console.log(`[ml:bootstrap-sku-mapping] ml_listings con raw_json: ${total}`);

    let processed = 0;
    let mapped = 0;
    let noSkuInJson = 0;
    let skuNotInProducts = 0;
    let insertedMapping = 0;
    let insertedItemMap = 0;
    let errors = 0;

    for (let offset = 0; offset < total; offset += BATCH) {
      const { rows: listings } = await client.query(`
        SELECT item_id, ml_user_id, raw_json
        FROM ml_listings
        WHERE raw_json IS NOT NULL
        ORDER BY id
        LIMIT $1 OFFSET $2
      `, [BATCH, offset]);

      for (const row of listings) {
        processed++;
        let sellerSku = null;

        try {
          const rj = typeof row.raw_json === "string"
            ? JSON.parse(row.raw_json)
            : row.raw_json;
          const attrs = Array.isArray(rj.attributes) ? rj.attributes : [];
          const skuAttr = attrs.find((a) => a.id === "SELLER_SKU");
          sellerSku = skuAttr && skuAttr.value_name ? String(skuAttr.value_name).trim() : null;
        } catch (_) {
          sellerSku = null;
        }

        if (!sellerSku) { noSkuInJson++; continue; }

        // Resolver master_sku desde el SELLER_SKU de ML usando el mapa de aliases.
        // Los productos migraron de SKU antiguo → nuevo (ej: "AM0045_F0001_DX" → "TD-MOM-JPJ-0001").
        // El SELLER_SKU en ML usa el formato antiguo con sufijos (_F0001_DX, _A0002E_OD, etc.).
        // Estrategia:
        //   1. Buscar sellerSku exacto en aliases (coincide con sku_old completo)
        //   2. Buscar prefijos del sellerSku (quitando sufijos _XXX) en aliases
        let masterSku = null;

        // Paso 1: coincidencia exacta
        if (skuByAlias.has(sellerSku)) {
          masterSku = skuByAlias.get(sellerSku);
        } else {
          // Paso 2: prefijos por longitud descendente
          const parts = sellerSku.split("_");
          for (let i = parts.length - 1; i >= 1; i--) {
            const candidate = parts.slice(0, i).join("_");
            if (skuByAlias.has(candidate)) {
              masterSku = skuByAlias.get(candidate);
              break;
            }
          }
        }

        if (!masterSku) { skuNotInProducts++; continue; }

        mapped++;
        const mlUserId = row.ml_user_id ? Number(row.ml_user_id) : null;
        const mlItemId = row.item_id;

        // ── INSERT ml_sku_mapping ─────────────────────────────────────
        // UNIQUE (master_sku, ml_user_id)
        try {
          const r = await client.query(`
            INSERT INTO ml_sku_mapping
              (master_sku, seller_custom_field, ml_item_id, ml_user_id, sync_status)
            VALUES ($1, $2, $3, $4, 'active')
            ON CONFLICT (master_sku, ml_user_id) DO UPDATE
              SET seller_custom_field = EXCLUDED.seller_custom_field,
                  ml_item_id          = EXCLUDED.ml_item_id,
                  sync_status         = 'active',
                  updated_at          = NOW()
          `, [masterSku, sellerSku, mlItemId, mlUserId]);
          if (r.rowCount) insertedMapping++;
        } catch (e) {
          console.error(`  [ml_sku_mapping] item=${mlItemId} sku=${masterSku}: ${e.message}`);
          errors++;
        }

        // ── INSERT ml_item_sku_map ─────────────────────────────────────
        // UNIQUE (company_id, ml_item_id, ml_variation_id)
        // ml_variation_id será NULL → usamos WHERE NOT EXISTS para evitar duplicados
        try {
          const r = await client.query(`
            INSERT INTO ml_item_sku_map (company_id, ml_item_id, product_sku, is_active)
            SELECT $1, $2, $3, TRUE
            WHERE NOT EXISTS (
              SELECT 1 FROM ml_item_sku_map
              WHERE company_id = $1 AND ml_item_id = $2 AND ml_variation_id IS NULL
            )
          `, [COMPANY_ID, mlItemId, masterSku]);
          if (r.rowCount) insertedItemMap++;
        } catch (e) {
          console.error(`  [ml_item_sku_map] item=${mlItemId} sku=${masterSku}: ${e.message}`);
          errors++;
        }
      }

      if (offset % 2000 === 0 && offset > 0) {
        console.log(`  ... procesados ${offset} / ${total} | mapeados=${mapped}`);
      }
    }

    console.log("\n[ml:bootstrap-sku-mapping] ─────────── RESULTADO ───────────");
    console.log(`  Total listings procesadas:        ${processed}`);
    console.log(`  Con SKU mapeado a products:       ${mapped}`);
    console.log(`  Sin SELLER_SKU en raw_json:       ${noSkuInJson}`);
    console.log(`  SKU no encontrado en products:    ${skuNotInProducts}`);
    console.log(`  Filas ml_sku_mapping insertadas:  ${insertedMapping}`);
    console.log(`  Filas ml_item_sku_map insertadas: ${insertedItemMap}`);
    if (errors) console.log(`  Errores:                          ${errors}`);
    console.log("[ml:bootstrap-sku-mapping] OK");

  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[ml:bootstrap-sku-mapping] FATAL:", e.message);
  process.exit(1);
});
