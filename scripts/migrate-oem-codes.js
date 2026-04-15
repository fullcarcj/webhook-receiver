#!/usr/bin/env node
/**
 * Rellena product_oem_codes desde products.sku_old (prefijo antes del primer '_').
 *
 * Requiere: npm run db:product-oem-codes
 *
 * Uso:
 *   node scripts/migrate-oem-codes.js --dry-run
 *   node scripts/migrate-oem-codes.js
 *   node scripts/migrate-oem-codes.js --batch-size=200
 */
"use strict";

require("../load-env-local");
const { pool } = require("../db");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);
const DRY_RUN = Boolean(args["dry-run"]);
const BATCH_RAW = args["batch-size"] != null ? Number(args["batch-size"]) : 200;
const BATCH_SIZE = Math.max(25, Math.min(2000, Number.isFinite(BATCH_RAW) ? Math.floor(BATCH_RAW) : 200));

/**
 * Prefijo = todo antes del primer '_'.
 * @returns {string|null}
 */
function extractPrefix(skuOld) {
  const s = String(skuOld ?? "").trim();
  if (!s) return null;
  const idx = s.indexOf("_");
  if (idx <= 0) return null;
  const prefix = s.slice(0, idx).trim();
  return prefix.length ? prefix : null;
}

/**
 * Uppercase; si el último carácter es A-F, quitarlo; luego solo [A-Za-z0-9].
 * @returns {string|null}
 */
function normalizeOem(oemOriginal) {
  let s = String(oemOriginal).trim().toUpperCase();
  if (!s) return null;
  const last = s[s.length - 1];
  if (s.length >= 2 && /^[A-F]$/.test(last)) {
    s = s.slice(0, -1);
  }
  s = s.replace(/[^A-Z0-9]/g, "");
  return s.length ? s : null;
}

async function main() {
  console.log(`\nmigrate-oem-codes  ${DRY_RUN ? "(dry-run)" : "(aplicar)"}`);
  console.log(`  batch-size: ${BATCH_SIZE}\n`);

  const { rows } = await pool.query(`
    SELECT id, sku_old
    FROM products
    WHERE sku_old IS NOT NULL AND btrim(sku_old::text) <> ''
    ORDER BY id ASC
  `);

  console.log(`  Candidatos (sku_old no vacío): ${rows.length}\n`);

  let sumInserted = 0;
  let sumConflict = 0;
  let sumParseError = 0;

  const batches = Math.ceil(rows.length / BATCH_SIZE) || 0;

  for (let b = 0; b < batches; b++) {
    const slice = rows.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const toInsert = [];
    let batchParseErr = 0;

    for (const r of slice) {
      const prefix = extractPrefix(r.sku_old);
      if (!prefix) {
        batchParseErr++;
        continue;
      }
      const oemOriginal = prefix;
      const oemNorm = normalizeOem(oemOriginal);
      if (!oemNorm) {
        batchParseErr++;
        continue;
      }
      toInsert.push({
        product_id: Number(r.id),
        oem_original: oemOriginal,
        oem_normalized: oemNorm,
      });
    }

    sumParseError += batchParseErr;

    if (toInsert.length === 0) {
      console.log(
        `  Lote ${b + 1}/${batches}: insertados=0 omitidos(conflicto)=0 errores_parse=${batchParseErr} (sin filas válidas)`
      );
      continue;
    }

    if (DRY_RUN) {
      const wouldInsert = toInsert.length;
      console.log(
        `  Lote ${b + 1}/${batches}: [dry-run] insertarían=${wouldInsert} errores_parse=${batchParseErr}`
      );
      sumInserted += wouldInsert;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      /** oem_original siempre desde `split_part(sku_old,'_',1)` en SQL (evita NULL por orden de params / driver). */
      const ids = toInsert.map((x) => x.product_id);
      const norms = toInsert.map((x) => x.oem_normalized);
      if (ids.length !== norms.length) {
        throw new Error("interno: ids y oem_normalized desalineados");
      }

      const ins = await client.query(
        `
        INSERT INTO product_oem_codes (product_id, oem_original, oem_normalized, source)
        SELECT
          u.product_id,
          NULLIF(btrim(split_part(p.sku_old::text, '_', 1)), ''),
          u.oem_norm,
          'sku_old'
        FROM unnest($1::bigint[], $2::text[]) AS u(product_id, oem_norm)
        INNER JOIN products p ON p.id = u.product_id
        WHERE NULLIF(btrim(split_part(p.sku_old::text, '_', 1)), '') IS NOT NULL
        ON CONFLICT (product_id) DO NOTHING
        RETURNING product_id
        `,
        [ids, norms]
      );

      const inserted = ins.rowCount;
      const conflict = toInsert.length - inserted;

      await client.query("COMMIT");

      sumInserted += inserted;
      sumConflict += conflict;

      console.log(
        `  Lote ${b + 1}/${batches}: insertados=${inserted} omitidos(conflicto)=${conflict} errores_parse=${batchParseErr}`
      );
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      console.error(`  Lote ${b + 1}/${batches}: ERROR`, e.message || e);
      throw e;
    } finally {
      client.release();
    }
  }

  console.log(`\n  ── RESUMEN ──`);
  if (DRY_RUN) {
    console.log(`  [dry-run] filas que se insertarían (aprox.): ${sumInserted} (sin ON CONFLICT real)`);
    console.log(`  errores_parse (sin '_' o OEM vacío tras normalizar): ${sumParseError}`);
  } else {
    console.log(`  insertados: ${sumInserted}`);
    console.log(`  omitidos (ON CONFLICT product_id): ${sumConflict}`);
    console.log(`  errores_parse: ${sumParseError}`);
  }

  if (!DRY_RUN) {
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
  } else {
    console.log(`\n  (dry-run: sin verificación JOIN product_oem_codes)\n`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
