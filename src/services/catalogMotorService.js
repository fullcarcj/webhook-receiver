"use strict";

const { pool } = require("../../db");

function isSchemaMissingError(err) {
  const c = err && err.code;
  return c === "42P01" || c === "42P04";
}

function wrapSchemaError(err) {
  if (isSchemaMissingError(err)) {
    const e = new Error("catalog_motor_schema_missing");
    e.code = "CATALOG_MOTOR_SCHEMA_MISSING";
    e.cause = err;
    throw e;
  }
  throw err;
}

/**
 * Marcas (vehicle_makes).
 */
async function listVehicleMakes() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, country, created_at
       FROM vehicle_makes
       ORDER BY name`
    );
    return rows;
  } catch (err) {
    wrapSchemaError(err);
  }
}

/**
 * Modelos por nombre de marca exacto.
 */
async function listVehicleModelsByMakeName(makeName) {
  const mk = String(makeName || "").trim();
  if (!mk) return [];
  try {
    const { rows } = await pool.query(
      `SELECT vm.id, vm.make_id, vm.name, vm.body_type, vm.created_at,
              vmk.name AS make_name
       FROM vehicle_models vm
       JOIN vehicle_makes vmk ON vmk.id = vm.make_id
       WHERE vmk.name = $1
       ORDER BY vm.name`,
      [mk]
    );
    return rows;
  } catch (err) {
    wrapSchemaError(err);
  }
}

/**
 * Compatibilidades desde v_catalog_compatibility.
 * @param {{ makeName: string, modelName: string, year: number, displacementL?: number|null, limit?: number, offset?: number }} p
 */
async function searchCatalogCompatibility(p) {
  const makeName = String(p.makeName || "").trim();
  const modelName = String(p.modelName || "").trim();
  const year = Number(p.year);
  const displacementL =
    p.displacementL != null && String(p.displacementL).trim() !== ""
      ? Number(p.displacementL)
      : null;
  const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 2000);
  const offset = Math.max(Number(p.offset) || 0, 0);

  if (!makeName || !modelName || !Number.isFinite(year)) {
    const e = new Error("make_name, model_name y year son obligatorios");
    e.code = "BAD_REQUEST";
    throw e;
  }

  try {
    const hasDisp = displacementL != null && Number.isFinite(displacementL);
    const { rows } = await pool.query(
      `SELECT compat_id, producto_sku, descripcion, precio_usd, landed_cost_usd,
              position, qty_per_engine, is_oem,
              engine_id, engine_code, year_from, year_to, displacement_cc, displacement_l,
              cylinders, fuel_type, valves_per_cyl,
              model_name, make_name,
              head_diameter_mm, stem_diameter_mm, total_length_mm, seat_angle_deg,
              material, valve_type,
              stock_available, stock_reserved
       FROM v_catalog_compatibility
       WHERE make_name = $1 AND model_name = $2
         AND year_from <= $3 AND (year_to IS NULL OR year_to >= $3)
         AND ($4::numeric IS NULL OR displacement_l = $4::numeric)
       ORDER BY is_oem DESC NULLS LAST, position, precio_usd NULLS LAST
       LIMIT $5 OFFSET $6`,
      [makeName, modelName, Math.trunc(year), hasDisp ? displacementL : null, limit, offset]
    );
    return { items: rows, limit, offset };
  } catch (err) {
    wrapSchemaError(err);
  }
}

/**
 * Motores / compatibilidades para un SKU (v_catalog_compatibility).
 */
async function listCompatibilityForSku(productoSku) {
  const sku = String(productoSku || "").trim();
  if (!sku) {
    const e = new Error("sku requerido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `SELECT compat_id, producto_sku, descripcion, precio_usd, landed_cost_usd,
              position, qty_per_engine, is_oem,
              engine_id, engine_code, year_from, year_to, displacement_cc, displacement_l,
              cylinders, fuel_type, valves_per_cyl,
              model_name, make_name,
              head_diameter_mm, stem_diameter_mm, total_length_mm, seat_angle_deg,
              material, valve_type,
              stock_available, stock_reserved
       FROM v_catalog_compatibility
       WHERE producto_sku = $1
       ORDER BY make_name, model_name, year_from, position`,
      [sku]
    );
    return rows;
  } catch (err) {
    wrapSchemaError(err);
  }
}

/**
 * Equivalencias técnicas (v_valve_equivalences).
 */
async function listValveEquivalences(productoSku, options) {
  const sku = String(productoSku || "").trim();
  if (!sku) {
    const e = new Error("sku requerido");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const limit = Math.min(Math.max(Number(options && options.limit) || 25, 1), 100);
  try {
    const { rows } = await pool.query(
      `SELECT sku_original, sku_equivalente, descripcion_equivalente, precio_equivalente,
              diff_head_mm, diff_stem_mm, diff_length_mm,
              head_diameter_mm, stem_diameter_mm, total_length_mm, material,
              stock_disponible
       FROM v_valve_equivalences
       WHERE sku_original = $1
       ORDER BY
         diff_head_mm + diff_stem_mm + (diff_length_mm / 2) ASC NULLS LAST,
         stock_disponible DESC NULLS LAST
       LIMIT $2`,
      [sku, limit]
    );
    return rows;
  } catch (err) {
    wrapSchemaError(err);
  }
}

module.exports = {
  listVehicleMakes,
  listVehicleModelsByMakeName,
  searchCatalogCompatibility,
  listCompatibilityForSku,
  listValveEquivalences,
  isSchemaMissingError,
};
