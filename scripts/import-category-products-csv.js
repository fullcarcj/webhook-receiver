#!/usr/bin/env node
/**
 * Importa filas a category_products desde CSV (exportado desde Excel).
 *
 * Uso:
 *   node scripts/import-category-products-csv.js --file=ruta\categorias.csv
 *
 * Opciones:
 *   --delimiter=,     Separador (por defecto ,). En Excel ES a veces ;  → --delimiter=;
 *   --encoding=utf8  Por ahora solo utf8 (default)
 *   --dry-run        Solo cuenta filas válidas, no escribe en BD
 *   --skip-header=1  Omitir primera fila (default 1). Usar 0 si el CSV no tiene cabecera.
 *
 * Cabecera reconocida (fila 1, insensible a mayúsculas / espacios):
 *   category_descripcion  o  descripcion  o  nombre  o  categoria
 *   category_ml           o  ml  o  category_ml_id  (opcional; celda vacía → NULL)
 *
 * Ejemplo mínimo (con cabecera):
 *   category_descripcion,category_ml
 *   Alimento para perros,MLA1051
 *   Accesorios,
 */
"use strict";

require("../load-env-local");
const fs = require("fs");
const path = require("path");
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

function argVal(name, def) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  if (!hit) return def;
  return hit.slice(p.length);
}

function parseCsvLine(line, delimiter) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === delimiter) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function pickDescIndex(headers) {
  const keys = new Set([
    "category_descripcion",
    "descripcion",
    "descripción",
    "nombre",
    "categoria",
    "categoría",
  ]);
  for (let i = 0; i < headers.length; i++) {
    const n = normHeader(headers[i]);
    if (keys.has(n)) return i;
  }
  return 0;
}

function pickMlIndex(headers) {
  const keys = ["category_ml", "ml", "category_ml_id", "id_ml", "mercadolibre"];
  for (let i = 0; i < headers.length; i++) {
    const n = normHeader(headers[i]);
    if (keys.includes(n)) return i;
  }
  return headers.length > 1 ? 1 : -1;
}

async function main() {
  const fileArg = argVal("file", "");
  if (!fileArg) {
    console.error("Falta --file=ruta\\al\\archivo.csv");
    process.exit(1);
  }
  const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error("No existe el archivo:", filePath);
    process.exit(1);
  }

  const delimiter = argVal("delimiter", ",");
  const skipHeader = argVal("skip-header", "1") !== "0";
  const dryRun = process.argv.includes("--dry-run");

  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url && !dryRun) {
    console.error("DATABASE_URL no definida (ni dry-run).");
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    console.error("CSV vacío.");
    process.exit(1);
  }

  let start = 0;
  let descIdx = 0;
  let mlIdx = -1;

  if (skipHeader) {
    const h = parseCsvLine(lines[0], delimiter);
    descIdx = pickDescIndex(h);
    mlIdx = pickMlIndex(h);
    if (mlIdx === descIdx && h.length > 1) mlIdx = descIdx === 0 ? 1 : 0;
    start = 1;
  }

  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], delimiter);
    const desc = cells[descIdx] != null ? String(cells[descIdx]).trim() : "";
    if (!desc) continue;
    let ml = null;
    if (mlIdx >= 0 && cells[mlIdx] != null) {
      const t = String(cells[mlIdx]).trim();
      ml = t === "" ? null : t;
    }
    rows.push({ desc, ml });
  }

  console.log(`[import-category-products] Filas a insertar: ${rows.length}${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) {
    rows.slice(0, 5).forEach((r, j) => console.log(`  ${j + 1}.`, JSON.stringify(r)));
    if (rows.length > 5) console.log("  …");
    process.exit(0);
  }

  const client = new Client({
    connectionString: url,
    ssl: poolSslOption(),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
  });
  await client.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    const ins = `
      INSERT INTO category_products (category_descripcion, category_ml)
      VALUES ($1, $2)
    `;
    for (const r of rows) {
      await client.query(ins, [r.desc, r.ml]);
      inserted++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }

  console.log("[import-category-products] OK, insertadas:", inserted);
}

main().catch((e) => {
  console.error("[import-category-products]", e.message);
  if (e.detail) console.error("detail:", e.detail);
  process.exit(1);
});
