"use strict";
/**
 * Importa marcas de vehículos desde CSV a crm_vehicle_brands.
 *
 * Formato del CSV: una marca por línea, sin cabecera, sin sku_prefix.
 *   Chevrolet
 *   Toyota
 *   Great Wall
 *   ...
 *
 * El script:
 *   1. Aplica toUpperCase() al nombre para normalizar formato.
 *   2. Genera sku_prefix (3 letras A-Z) automáticamente con generateMnemonicPrefix.
 *   3. Si hay conflicto de prefijo, intenta variantes deterministas.
 *   4. Inserta con ON CONFLICT (name) DO NOTHING (salta duplicados por nombre).
 *
 * Uso:
 *   node scripts/import-crm-vehicle-brands-csv.js
 *   node scripts/import-crm-vehicle-brands-csv.js --file=data/marcas_veh.csv
 *   node scripts/import-crm-vehicle-brands-csv.js --dry-run
 *   node scripts/import-crm-vehicle-brands-csv.js --upsert
 */

const fs   = require("fs");
const path = require("path");
require("../load-env-local");
const { pool } = require("../db");
const { generateMnemonicPrefix, iteratePrefixVariants } = require("../src/utils/mnemonicPrefix");

// ── Argumentos ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);

const CSV_FILE = args.file
  ? path.resolve(args.file)
  : path.join(__dirname, "..", "data", "marcas_veh.csv");

const DRY_RUN = Boolean(args["dry-run"]);
const UPSERT  = Boolean(args.upsert);

const SKU_RE = /^[A-Z]{3}$/;

