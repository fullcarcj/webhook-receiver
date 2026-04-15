"use strict";

const { pool } = require("../../db");
const { generateMnemonicPrefix, iteratePrefixVariants } = require("../utils/mnemonicPrefix");

const TABLES = {
  category_products: { len: 2, nameCol: "category_descripcion" },
  product_subcategories: { len: 3, nameCol: "name" },
  crm_vehicle_brands: { len: 3, nameCol: "name" },
};

/**
 * Comprueba si sku_prefix existe en tabla (opcional excluir id).
 * @param {import('pg').Pool | import('pg').PoolClient} client
 */
async function skuPrefixExists(client, table, skuPrefix, excludeId = null) {
  if (!TABLES[table]) throw new Error(`Tabla no soportada: ${table}`);
  if (excludeId != null) {
    const { rows } = await client.query(
      `SELECT 1 FROM ${table} WHERE sku_prefix = $1 AND id <> $2 LIMIT 1`,
      [skuPrefix, excludeId]
    );
    return rows.length > 0;
  }
  const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE sku_prefix = $1 LIMIT 1`, [skuPrefix]);
  return rows.length > 0;
}

/**
 * A partir del nombre, genera el prefijo mnemotécnico y, si hace falta, una variación libre en BD.
 * @param {object} opts
 * @param {'category_products'|'product_subcategories'|'crm_vehicle_brands'} opts.table
 * @param {string} opts.name
 * @param {string|undefined} opts.manualPrefix — si viene del usuario, se valida y unicidad
 * @param {number|undefined} opts.excludeId — al UPDATE
 * @param {import('pg').PoolClient|undefined} opts.client — transacción externa
 */
async function resolveSkuPrefixForSave(opts) {
  const { table, name, manualPrefix, excludeId, client } = opts;
  const cfg = TABLES[table];
  if (!cfg) throw new Error(`Tabla no soportada: ${table}`);

  const len = cfg.len;
  const exec = client || pool;

  const normalizeManual = (p) =>
    String(p || "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, len);

  if (manualPrefix != null && String(manualPrefix).trim() !== "") {
    const p = normalizeManual(manualPrefix);
    if (p.length !== len || !/^[A-Z]+$/.test(p)) {
      const e = new Error(`sku_prefix debe ser exactamente ${len} letras A-Z`);
      e.code = "INVALID_SKU_PREFIX_FORMAT";
      throw e;
    }
    const taken = await skuPrefixExists(exec, table, p, excludeId ?? null);
    if (taken) {
      let alt = null;
      for (const c of iteratePrefixVariants(p, len, 400)) {
        const exists = await skuPrefixExists(exec, table, c, excludeId ?? null);
        if (!exists) {
          alt = c;
          break;
        }
      }
      const err = new Error(`El prefijo ${p} ya existe en ${table}`);
      err.code = "SKU_PREFIX_CONFLICT";
      err.suggested_prefix = alt;
      throw err;
    }
    return {
      sku_prefix: p,
      source: "manual",
      suggested_mnemonic: generateMnemonicPrefix(name, len),
    };
  }

  const base = generateMnemonicPrefix(name, len);
  const alternatives = [];
  for (const candidate of iteratePrefixVariants(base, len, 300)) {
    alternatives.push(candidate);
    const taken = await skuPrefixExists(exec, table, candidate, excludeId ?? null);
    if (!taken) {
      return {
        sku_prefix: candidate,
        source: candidate === base ? "mnemonic" : "mnemonic_variant",
        suggested_mnemonic: base,
        tried_variants: alternatives.length > 1 ? alternatives.slice(0, 10) : undefined,
      };
    }
  }
  const e = new Error("No se pudo obtener un prefijo único; amplía manualmente sku_prefix");
  e.code = "SKU_PREFIX_EXHAUSTED";
  throw e;
}

module.exports = {
  resolveSkuPrefixForSave,
  skuPrefixExists,
  TABLES,
};
