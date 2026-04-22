#!/usr/bin/env node
/**
 * Importa precios de venta en USD desde un CSV exportado de FileMaker.
 *
 * Flujo:
 *   CSV (sku_old + price_usd)  →  UPDATE products SET unit_price_usd = $price
 *   WHERE sku_old = $sku_old
 *
 * Convenciones del proyecto:
 *   - unit_price_usd = precio de venta en USD  (lo que se lleva a cotización)
 *   - precio_usd     = costo de compra         (no se toca aquí)
 *
 * Precio en Bs en cotización:
 *   price_bs = ROUND(unit_price_usd × binance_rate, 2)
 *   (La tasa Binance se toma de daily_exchange_rates al momento de la cotización.)
 *
 * Uso:
 *   node scripts/import-fm-prices-csv.js --file=data/precios-fm.csv [opciones]
 *
 * Opciones:
 *   --file=PATH           Ruta al CSV (default: data/precio_ventas.csv)
 *   --no-header           CSV sin fila de cabecera: col 0 = sku_old, col 1 = price_usd
 *                         (si omitís esta flag y el CSV no tiene cabecera real, el script
 *                         intenta detectarlo y reparsar solo — mismo formato que FM.)
 *   --col-sku=NOMBRE      Nombre de la columna sku_old en el CSV (default: sku_old)
 *   --col-price=NOMBRE    Nombre de la columna precio USD en el CSV (default: price_usd)
 *   --sep=SEPARADOR       Separador del CSV: "comma" o "semicolon" (default: comma)
 *   --dec=SEPARADOR       Separador decimal en el precio: "comma" o "dot" (default: comma)
 *   --company-id=N        company_id de los productos a actualizar (default: 1)
 *   --allow-zero          Si se incluye, acepta precios == 0 (se omiten por defecto)
 *   --overwrite           Si se incluye, sobreescribe precios ya existentes (por defecto solo rellena NULL)
 *   --dry-run             Muestra cambios pero NO escribe en BD
 *   --limit=N             Procesar solo las primeras N filas del CSV (para pruebas)
 *
 * Columnas CSV aceptadas (cualquier capitalización, con o sin BOM):
 *   sku_old, SKU_OLD, SkuOld, sku-old, sku_viejo, cod_producto ...
 *   price_usd, PRICE_USD, precio_usd, precio_venta, precio, unit_price_usd, precioventa ...
 *
 * El script:
 *   1. Crea índice idx_products_sku_old si no existe.
 *   2. Lee y valida el CSV.
 *   3. En dry-run, imprime el plan sin tocar BD.
 *   4. En modo real, hace UPDATE en lotes de 100, dentro de transacción por lote.
 *   5. Al final imprime resumen: actualizados / sin cambio / no encontrados / errores.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

require("../load-env-local");
const { pool } = require("../db");

// ─── Argumentos CLI ──────────────────────────────────────────────────────────

const rawArgv = process.argv.slice(2);

const args = Object.fromEntries(
  rawArgv.map((a) => {
    const eq = a.replace(/^--/, "").indexOf("=");
    if (eq === -1) return [a.replace(/^--/, ""), true];
    const k = a.replace(/^--/, "").slice(0, eq);
    const v = a.replace(/^--/, "").slice(eq + 1);
    return [k, v];
  })
);

/** Flags sueltos (--overwrite) a veces no entran al mapa en Windows + npm; leemos argv. */
function argvHasFlag(longName, shortLetter) {
  const ln = `--${longName}`;
  const sh = shortLetter ? `-${shortLetter}` : null;
  return rawArgv.some((x) => {
    const s = String(x || "");
    if (s === ln) return true;
    if (sh && s === sh) return true;
    if (s.startsWith(`${ln}=`)) {
      const v = s.slice(ln.length + 1).toLowerCase();
      return v === "1" || v === "true" || v === "yes" || v === "on";
    }
    return false;
  });
}

const FILE        = args.file        ? path.resolve(String(args.file))        : path.join(__dirname, "..", "data", "precio_ventas.csv");
const NO_HEADER   = Boolean(args["no-header"]) || argvHasFlag("no-header", null);
const COL_SKU     = args["col-sku"]   ? String(args["col-sku"])   : null;
const COL_PRICE   = args["col-price"] ? String(args["col-price"]) : null;
const SEP         = String(args.sep || "comma").toLowerCase() === "semicolon" ? ";" : ",";
const DEC_SEP     = String(args.dec || "comma").toLowerCase() === "dot" ? "." : ",";
const COMPANY_ID  = args["company-id"] != null ? parseInt(String(args["company-id"]), 10) : 1;
const ALLOW_ZERO  = Boolean(args["allow-zero"]) || argvHasFlag("allow-zero", null);
const OVERWRITE   = Boolean(args.overwrite) || argvHasFlag("overwrite", "o");
const DRY_RUN     = Boolean(args["dry-run"]) || argvHasFlag("dry-run", null);
const LIMIT       = args.limit != null ? parseInt(String(args.limit), 10) : null;
const BATCH_SIZE  = 100;

