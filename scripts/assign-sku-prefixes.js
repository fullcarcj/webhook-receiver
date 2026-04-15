#!/usr/bin/env node
/**
 * Asigna sku_prefix únicos por tabla con lógica mnemotécnica (generateMnemonicPrefix).
 * Tablas: category_products (2), product_subcategories (3), crm_vehicle_brands (3).
 *
 * Uso:
 *   node scripts/assign-sku-prefixes.js [--dry-run] [--table=all|category_products|product_subcategories|crm_vehicle_brands]
 */
"use strict";

require("../load-env-local");
const { pool } = require("../db");
const { generateMnemonicPrefix, iteratePrefixVariants } = require("../src/utils/mnemonicPrefix");

function argVal(name, def) {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : def;
}

async function tableExists(name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return rows.length > 0;
}

function pickUniqueFromMnemonic(label, len, used) {
  const base = generateMnemonicPrefix(label, len);
  for (const c of iteratePrefixVariants(base, len, 500)) {
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
  throw new Error(`No hay prefijo libre para "${label}" (${len} letras)`);
}

async function assignCategoryProducts(dryRun) {
  const { rows } = await pool.query(
    `SELECT id, category_descripcion, category_ml FROM category_products ORDER BY id`
  );
  const used = new Set();
  const updates = [];
  for (const r of rows) {
    const label =
      (r.category_descripcion && String(r.category_descripcion).trim()) || r.category_ml || `CAT${r.id}`;
    const p = pickUniqueFromMnemonic(label, 2, used);
    updates.push({ id: r.id, sku_prefix: p });
  }
  if (dryRun) {
    console.log("[assign-sku-prefixes] category_products (dry-run):", updates);
    return updates.length;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of updates) {
      await client.query(`UPDATE category_products SET sku_prefix = $1 WHERE id = $2`, [u.sku_prefix, u.id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return updates.length;
}

async function assignProductSubcategories(dryRun) {
  const { rows } = await pool.query(`SELECT id, name FROM product_subcategories ORDER BY id`);
  const used = new Set();
  const updates = [];
  for (const r of rows) {
    const label = (r.name && String(r.name).trim()) || `SUB${r.id}`;
    const p = pickUniqueFromMnemonic(label, 3, used);
    updates.push({ id: r.id, sku_prefix: p });
  }
  if (dryRun) {
    console.log("[assign-sku-prefixes] product_subcategories (dry-run, primeras 25):", updates.slice(0, 25));
    console.log("[assign-sku-prefixes] total:", updates.length);
    return updates.length;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of updates) {
      await client.query(`UPDATE product_subcategories SET sku_prefix = $1 WHERE id = $2`, [u.sku_prefix, u.id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return updates.length;
}

async function assignCrmBrands(dryRun) {
  if (!(await tableExists("crm_vehicle_brands"))) {
    console.log("[assign-sku-prefixes] Omitido crm_vehicle_brands (tabla no existe).");
    return 0;
  }
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='crm_vehicle_brands' AND column_name='sku_prefix'`
  );
  if (col.rows.length === 0) {
    console.error("[assign-sku-prefixes] Falta columna sku_prefix — npm run db:sku-prefixes");
    return 0;
  }

  const { rows } = await pool.query(`SELECT id, name FROM crm_vehicle_brands ORDER BY id`);
  const used = new Set();
  const updates = [];
  for (const r of rows) {
    const label = (r.name && String(r.name).trim()) || `BRD${r.id}`;
    const p = pickUniqueFromMnemonic(label, 3, used);
    updates.push({ id: r.id, sku_prefix: p });
  }
  if (dryRun) {
    console.log("[assign-sku-prefixes] crm_vehicle_brands (dry-run):", updates);
    return updates.length;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of updates) {
      await client.query(`UPDATE crm_vehicle_brands SET sku_prefix = $1 WHERE id = $2`, [u.sku_prefix, u.id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return updates.length;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const table = argVal("table", "all");

  let n = 0;
  if (table === "all" || table === "category_products") {
    n += await assignCategoryProducts(dryRun);
  }
  if (table === "all" || table === "product_subcategories") {
    n += await assignProductSubcategories(dryRun);
  }
  if (table === "all" || table === "crm_vehicle_brands") {
    n += await assignCrmBrands(dryRun);
  }

  console.log(
    `[assign-sku-prefixes] ${dryRun ? "Simulación" : "OK"} — filas consideradas: ${n}`
  );
}

main().catch((e) => {
  console.error("[assign-sku-prefixes]", e.message);
  process.exit(1);
});
