"use strict";
/**
 * Asigna SKU canónico (SS-SSS-MMM-NNNN) a productos que ya tienen identidad completa
 * (brand_id, subcategory_id, category_id) usando allocateNextSku + propagación como PATCH /identity.
 *
 * Omite filas que ya tienen SKU acorde al prefijo actual.
 * Omite filas con movimientos (misma regla que CONFLICT_PRODUCT_HAS_MOVEMENTS).
 *
 * Uso:
 *   node scripts/bulk-assign-sku-from-identity.js --dry-run
 *   node scripts/bulk-assign-sku-from-identity.js --dry-run --limit=100
 *   node scripts/bulk-assign-sku-from-identity.js --dry-run --heartbeat=50
 *   node scripts/bulk-assign-sku-from-identity.js --heartbeat-sec=15   # log cada 15s aunque no llegue el lote de filas
 *   node scripts/bulk-assign-sku-from-identity.js --min-id=751   # reanudar desde id (tras corte)
 *   node scripts/bulk-assign-sku-from-identity.js --log=./data/bulk-sku-run.jsonl   # una línea JSON por producto (qué pasó)
 *   node scripts/bulk-assign-sku-from-identity.js --ignore-movements --confirm=RIESGO   # omitir bloqueo por movimientos (solo si aceptas el riesgo)
 *   node scripts/bulk-assign-sku-from-identity.js
 *
 * Los id de producto pueden empezar en cualquier valor (p. ej. 41); el script ordena por id ASC.
 *
 * Requiere: una sola instancia; cerrar DBeaver/transacciones en products.
 */

const fs = require("fs");
const path = require("path");

require("../load-env-local");
const { pool } = require("../db");
const { allocateNextSku, getSkuPrefixParts } = require("../src/services/skuGeneratorService");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);
const DRY_RUN = Boolean(args["dry-run"]);
const LIMIT = args.limit ? parseInt(args.limit, 10) : null;
/** Cada cuántas filas imprimir (default más bajo para no “callar” 250 filas). */
const HEARTBEAT = Math.max(10, Math.min(2000, parseInt(args.heartbeat || "50", 10) || 50));
/** Además, al menos un log cada N segundos (evita pensar que se colgó entre 750 y 1000). */
const HEARTBEAT_SEC = Math.max(5, Math.min(300, parseInt(args["heartbeat-sec"] || "15", 10) || 15));
const MIN_ID =
  args["min-id"] != null && String(args["min-id"]).trim() !== ""
    ? parseInt(String(args["min-id"]), 10)
    : null;
/** Log JSONL: una línea por producto con resultado (para saber qué id ya pasó por el script). */
const LOG_FILE =
  args.log != null && String(args.log).trim() !== "" && args.log !== true
    ? path.resolve(String(args.log).trim())
    : null;
/** Omite comprobación de movimientos (misma TX que PATCH identity peligroso). Requiere --confirm=RIESGO en aplicar. */
const IGNORE_MOVEMENTS = Boolean(args["ignore-movements"]);
const CONFIRM_ARG = args.confirm != null && args.confirm !== true ? String(args.confirm).trim() : "";

const _prefixCache = new Map();
async function getCachedPrefixParts(sid, bid) {
  const key = `${sid}:${bid}`;
  if (_prefixCache.has(key)) return _prefixCache.get(key);
  const parts = await getSkuPrefixParts(sid, bid);
  _prefixCache.set(key, parts);
  return parts;
}

