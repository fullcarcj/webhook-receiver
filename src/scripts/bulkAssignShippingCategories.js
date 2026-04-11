"use strict";

require("../../load-env-local");

const fs = require("fs");
const { pool } = require("../../db-postgres");
const { assignCategoryToProductsLegacy, getUnassignedProducts } = require("../services/shippingService");

function parseArgs(argv) {
  let csvPath = null;
  let auto = false;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]).trim();
    if (a === "--auto") auto = true;
    if (a === "--csv" && argv[i + 1]) {
      csvPath = String(argv[i + 1]).trim();
      i++;
    }
  }
  return { csvPath, auto };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function parseCsvAssignments(txt) {
  const lines = String(txt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [skuRaw, catRaw, volRaw] = line.split(",").map((x) => String(x || "").trim());
    if (!skuRaw || !catRaw || !volRaw) {
      throw new Error(`CSV inválido: "${line}"`);
    }
    const catId = Number(catRaw);
    const vol = Number(volRaw);
    if (!Number.isFinite(catId) || catId <= 0) throw new Error(`shipping_category_id inválido: ${line}`);
    if (!Number.isFinite(vol) || vol <= 0) throw new Error(`volume_cbm inválido: ${line}`);
    out.push({ sku: skuRaw, shipping_category_id: catId, volume_cbm: vol });
  }
  return out;
}

async function loadAutoAssignments() {
  const { rows: cats } = await pool.query(
    `SELECT id, name FROM shipping_categories
     WHERE company_id = 1 AND name IN ('Válvulas', 'General') AND is_active = TRUE`
  );
  const catNames = cats.map((c) => c.name);
  const hasValv = catNames.includes("Válvulas de Motor") || catNames.includes("Válvulas");
  if (!hasValv || !catNames.includes("General")) {
    console.error("[bulk] ERROR: Faltan categorías requeridas en BD.");
    console.error('[bulk] Crear primero: "Válvulas de Motor" (o "Válvulas") y "General" globales (provider_id NULL).');
    console.error("[bulk] Categorías encontradas:", catNames.join(", ") || "ninguna");
    process.exit(1);
  }
  const valvRows = cats.filter((c) => c.name === "Válvulas de Motor" || c.name === "Válvulas");
  const genRows = cats.filter((c) => c.name === "General");
  const valvId = valvRows[0] ? Number(valvRows[0].id) : null;
  const genId = genRows[0] ? Number(genRows[0].id) : null;
  if (!valvId || !genId) {
    throw new Error('Modo --auto requiere categorías con name exacto "Válvulas" y "General"');
  }

  const { rows } = await pool.query(
    `SELECT sku, descripcion, volume_cbm
     FROM productos
     WHERE shipping_category_id IS NULL
     ORDER BY sku`
  );

  const out = [];
  for (const r of rows) {
    const desc = String(r.descripcion || "").toLowerCase();
    const sku = String(r.sku || "");
    const isValvula =
      desc.includes("valvula") || desc.includes("válvula") || sku.toUpperCase().includes("VALVE");
    out.push({
      sku,
      shipping_category_id: isValvula ? valvId : genId,
      volume_cbm: r.volume_cbm != null ? Number(r.volume_cbm) : null,
    });
  }
  return out;
}

async function run() {
  const { csvPath, auto } = parseArgs(process.argv.slice(2));
  if (!csvPath && !auto) {
    throw new Error("Uso: --csv <path> o --auto");
  }
  let assignments;
  if (csvPath) {
    const txt = fs.readFileSync(csvPath, "utf8");
    assignments = parseCsvAssignments(txt);
  } else {
    assignments = await loadAutoAssignments();
  }

  const missingVol = assignments.filter((a) => !Number.isFinite(Number(a.volume_cbm)) || Number(a.volume_cbm) <= 0);
  if (missingVol.length) {
    throw new Error(`${missingVol.length} item(s) con volume_cbm NULL/0. Abortado.`);
  }

  const batches = chunk(assignments, 100);
  let processed = 0;
  for (const b of batches) {
    await assignCategoryToProductsLegacy(b);
    processed += b.length;
    console.log(`[bulk] Procesados ${processed}/${assignments.length} SKUs...`);
  }

  const remaining = await getUnassignedProducts({ page: 1, pageSize: 1 });
  console.log(`[bulk] Sin categoría restantes: ${remaining.total}`);
  if (remaining.total > 0) process.exit(1);
  process.exit(0);
}

run().catch((e) => {
  console.error("[bulk]", e.message || e);
  process.exit(1);
});