// ── Leer y parsear CSV (una columna sin cabecera) ─────────────────────────────
function readNames(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

// ── Asignar prefijos MMM con resolución de conflictos ────────────────────────
function assignPrefixes(names) {
  const usedPrefixes = new Set();
  const rows = [];
  const warnings = [];

  for (const raw of names) {
    const name = raw.toUpperCase();
    const base = generateMnemonicPrefix(name, 3);

    let chosen = null;
    for (const candidate of iteratePrefixVariants(base, 3, 300)) {
      if (!usedPrefixes.has(candidate)) {
        chosen = candidate;
        break;
      }
    }

    if (!chosen) {
      warnings.push(`⚠️  Sin variante disponible para "${name}" (base: ${base}) — OMITIDA.`);
      continue;
    }

    if (chosen !== base) {
      warnings.push(`ℹ️  "${name}": prefijo base ${base} ocupado → asignado ${chosen}`);
    }

    usedPrefixes.add(chosen);
    rows.push({ name, sku_prefix: chosen });
  }

  return { rows, warnings };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"─".repeat(62)}`);
  console.log("  Import crm_vehicle_brands desde CSV (single-column)");
  console.log(`${"─".repeat(62)}`);
  console.log(`  Archivo : ${CSV_FILE}`);
  console.log(`  Modo    : ${DRY_RUN ? "DRY-RUN (sin cambios)" : UPSERT ? "UPSERT" : "INSERT (salta duplicados)"}`);
  console.log(`${"─".repeat(62)}\n`);

  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ Archivo no encontrado: ${CSV_FILE}`);
    process.exit(1);
  }

  const rawNames = readNames(CSV_FILE);
  console.log(`  Líneas con datos : ${rawNames.length}`);

  // Prefijos ya usados en BD (para no colisionar con marcas existentes)
  const existingPrefixes = await pool.query(
    `SELECT sku_prefix FROM crm_vehicle_brands WHERE sku_prefix IS NOT NULL`
  );
  const existingNames = await pool.query(
    `SELECT name FROM crm_vehicle_brands`
  );

  const dbPrefixSet = new Set(existingPrefixes.rows.map(r => r.sku_prefix));
  const dbNameSet   = new Set(existingNames.rows.map(r => r.name.toUpperCase()));

  // Separar los que ya existen en BD
  const nuevos    = rawNames.filter(n => !dbNameSet.has(n.toUpperCase()));
  const yaExisten = rawNames.filter(n =>  dbNameSet.has(n.toUpperCase()));

  if (yaExisten.length) {
    console.log(`\n  Ya existen en BD (${yaExisten.length}):`);
    yaExisten.forEach(n => console.log(`    · ${n.toUpperCase()}`));
  }

  console.log(`\n  Nuevas a insertar: ${nuevos.length}`);

  // Generar prefijos considerando los ya ocupados en BD
  const { rows, warnings } = (() => {
    const usedPrefixes = new Set(dbPrefixSet);
    const result = [];
    const warns  = [];

    for (const raw of nuevos) {
      const name = raw.toUpperCase();
      const base = generateMnemonicPrefix(name, 3);

      let chosen = null;
      for (const candidate of iteratePrefixVariants(base, 3, 300)) {
        if (!usedPrefixes.has(candidate)) {
          chosen = candidate;
          break;
        }
      }

      if (!chosen) {
        warns.push(`⚠️  Sin variante disponible para "${name}" — OMITIDA.`);
        continue;
      }

      if (chosen !== base) {
        warns.push(`ℹ️  "${name}": base ${base} ocupado → ${chosen}`);
      }

      usedPrefixes.add(chosen);
      result.push({ name, sku_prefix: chosen });
    }

    return { rows: result, warnings: warns };
  })();

  if (warnings.length) {
    console.log(`\n  Avisos de asignación de prefijos:`);
    warnings.forEach(w => console.log(`    ${w}`));
  }

  // Preview completo
  console.log(`\n  Filas a insertar (${rows.length}):`);
  rows.forEach(r => console.log(`    ${r.sku_prefix}  ${r.name}`));

  if (DRY_RUN) {
    console.log("\n  [DRY-RUN] Sin cambios en BD. Quita --dry-run para importar.\n");
    await pool.end();
    return;
  }

  if (!rows.length) {
    console.log("\n  Nada que insertar.\n");
    await pool.end();
    return;
  }

  // Insertar en transacción
  const client = await pool.connect();
  let inserted = 0;
  let skipped  = 0;
  let updated  = 0;

  try {
    await client.query("BEGIN");

    for (const r of rows) {
      if (UPSERT) {
        const res = await client.query(
          `INSERT INTO crm_vehicle_brands (name, sku_prefix)
           VALUES ($1, $2)
           ON CONFLICT (name)
             DO UPDATE SET sku_prefix = EXCLUDED.sku_prefix
           RETURNING (xmax = 0) AS was_inserted`,
          [r.name, r.sku_prefix]
        );
        if (res.rows[0].was_inserted) inserted++;
        else updated++;
      } else {
        const res = await client.query(
          `INSERT INTO crm_vehicle_brands (name, sku_prefix)
           VALUES ($1, $2)
           ON CONFLICT (name) DO NOTHING
           RETURNING id`,
          [r.name, r.sku_prefix]
        );
        if (res.rowCount) inserted++;
        else skipped++;
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n❌ Error en BD — ROLLBACK:", err.detail || err.message);
    process.exit(1);
  } finally {
    client.release();
  }

  // Resumen
  const totalRes = await pool.query("SELECT COUNT(*) AS c FROM crm_vehicle_brands");

  console.log(`\n${"─".repeat(62)}`);
  console.log("  RESULTADO");
  console.log(`${"─".repeat(62)}`);
  console.log(`  Insertadas               : ${inserted}`);
  if (UPSERT) console.log(`  Actualizadas (upsert)    : ${updated}`);
  else        console.log(`  Saltadas (ya existían)   : ${skipped}`);
  console.log(`  Total en tabla ahora     : ${totalRes.rows[0].c}`);
  console.log(`${"─".repeat(62)}\n`);

  await pool.end();
}

main().catch(e => {
  console.error("\n❌ Error inesperado:", e.message);
  process.exit(1);
});