const PROPAGATE_TABLES = [
  ["sale_lines", "product_sku", "product_sku"],
  ["purchase_lines", "product_sku", "product_sku"],
  ["bin_stock", "product_sku", "product_sku"],
  ["stock_movements_audit", "product_sku", "product_sku"],
  ["import_shipment_lines", "product_sku", "product_sku"],
  ["landed_cost_audit", "product_sku", "product_sku"],
  ["ml_order_reservations", "producto_sku", "producto_sku"],
  ["ml_order_items", "product_sku", "product_sku"],
  ["product_lots", "producto_sku", "producto_sku"],
  ["count_lines", "product_sku", "product_sku"],
  ["motor_compatibility", "product_sku", "product_sku"],
  ["valve_specs", "product_sku", "product_sku"],
  ["ml_item_sku_map", "product_sku", "product_sku"],
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Simula el siguiente NNNN por prefijo (orden de procesamiento = orden de ids) sin escribir en BD. */
const _simNextByTriple = new Map();
async function peekSimulatedSku(sid, bid, tripleKnown) {
  const triple =
    tripleKnown || (await getCachedPrefixParts(sid, bid)).prefix;
  let next = _simNextByTriple.get(triple);
  if (next === undefined) {
    const likePattern = `${triple}-%`;
    const maxRes = await pool.query(
      `
      SELECT COALESCE(MAX(
        (regexp_match(sku, '^[A-Z]{2}-[A-Z]{3}-[A-Z]{3}-([0-9]{4})$'))[1]::int
      ), 0) AS max_n
      FROM products
      WHERE sku LIKE $1
        AND sku ~ $2
      `,
      [likePattern, "^[A-Z]{2}-[A-Z]{3}-[A-Z]{3}-[0-9]{4}$"]
    );
    next = Number(maxRes.rows[0].max_n) + 1;
  } else {
    next += 1;
  }
  if (next > 9999) throw Object.assign(new Error("SKU_COUNTER_EXHAUSTED"), { code: "SKU_COUNTER_EXHAUSTED" });
  _simNextByTriple.set(triple, next);
  return `${triple}-${String(next).padStart(4, "0")}`;
}

async function hasMovements(db, productId, sku) {
  const { rows } = await db.query(
    `SELECT EXISTS (
      SELECT 1 FROM stock_movements WHERE product_id = $1
      UNION ALL
      SELECT 1 FROM sale_lines WHERE product_sku = $2
      UNION ALL
      SELECT 1 FROM purchase_lines WHERE product_sku = $2
      UNION ALL
      SELECT 1 FROM ml_order_reservations WHERE producto_sku = $2 AND status != 'RELEASED'
      UNION ALL
      SELECT 1 FROM ml_order_items WHERE product_sku = $2 AND reservation_status != 'NO_SKU_MAP'
      UNION ALL
      SELECT 1 FROM bin_stock WHERE product_sku = $2 AND qty_available > 0
      UNION ALL
      SELECT 1 FROM product_lots WHERE producto_sku = $2 AND status != 'EXHAUSTED'
    ) AS has_movements`,
    [productId, sku]
  );
  return Boolean(rows[0] && rows[0].has_movements);
}

/**
 * Carga en memoria los IDs/SKU con movimientos (misma lógica que hasMovements).
 * Una sola pasada por tabla → evita miles de EXISTS por fila (dry-run y modo aplicar).
 */
async function buildMovementCache() {
  const [
    sm,
    sl,
    pl,
    mlr,
    mli,
    bs,
    pls,
  ] = await Promise.all([
    pool.query(`SELECT DISTINCT product_id AS pid FROM stock_movements`),
    pool.query(`SELECT DISTINCT product_sku AS sku FROM sale_lines WHERE product_sku IS NOT NULL AND btrim(product_sku) <> ''`),
    pool.query(`SELECT DISTINCT product_sku AS sku FROM purchase_lines WHERE product_sku IS NOT NULL AND btrim(product_sku) <> ''`),
    pool.query(
      `SELECT DISTINCT producto_sku AS sku FROM ml_order_reservations WHERE status != 'RELEASED' AND producto_sku IS NOT NULL AND btrim(producto_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT product_sku AS sku FROM ml_order_items WHERE reservation_status != 'NO_SKU_MAP' AND product_sku IS NOT NULL AND btrim(product_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT product_sku AS sku FROM bin_stock WHERE qty_available > 0 AND product_sku IS NOT NULL AND btrim(product_sku) <> ''`
    ),
    pool.query(
      `SELECT DISTINCT producto_sku AS sku FROM product_lots WHERE status != 'EXHAUSTED' AND producto_sku IS NOT NULL AND btrim(producto_sku) <> ''`
    ),
  ]);

  const productIdsWithStock = new Set();
  for (const r of sm.rows) {
    if (r.pid != null) productIdsWithStock.add(Number(r.pid));
  }
  const skusTouched = new Set();
  for (const r of [...sl.rows, ...pl.rows, ...mlr.rows, ...mli.rows, ...bs.rows, ...pls.rows]) {
    if (r.sku != null && String(r.sku).trim() !== "") skusTouched.add(String(r.sku).trim());
  }
  return { productIdsWithStock, skusTouched };
}

function hasMovementFromCache(productId, sku, cache) {
  if (cache.productIdsWithStock.has(Number(productId))) return true;
  const s = sku != null ? String(sku).trim() : "";
  if (s && cache.skusTouched.has(s)) return true;
  return false;
}

async function propagateSku(client, oldSku, newSku) {
  for (const [table, setCol, whereCol] of PROPAGATE_TABLES) {
    await client.query(`UPDATE ${table} SET ${setCol} = $1 WHERE ${whereCol} = $2`, [
      newSku,
      oldSku,
    ]);
  }
}

/**
 * @param {{ runId: string }} ctx
 * @returns {Promise<object>} línea de log (una por producto)
 */
async function processOne(row, stats, moveCache, ctx) {
  const { id, sku: oldSku, brand_id: bid, subcategory_id: sid } = row;

  let expectedPrefix;
  try {
    const parts = await getCachedPrefixParts(sid, bid);
    expectedPrefix = parts.prefix;
  } catch (e) {
    stats.prefixErrors++;
    stats.prefixErrorSamples.push({ id, oldSku, err: e.message });
    return {
      runId: ctx.runId,
      ts: new Date().toISOString(),
      dryRun: DRY_RUN,
      productId: id,
      status: "prefix_error",
      skuBefore: oldSku,
      message: e.message,
    };
  }

  const canonicalRe = new RegExp(`^${escapeRe(expectedPrefix)}-[0-9]{4}$`);
  if (canonicalRe.test(String(oldSku || "").trim())) {
    stats.alreadyOk++;
    return {
      runId: ctx.runId,
      ts: new Date().toISOString(),
      dryRun: DRY_RUN,
      productId: id,
      status: "already_ok",
      skuBefore: oldSku,
      skuAfter: oldSku,
      prefix: expectedPrefix,
    };
  }

  // DRY-RUN: sin BEGIN/FOR UPDATE (evita 5963 transacciones y bloqueos; solo lectura).
  if (DRY_RUN) {
    const blocked =
      IGNORE_MOVEMENTS
        ? false
        : moveCache
          ? hasMovementFromCache(id, oldSku, moveCache)
          : await hasMovements(pool, id, oldSku);
    if (blocked) {
      stats.hasMovements++;
      if (stats.movementSamples.length < 5) stats.movementSamples.push({ id, sku: oldSku });
      return {
        runId: ctx.runId,
        ts: new Date().toISOString(),
        dryRun: true,
        productId: id,
        status: "skipped_movements",
        skuBefore: oldSku,
        prefix: expectedPrefix,
      };
    }
    let newSku;
    try {
      newSku = await peekSimulatedSku(sid, bid, expectedPrefix);
    } catch (e) {
      stats.allocateErrors++;
      stats.allocateErrorSamples.push({ id, code: e.code, message: e.message });
      return {
        runId: ctx.runId,
        ts: new Date().toISOString(),
        dryRun: true,
        productId: id,
        status: "allocate_error",
        skuBefore: oldSku,
        prefix: expectedPrefix,
        code: e.code,
        message: e.message,
      };
    }
    stats.wouldAssign++;
    if (stats.wouldAssignSamples.length < 30) {
      stats.wouldAssignSamples.push({ id, oldSku, newSku });
    }
    return {
      runId: ctx.runId,
      ts: new Date().toISOString(),
      dryRun: true,
      productId: id,
      status: "would_assign",
      skuBefore: oldSku,
      skuAfter: newSku,
      prefix: expectedPrefix,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '60s'`);
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    const { rows: lockRows } = await client.query(
      `SELECT id, sku, brand_id, subcategory_id, category_id
       FROM products WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!lockRows.length) {
      await client.query("ROLLBACK");
      stats.notFound++;
      return {
        runId: ctx.runId,
        ts: new Date().toISOString(),
        dryRun: false,
        productId: id,
        status: "not_found",
      };
    }
    const p = lockRows[0];

    const blockedByMove = IGNORE_MOVEMENTS
      ? false
      : moveCache
        ? hasMovementFromCache(p.id, p.sku, moveCache)
        : await hasMovements(client, p.id, p.sku);
    if (blockedByMove) {
      await client.query("ROLLBACK");
      stats.hasMovements++;
      if (stats.movementSamples.length < 200) stats.movementSamples.push({ id: p.id, sku: p.sku });
      return {
        runId: ctx.runId,
        ts: new Date().toISOString(),
        dryRun: false,
        productId: p.id,
        status: "skipped_movements",
        skuBefore: p.sku,
        prefix: expectedPrefix,
      };
    }

    let newSku;
    try {
      newSku = await allocateNextSku(client, p.subcategory_id, p.brand_id);
    } catch (e) {
      await client.query("ROLLBACK");
      stats.allocateErrors++;
      stats.allocateErrorSamples.push({ id, code: e.code, message: e.message });
      return {
        runId: ctx.runId,
        ts: new Date().toISOString(),
        dryRun: false,
        productId: id,
        status: "allocate_error",
        skuBefore: p.sku,
        prefix: expectedPrefix,
        code: e.code,
        message: e.message,
      };
    }

    await propagateSku(client, p.sku, newSku);
    await client.query(`UPDATE products SET sku = $1, updated_at = NOW() WHERE id = $2`, [
      newSku,
      p.id,
    ]);
    await client.query("COMMIT");
    stats.assigned++;
    if (stats.assignedSamples.length < 20) {
      stats.assignedSamples.push({ id, oldSku: p.sku, newSku });
    }
    return {
      runId: ctx.runId,
      ts: new Date().toISOString(),
      dryRun: false,
      productId: id,
      status: "assigned",
      skuBefore: p.sku,
      skuAfter: newSku,
      prefix: expectedPrefix,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    stats.fatalErrors++;
    stats.fatalSamples.push({ id, message: err.message });
    return {
      runId: ctx.runId,
      ts: new Date().toISOString(),
      dryRun: false,
      productId: id,
      status: "fatal_error",
      skuBefore: oldSku,
      message: err.message,
    };
  } finally {
    client.release();
  }
}

async function main() {
  if (IGNORE_MOVEMENTS && !DRY_RUN && CONFIRM_ARG !== "RIESGO") {
    console.error(
      "Con --ignore-movements en modo aplicar debes pasar --confirm=RIESGO (propagación de SKU con movimientos puede romper consistencia)."
    );
    process.exit(1);
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log("  bulk-assign-sku-from-identity");
  console.log(`  Modo: ${DRY_RUN ? "DRY-RUN (sin escribir SKU)" : "APLICAR"}`);
  if (IGNORE_MOVEMENTS) {
    console.log(
      `  ${!DRY_RUN ? "RIESGO: " : ""}--ignore-movements activo (no se bloquea por stock_movements / líneas / etc.)`
    );
  }
  if (LIMIT) console.log(`  Límite: ${LIMIT}`);
  if (Number.isFinite(MIN_ID) && MIN_ID > 0) console.log(`  id mínimo: ${MIN_ID} (AND id >= ${MIN_ID})`);
  console.log(`${"═".repeat(64)}\n`);

  const params = [];
  let p = 1;
  let minIdClause = "";
  if (Number.isFinite(MIN_ID) && MIN_ID > 0) {
    minIdClause = ` AND id >= $${p++}`;
    params.push(MIN_ID);
  }

  let sql = `
    SELECT id, sku, brand_id, subcategory_id, category_id
    FROM products
    WHERE brand_id IS NOT NULL
      AND subcategory_id IS NOT NULL
      AND category_id IS NOT NULL
      ${minIdClause}
    ORDER BY id ASC
  `;
  if (LIMIT && Number.isFinite(LIMIT) && LIMIT > 0) {
    sql += ` LIMIT $${p}`;
    params.push(LIMIT);
  }

  const { rows } = await pool.query(sql, params);
  console.log(`  Filas candidatas (identidad completa): ${rows.length}`);
  console.log(
    `  Progreso en consola: cada ${HEARTBEAT} filas o cada ${HEARTBEAT_SEC}s (no hay corte en 750; antes el siguiente log era en 1000).`
  );
  const runCtx = {
    runId: `bulk-sku-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
  };
  if (LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    } catch (_) {
      /* ignore */
    }
    fs.writeFileSync(
      LOG_FILE,
      JSON.stringify({
        type: "meta",
        runId: runCtx.runId,
        dryRun: DRY_RUN,
        startedAt: new Date().toISOString(),
        candidateCount: rows.length,
        argv: process.argv.slice(2),
      }) + "\n",
      "utf8"
    );
    console.log(`  Log detallado (JSONL): ${LOG_FILE}`);
  }

  let moveCache = null;
  if (DRY_RUN) {
    console.log("  (dry-run: precargando índice de movimientos en 7 consultas…)");
    const tCache = Date.now();
    moveCache = await buildMovementCache();
    console.log(
      `  → caché movimientos: ${moveCache.productIdsWithStock.size} product_id(s) con stock_movements, ` +
        `${moveCache.skusTouched.size} SKU(s) referenciados en otros tablas (${((Date.now() - tCache) / 1000).toFixed(1)}s)\n`
    );
  } else {
    console.log("  (aplicar: precargando índice de movimientos en 7 consultas — evita ~7 consultas/fila)\n");
    const tCache = Date.now();
    moveCache = await buildMovementCache();
    console.log(
      `  → caché movimientos: ${moveCache.productIdsWithStock.size} product_id(s), ` +
        `${moveCache.skusTouched.size} SKU(s) en tablas de movimiento (${((Date.now() - tCache) / 1000).toFixed(1)}s)`
    );
    console.log(
      `  Nota: filas con SKU ya canónico (ok++) son muy rápidas; cada asignación nueva (asig++) abre TX y reserva correlativo — el ETA salta al pasar de un bloque al otro.\n`
    );
  }

  const stats = {
    alreadyOk: 0,
    hasMovements: 0,
    movementSamples: [],
    prefixErrors: 0,
    prefixErrorSamples: [],
    allocateErrors: 0,
    allocateErrorSamples: [],
    wouldAssign: 0,
    wouldAssignSamples: [],
    assigned: 0,
    assignedSamples: [],
    notFound: 0,
    fatalErrors: 0,
    fatalSamples: [],
  };

  const t0 = Date.now();
  let lastLogAt = t0;
  /** Para ETA: ritmo del último intervalo entre logs (las filas "already_ok" son ~instantáneas; cada "asig" tarda mucho más). */
  let prevLogIx = 0;
  let prevLogT = t0;
  let ix = 0;
  for (const row of rows) {
    const logLine = await processOne(row, stats, moveCache, runCtx);
    if (LOG_FILE && logLine) {
      fs.appendFileSync(LOG_FILE, JSON.stringify(logLine) + "\n", "utf8");
    }
    ix++;
    const now = Date.now();
    const dueByRows = ix % HEARTBEAT === 0 || ix === rows.length;
    const dueByTime = ix < rows.length && now - lastLogAt >= HEARTBEAT_SEC * 1000;
    if (dueByRows || dueByTime) {
      lastLogAt = now;
      const sec = ((now - t0) / 1000).toFixed(1);
      const elapsedSec = (now - t0) / 1000;
      const left = rows.length - ix;
      let eta = "";
      if (ix > 0 && ix < rows.length && elapsedSec > 0.5) {
        const perSecGlobal = ix / elapsedSec;
        const dtInt = (now - prevLogT) / 1000;
        const dIxInt = ix - prevLogIx;
        if (dtInt > 0.3 && dIxInt > 0) {
          const perSecRecent = dIxInt / dtInt;
          const etaRecent = Math.ceil(left / perSecRecent);
          const etaGlobal = Math.ceil(left / perSecGlobal);
          eta = `  ETA ~${etaRecent}s (ritmo último intervalo; global ~${etaGlobal}s)`;
        } else if (perSecGlobal > 0) {
          eta = `  ETA ~${Math.ceil(left / perSecGlobal)}s`;
        }
      }
      prevLogIx = ix;
      prevLogT = now;
      console.log(
        `  … progreso ${ix}/${rows.length}  ok=${stats.alreadyOk} mover=${stats.hasMovements} ` +
          `${DRY_RUN ? `sim=${stats.wouldAssign}` : `asig=${stats.assigned}`} err=${stats.prefixErrors + stats.allocateErrors} (${sec}s)${eta}`
      );
    }
  }

  console.log(`${"─".repeat(64)}`);
  console.log("  RESUMEN");
  console.log(`${"─".repeat(64)}`);
  console.log(`  Ya tenían SKU canónico para su prefijo : ${stats.alreadyOk}`);
  console.log(`  Con movimientos (omitidos)           : ${stats.hasMovements}`);
  console.log(`  Error prefijo / catálogo             : ${stats.prefixErrors}`);
  console.log(`  Error allocateNextSku                : ${stats.allocateErrors}`);
  if (DRY_RUN) {
    console.log(`  Se asignarían (ejecutar sin --dry-run): ${stats.wouldAssign}`);
  } else {
    console.log(`  Asignados OK                         : ${stats.assigned}`);
  }
  console.log(`  Otros errores                        : ${stats.notFound + stats.fatalErrors}`);

  if (stats.movementSamples.length) {
    console.log(`\n  Muestra omitidos por movimientos (max 5):`);
    stats.movementSamples.slice(0, 5).forEach((x) => console.log(`    id=${x.id} sku=${x.sku}`));
  }
  if (stats.wouldAssignSamples.length) {
    console.log(`\n  Muestra dry-run (old → new):`);
    stats.wouldAssignSamples.forEach((x) => console.log(`    id=${x.id} ${x.oldSku} → ${x.newSku}`));
  }
  if (stats.assignedSamples.length) {
    console.log(`\n  Muestra aplicados:`);
    stats.assignedSamples.forEach((x) => console.log(`    id=${x.id} ${x.oldSku} → ${x.newSku}`));
  }
  if (stats.prefixErrorSamples.length) {
    console.log(`\n  Errores prefijo (muestra):`, stats.prefixErrorSamples.slice(0, 3));
  }
  if (stats.allocateErrorSamples.length) {
    console.log(`\n  Errores allocate (muestra):`, stats.allocateErrorSamples.slice(0, 5));
  }
  if (stats.fatalSamples.length) {
    console.log(`\n  Errores fatales (muestra):`, stats.fatalSamples.slice(0, 5));
  }

  console.log(`\n${"═".repeat(64)}\n`);

  if (LOG_FILE) {
    console.log(
      `  Cada línea del JSONL (salvo la primera, meta) incluye productId y status: already_ok, assigned, skipped_movements, would_assign (solo dry-run), prefix_error, allocate_error, not_found, fatal_error.`
    );
    console.log(`  Podés filtrar por texto "assigned" o abrir el .jsonl en el editor.\n`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