// ─── Normalización de cabeceras ───────────────────────────────────────────────

const SKU_ALIASES = [
  "sku_old", "sku-old", "skuold", "sku_viejo", "cod_producto", "codigo_producto",
  "codigo", "referencia", "ref", "sku_original", "old_sku",
  // FileMaker: campo compuesto exportado como cabecera #id
  "#id",
];
const PRICE_ALIASES = [
  "price_usd", "precio_usd", "unit_price_usd", "precio_venta", "precioventa",
  "precio", "price", "pvp_usd", "pvp", "venta_usd", "selling_price",
];

/**
 * FileMaker a veces exporta sin fila de cabecera; csv-parse con columns:true usa la 1.ª
 * fila como nombres de columna → claves tipo "96476979_F0001_HN" y "57,99".
 */
function looksLikeDataRowMistakenAsHeaders(keys) {
  if (!Array.isArray(keys) || keys.length < 2) return false;
  const k0 = String(keys[0] ?? "").replace(/^\uFEFF/, "").trim();
  const k1 = String(keys[1] ?? "").replace(/^\uFEFF/, "").trim();
  if (!k0 || !k1) return false;
  const known = new Set(
    [...SKU_ALIASES, ...PRICE_ALIASES].map((x) => String(x).toLowerCase())
  );
  if (known.has(k0.toLowerCase()) || known.has(k1.toLowerCase())) return false;
  const idLike = k0.includes("_") && /^[A-Za-z0-9_.-]+$/.test(k0) && k0.length >= 6;
  const priceLikeKey = /^\d+([.,]\d+)?$/.test(k1);
  return idLike && priceLikeKey;
}

function pickColumn(row, aliases, override) {
  const keys = Object.keys(row);
  if (override) {
    const clean = override.replace(/^\uFEFF/, "").trim();
    const found = keys.find((k) => k.replace(/^\uFEFF/, "").trim().toLowerCase() === clean.toLowerCase());
    if (found) return found;
    console.error(`[ERROR] Columna "${override}" no encontrada en el CSV. Columnas disponibles: ${keys.join(", ")}`);
    process.exit(1);
  }
  for (const alias of aliases) {
    const found = keys.find((k) => k.replace(/^\uFEFF/, "").trim().toLowerCase() === alias.toLowerCase());
    if (found) return found;
  }
  return null;
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

function pad(s, n) { return String(s ?? "").padEnd(n).slice(0, n); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`[ERROR] Archivo no encontrado: ${FILE}`);
    console.error(`        Usa --file=ruta/al/archivo.csv`);
    process.exit(1);
  }

  // 1. Crear índice si no existe
  if (!DRY_RUN) {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_products_sku_old
        ON products (sku_old)
        WHERE sku_old IS NOT NULL
    `);
  }

  // 2. Leer CSV
  const raw = fs.readFileSync(FILE, "utf8");
  let allRows;
  let autoNoHeader = false;

  function parseAsArrays() {
    return parse(raw, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
      delimiter: SEP,
      bom: true,
      relax_column_count: true,
    }).map((r) => ({ _sku: String(r[0] ?? "").trim(), _price: String(r[1] ?? "").trim() }));
  }

  if (NO_HEADER) {
    try {
      allRows = parseAsArrays();
    } catch (e) {
      console.error("[ERROR] No se pudo parsear el CSV:", e.message);
      process.exit(1);
    }
  } else {
    try {
      allRows = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter: SEP,
        bom: true,
        relax_column_count: true,
      });
    } catch (e) {
      console.error("[ERROR] No se pudo parsear el CSV:", e.message);
      process.exit(1);
    }

    if (allRows.length) {
      const sample = allRows[0];
      const keys = Object.keys(sample);
      let skuTry = pickColumn(sample, SKU_ALIASES, COL_SKU);
      let priceTry = pickColumn(sample, PRICE_ALIASES, COL_PRICE);

      if ((!skuTry || !priceTry) && looksLikeDataRowMistakenAsHeaders(keys)) {
        console.log(
          "[INFO] CSV sin cabecera detectado (la 1.ª fila es dato, no nombres de columna). Reparseando…"
        );
        autoNoHeader = true;
        try {
          allRows = parseAsArrays();
        } catch (e) {
          console.error("[ERROR] No se pudo reparsear el CSV:", e.message);
          process.exit(1);
        }
      }
    }
  }

  if (!allRows.length) {
    console.log("[INFO] CSV vacío, nada que procesar.");
    process.exit(0);
  }

  let skuCol, priceCol;
  if (NO_HEADER || autoNoHeader) {
    skuCol   = "_sku";
    priceCol = "_price";
  } else {
    const sample = allRows[0];
    skuCol   = pickColumn(sample, SKU_ALIASES,   COL_SKU);
    priceCol = pickColumn(sample, PRICE_ALIASES, COL_PRICE);

    if (!skuCol) {
      console.error(`[ERROR] No se encontró columna de sku_old. Columnas en CSV: ${Object.keys(sample).join(", ")}`);
      console.error(`        Usa --no-header o --col-sku=NOMBRE para indicarla manualmente.`);
      process.exit(1);
    }
    if (!priceCol) {
      console.error(`[ERROR] No se encontró columna de precio USD. Columnas en CSV: ${Object.keys(sample).join(", ")}`);
      console.error(`        Usa --no-header o --col-price=NOMBRE para indicarla manualmente.`);
      process.exit(1);
    }
  }

  console.log(`[INFO] Archivo: ${FILE}`);
  console.log(
    `[INFO] Modo cabecera:  ${
      NO_HEADER || autoNoHeader
        ? "sin cabecera (col 0=sku_old / #id, col 1=precio USD)" +
          (autoNoHeader ? " [auto]" : "")
        : "con cabecera"
    }`
  );
  console.log(`[INFO] Sep. campo:     "${SEP}"   |  Sep. decimal: "${DEC_SEP}"`);
  console.log(`[INFO] Modo:           ${DRY_RUN ? "DRY-RUN (sin escritura)" : "REAL"}`);
  console.log(`[INFO] Sobreescribir precios existentes: ${OVERWRITE ? "SÍ" : "NO (solo llena NULL)"}`);
  console.log(`[INFO] Aceptar precio 0: ${ALLOW_ZERO ? "SÍ" : "NO"}`);
  console.log(`[INFO] company_id: ${COMPANY_ID}`);
  console.log("");

  // 3. Parsear y validar filas
  const valid   = [];
  const skipped = [];

  const rows = LIMIT != null && LIMIT > 0 ? allRows.slice(0, LIMIT) : allRows;

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rawSku = String(row[skuCol] ?? "").trim();
    const rawPrc = DEC_SEP === ","
      ? String(row[priceCol] ?? "").replace(",", ".").trim()
      : String(row[priceCol] ?? "").trim();
    const price  = parseFloat(rawPrc);

    if (!rawSku) {
      skipped.push({ row: i + 2, reason: "sku_old vacío" });
      continue;
    }
    if (!Number.isFinite(price)) {
      skipped.push({ row: i + 2, sku: rawSku, reason: `precio no numérico: "${rawPrc}"` });
      continue;
    }
    if (price < 0) {
      skipped.push({ row: i + 2, sku: rawSku, reason: `precio negativo: ${price}` });
      continue;
    }
    if (price === 0 && !ALLOW_ZERO) {
      skipped.push({ row: i + 2, sku: rawSku, reason: "precio == 0 (usa --allow-zero para aceptarlos)" });
      continue;
    }

    valid.push({ sku_old: rawSku, price_usd: price });
  }

  console.log(`[INFO] Filas CSV: ${rows.length} | Válidas: ${valid.length} | Omitidas: ${skipped.length}`);
  if (skipped.length > 0 && skipped.length <= 30) {
    console.log("[OMITIDAS]");
    skipped.forEach((s) => console.log(`  fila ${s.row}${s.sku ? " sku=" + s.sku : ""}: ${s.reason}`));
  } else if (skipped.length > 30) {
    console.log(`[OMITIDAS] (primeras 30 de ${skipped.length}):`);
    skipped.slice(0, 30).forEach((s) => console.log(`  fila ${s.row}${s.sku ? " sku=" + s.sku : ""}: ${s.reason}`));
  }
  console.log("");

  if (!valid.length) {
    console.log("[INFO] Sin filas válidas. Nada que procesar.");
    process.exit(0);
  }

  // 4. Dry-run: mostrar plan
  if (DRY_RUN) {
    console.log("[DRY-RUN] Primeras 20 filas que se actualizarían:");
    console.log(pad("sku_old", 30), pad("price_usd nuevo", 16));
    console.log("-".repeat(50));
    valid.slice(0, 20).forEach((r) =>
      console.log(pad(r.sku_old, 30), pad(r.price_usd.toFixed(4), 16))
    );
    if (valid.length > 20) console.log(`  ... y ${valid.length - 20} más.`);
    console.log("");
    console.log("[DRY-RUN] Para aplicar: quitar --dry-run");
    process.exit(0);
  }

  // 5. Aplicar en lotes
  const stats = {
    updated:      0,
    skipped_same: 0,
    not_found:    0,
    errors:       [],
  };

  const UPDATE_SQL = OVERWRITE
    ? `UPDATE products
         SET unit_price_usd = $1,
             precio_usd     = COALESCE(precio_usd, unit_price_usd),
             updated_at     = NOW()
       WHERE sku_old = $2
         AND company_id = $3
       RETURNING id, sku, unit_price_usd`
    : `UPDATE products
         SET unit_price_usd = $1,
             updated_at     = NOW()
       WHERE sku_old = $2
         AND company_id = $3
         AND (unit_price_usd IS NULL OR unit_price_usd = 0)
       RETURNING id, sku, unit_price_usd`;

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const item of batch) {
        let res;
        try {
          res = await client.query(UPDATE_SQL, [item.price_usd, item.sku_old, COMPANY_ID]);
        } catch (e) {
          stats.errors.push({ sku_old: item.sku_old, error: e.message });
          continue;
        }
        if (res.rowCount === 0) {
          // Verificar si existe pero ya tenía precio (modo no-overwrite)
          const chk = await client.query(
            `SELECT id, unit_price_usd FROM products WHERE sku_old = $1 AND company_id = $2 LIMIT 1`,
            [item.sku_old, COMPANY_ID]
          );
          if (chk.rows.length === 0) {
            stats.not_found += 1;
          } else {
            stats.skipped_same += 1;
          }
        } else {
          stats.updated += res.rowCount;
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`[ERROR] lote ${Math.floor(i / BATCH_SIZE) + 1}:`, e.message);
    } finally {
      client.release();
    }

    const done = Math.min(i + BATCH_SIZE, valid.length);
    process.stdout.write(`\r[PROGRESO] ${done}/${valid.length} procesadas...`);
  }

  console.log("");
  console.log("");
  console.log("═".repeat(55));
  console.log("  RESUMEN DE MIGRACIÓN DE PRECIOS FM");
  console.log("═".repeat(55));
  console.log(`  Actualizadas (unit_price_usd):  ${stats.updated}`);
  console.log(`  Ya tenían precio (sin cambio):  ${stats.skipped_same}`);
  console.log(`  No encontradas en products:     ${stats.not_found}`);
  console.log(`  Errores:                        ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.log("  Errores detalle:");
    stats.errors.slice(0, 20).forEach((e) =>
      console.log(`    sku_old=${e.sku_old}: ${e.error}`)
    );
  }
  console.log("═".repeat(55));

  if (stats.not_found > 0) {
    console.log(`\n[AVISO] ${stats.not_found} SKU del CSV no tienen coincidencia en products.sku_old.`);
    console.log("  Ejecuta este SQL para ver cuáles son:");
    console.log("  (guarda el CSV y usa el REPORTE más abajo)");
  }

  if (stats.updated > 0) {
    console.log(`\n[SIGUIENTE PASO] Verifica los precios migrados:`);
    console.log(`  SELECT p.sku, p.sku_old, p.unit_price_usd,`);
    console.log(`         ROUND(p.unit_price_usd * d.binance_rate, 2) AS price_bs_binance`);
    console.log(`  FROM products p`);
    console.log(`  CROSS JOIN LATERAL (`);
    console.log(`    SELECT binance_rate FROM daily_exchange_rates`);
    console.log(`    WHERE company_id = ${COMPANY_ID} AND rate_date <= CURRENT_DATE`);
    console.log(`      AND binance_rate IS NOT NULL ORDER BY rate_date DESC LIMIT 1`);
    console.log(`  ) d`);
    console.log(`  WHERE p.unit_price_usd IS NOT NULL`);
    console.log(`  ORDER BY p.unit_price_usd DESC LIMIT 20;`);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
}).finally(() => {
  pool.end().catch(() => {});
});
