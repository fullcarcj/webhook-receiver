'use strict';

/**
 * Ferrari ERP — Catálogo técnico: compatibilidad motor N:N + valve specs.
 *
 * Módulo nuevo (admin CRUD + bulk import). El módulo legacy de búsqueda
 * pública está en catalogMotorService.js (sirve /api/v1/catalog/compat/*).
 * Este módulo sirve /api/catalog/* (admin + público sin auth).
 */

const { pool } = require('../../db-postgres');

const VALID_BODY_TYPES  = ['SEDAN', 'SUV', 'PICKUP', 'VAN', 'HATCHBACK'];
const VALID_POSITIONS   = ['INLET', 'EXHAUST', 'BOTH', 'INTAKE']; // INTAKE = legacy alias
const VALID_FUEL_TYPES  = ['GASOLINE', 'DIESEL', 'HYBRID'];

// ──────────────────────────────────────────────────────────────────────────────
// vehicle_makes
// ──────────────────────────────────────────────────────────────────────────────
async function listMakes() {
  const { rows } = await pool.query(
    `SELECT * FROM vehicle_makes WHERE is_active = TRUE ORDER BY name ASC`
  );
  return rows;
}

async function createMake({ name, country }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO vehicle_makes (name, country)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET
       country   = EXCLUDED.country,
       is_active = TRUE
     RETURNING *`,
    [name, country || null]
  );
  return row;
}

// ──────────────────────────────────────────────────────────────────────────────
// vehicle_models
// ──────────────────────────────────────────────────────────────────────────────
async function listModels({ makeId } = {}) {
  const conds  = ['vm.is_active = TRUE'];
  const params = [];
  if (makeId) {
    params.push(makeId);
    conds.push(`vm.make_id = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const { rows } = await pool.query(
    `SELECT vm.*, vma.name AS make_name
     FROM vehicle_models vm
     JOIN vehicle_makes vma ON vma.id = vm.make_id
     WHERE ${where}
     ORDER BY vma.name, vm.name`,
    params
  );
  return rows;
}

async function createModel({ makeId, name, bodyType }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO vehicle_models (make_id, name, body_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (make_id, name) DO UPDATE SET
       body_type = EXCLUDED.body_type,
       is_active = TRUE
     RETURNING *`,
    [makeId, name, bodyType || null]
  );
  return row;
}

// ──────────────────────────────────────────────────────────────────────────────
// engines
// ──────────────────────────────────────────────────────────────────────────────
async function listEngines({ makeId, modelId, year } = {}) {
  const hasFilter = makeId || modelId || year;
  if (!hasFilter) {
    const { rows } = await pool.query(
      `SELECT * FROM engines WHERE is_active = TRUE ORDER BY engine_code`
    );
    return rows;
  }
  const conds  = ['e.is_active = TRUE'];
  const params = [];
  if (makeId) {
    params.push(makeId);
    conds.push(`vm.make_id = $${params.length}`);
  }
  if (modelId) {
    params.push(modelId);
    conds.push(`emy.model_id = $${params.length}`);
  }
  if (year) {
    params.push(year);
    conds.push(`emy.year_from <= $${params.length}`);
    params.push(year);
    conds.push(`emy.year_to >= $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT e.*
     FROM engines e
     JOIN engine_model_years emy ON emy.engine_id = e.id
     JOIN vehicle_models vm ON vm.id = emy.model_id
     WHERE ${conds.join(' AND ')}
     ORDER BY e.engine_code`,
    params
  );
  return rows;
}

async function createEngine({ engineCode, displacementCc, cylinders, fuelType, valveConfig, notes }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO engines
       (engine_code, displacement_cc, cylinders, fuel_type, valve_config, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (engine_code) DO UPDATE SET
       displacement_cc = COALESCE(EXCLUDED.displacement_cc, engines.displacement_cc),
       cylinders       = COALESCE(EXCLUDED.cylinders, engines.cylinders),
       fuel_type       = COALESCE(EXCLUDED.fuel_type, engines.fuel_type),
       valve_config    = COALESCE(EXCLUDED.valve_config, engines.valve_config)
     RETURNING *`,
    [
      engineCode,
      displacementCc || null,
      cylinders      || null,
      fuelType       || 'GASOLINE',
      valveConfig    || null,
      notes          || null,
    ]
  );
  return row;
}

async function linkEngineToModel({ modelId, engineId, yearFrom, yearTo, notes }) {
  const { rows, rowCount } = await pool.query(
    `INSERT INTO engine_model_years
       (model_id, engine_id, year_from, year_to, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (model_id, engine_id, year_from, year_to) DO NOTHING
     RETURNING *`,
    [modelId, engineId, yearFrom, yearTo, notes || null]
  );
  if (rowCount === 0) {
    // Ya existía — retornar la existente
    const { rows: [existing] } = await pool.query(
      `SELECT * FROM engine_model_years
       WHERE model_id = $1 AND engine_id = $2
         AND year_from = $3 AND year_to = $4`,
      [modelId, engineId, yearFrom, yearTo]
    );
    return existing;
  }
  return rows[0];
}

// ──────────────────────────────────────────────────────────────────────────────
// motor_compatibility
// ──────────────────────────────────────────────────────────────────────────────
async function addCompatibility({ productSku, engineId, position, notes }) {
  // Validar SKU
  const { rows: [skuRow] } = await pool.query(
    `SELECT sku FROM products WHERE sku = $1`, [productSku]
  );
  if (!skuRow) {
    const err = new Error(`SKU ${productSku} no existe en products`);
    err.code   = 'SKU_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  // Validar engine
  const { rows: [engRow] } = await pool.query(
    `SELECT id FROM engines WHERE id = $1`, [engineId]
  );
  if (!engRow) {
    const err = new Error(`Motor ${engineId} no existe`);
    err.code   = 'ENGINE_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const pos = position || null;
  const { rows: [row] } = await pool.query(
    `INSERT INTO motor_compatibility (product_sku, engine_id, position, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_sku, engine_id, position)
     DO UPDATE SET is_active = TRUE, updated_at = now()
     RETURNING *`,
    [productSku, engineId, pos, notes || null]
  );
  return row;
}

async function removeCompatibility({ productSku, engineId, position }) {
  let query, params;
  if (position === null || position === undefined) {
    query  = `UPDATE motor_compatibility SET is_active=FALSE, updated_at=now()
              WHERE product_sku=$1 AND engine_id=$2 AND position IS NULL`;
    params = [productSku, engineId];
  } else {
    query  = `UPDATE motor_compatibility SET is_active=FALSE, updated_at=now()
              WHERE product_sku=$1 AND engine_id=$2 AND position=$3`;
    params = [productSku, engineId, position];
  }
  const { rowCount } = await pool.query(query, params);
  return { removed: rowCount };
}

async function listCompatibilitiesByProduct(productSku) {
  const { rows } = await pool.query(
    `SELECT mc.*,
            e.engine_code, e.displacement_cc, e.cylinders, e.fuel_type,
            ARRAY_AGG(DISTINCT vma.name) FILTER (WHERE vma.name IS NOT NULL) AS makes,
            ARRAY_AGG(DISTINCT vm.name)  FILTER (WHERE vm.name  IS NOT NULL) AS models,
            MIN(emy.year_from)           AS year_from,
            MAX(emy.year_to)             AS year_to
     FROM motor_compatibility mc
     JOIN engines e ON e.id = mc.engine_id
     LEFT JOIN engine_model_years emy ON emy.engine_id = e.id
     LEFT JOIN vehicle_models vm  ON vm.id  = emy.model_id
     LEFT JOIN vehicle_makes  vma ON vma.id = vm.make_id
     WHERE mc.product_sku = $1 AND mc.is_active = TRUE
     GROUP BY mc.id, e.id
     ORDER BY e.engine_code`,
    [productSku]
  );
  return rows;
}

async function searchByVehicle({ makeId, modelId, year, engineCode, position } = {}) {
  const conds  = ['is_active = TRUE'];
  const params = [];

  if (makeId) {
    params.push(makeId);
    conds.push(`make_id = $${params.length}`);
  }
  if (modelId) {
    params.push(modelId);
    conds.push(`model_id = $${params.length}`);
  }
  if (year) {
    params.push(year);
    conds.push(`year_from <= $${params.length}`);
    params.push(year);
    conds.push(`year_to >= $${params.length}`);
  }
  if (engineCode) {
    params.push(`%${engineCode}%`);
    conds.push(`engine_code ILIKE $${params.length}`);
  }
  if (position) {
    params.push(position);
    // INLET/INTAKE unificados; BOTH aplica a todos
    conds.push(`(position = $${params.length} OR position = 'BOTH' OR position IS NULL)`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM v_catalog_compatibility
     WHERE ${conds.join(' AND ')}
     ORDER BY make_name, model_name, year_from`,
    params
  );
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────────
// valve_specs
// ──────────────────────────────────────────────────────────────────────────────
async function setValveSpecs({
  productSku, headDiameterMm, stemDiameterMm, overallLengthMm,
  material, stemMaterial, faceAngleDeg, marginMm,
}) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO valve_specs
       (product_sku, head_diameter_mm, stem_diameter_mm, overall_length_mm,
        material, stem_material, face_angle_deg, margin_mm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (product_sku) DO UPDATE SET
       head_diameter_mm  = EXCLUDED.head_diameter_mm,
       stem_diameter_mm  = EXCLUDED.stem_diameter_mm,
       overall_length_mm = EXCLUDED.overall_length_mm,
       material          = EXCLUDED.material,
       stem_material     = EXCLUDED.stem_material,
       face_angle_deg    = EXCLUDED.face_angle_deg,
       margin_mm         = EXCLUDED.margin_mm,
       updated_at        = now()
     RETURNING *`,
    [
      productSku, headDiameterMm, stemDiameterMm, overallLengthMm,
      material || null, stemMaterial || null,
      faceAngleDeg !== undefined ? faceAngleDeg : 45,
      marginMm || null,
    ]
  );
  return row;
}

async function getValveSpecs(productSku) {
  const { rows: [row] } = await pool.query(
    `SELECT * FROM valve_specs WHERE product_sku = $1`, [productSku]
  );
  return row || null;
}

async function findValveEquivalences({ productSku, toleranceMm = 0.5 }) {
  const tol = Number(toleranceMm) || 0.5;
  const { rows } = await pool.query(
    `SELECT * FROM v_valve_equivalences
     WHERE sku_original = $1
       AND diff_head_mm   <= $2
       AND diff_stem_mm   <= $2
       AND diff_length_mm <= $2
     ORDER BY (diff_head_mm + diff_stem_mm + diff_length_mm)`,
    [productSku, tol]
  );
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────────
// bulkImport — importación masiva desde JSON (convertido desde Excel)
// Idempotente: ON CONFLICT DO NOTHING / DO UPDATE en todos los pasos.
// NUNCA lanza excepción. Errores por fila → errors[].
// ──────────────────────────────────────────────────────────────────────────────
async function bulkImport(rows) {
  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // 1. Validar product_sku
      const sku = row.product_sku ? String(row.product_sku).trim() : null;
      if (!sku) {
        skipped++;
        errors.push({ row, reason: 'product_sku es obligatorio' });
        continue;
      }
      const { rows: [skuCheck] } = await pool.query(
        `SELECT sku FROM products WHERE sku = $1`, [sku]
      );
      if (!skuCheck) {
        skipped++;
        errors.push({ row, reason: `SKU ${sku} no existe en products` });
        continue;
      }

      // 2. Validar años
      const yearFrom = Number(row.year_from);
      const yearTo   = Number(row.year_to);
      if (!Number.isFinite(yearFrom) || !Number.isFinite(yearTo) ||
          yearFrom < 1950 || yearTo > 2050 || yearTo < yearFrom) {
        skipped++;
        errors.push({ row, reason: `year_from/year_to inválidos: ${row.year_from}–${row.year_to}` });
        continue;
      }

      // 3. Upsert vehicle_make
      const { rows: [make] } = await pool.query(
        `INSERT INTO vehicle_makes (name, country)
         VALUES ($1, NULL)
         ON CONFLICT (name) DO UPDATE SET is_active = TRUE
         RETURNING id`,
        [String(row.make).trim()]
      );

      // 4. Upsert vehicle_model
      const bodyType = row.body_type && VALID_BODY_TYPES.includes(String(row.body_type).toUpperCase())
        ? String(row.body_type).toUpperCase() : 'SEDAN';
      const { rows: [model] } = await pool.query(
        `INSERT INTO vehicle_models (make_id, name, body_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (make_id, name) DO UPDATE SET
           body_type = EXCLUDED.body_type,
           is_active = TRUE
         RETURNING id`,
        [make.id, String(row.model).trim(), bodyType]
      );

      // 5. Upsert engine por engine_code (constraint uq_engine_code)
      const fuelType   = row.fuel_type && VALID_FUEL_TYPES.includes(String(row.fuel_type).toUpperCase())
        ? String(row.fuel_type).toUpperCase() : 'GASOLINE';
      const engineCode = String(row.engine_code || '').trim();
      if (!engineCode) {
        skipped++;
        errors.push({ row, reason: 'engine_code es obligatorio' });
        continue;
      }
      let engineId;
      const { rows: [existingEngine] } = await pool.query(
        `SELECT id FROM engines WHERE engine_code = $1 LIMIT 1`,
        [engineCode]
      );
      if (existingEngine) {
        engineId = existingEngine.id;
      } else {
        const { rows: [newEngine] } = await pool.query(
          `INSERT INTO engines
             (engine_code, displacement_cc, cylinders, fuel_type, valve_config)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (engine_code) DO UPDATE SET
             displacement_cc = COALESCE(EXCLUDED.displacement_cc, engines.displacement_cc),
             cylinders       = COALESCE(EXCLUDED.cylinders, engines.cylinders),
             valve_config    = COALESCE(EXCLUDED.valve_config, engines.valve_config)
           RETURNING id`,
          [
            engineCode,
            row.displacement_cc ? +row.displacement_cc : null,
            row.cylinders       ? +row.cylinders       : null,
            fuelType,
            row.valve_config    ? String(row.valve_config).trim() : null,
          ]
        );
        if (newEngine) {
          engineId = newEngine.id;
        } else {
          const { rows: [fallback] } = await pool.query(
            `SELECT id FROM engines WHERE engine_code = $1 ORDER BY id LIMIT 1`,
            [engineCode]
          );
          engineId = fallback ? fallback.id : null;
        }
      }
      if (!engineId) {
        skipped++;
        errors.push({ row, reason: `No se pudo crear/encontrar motor ${engineCode}` });
        continue;
      }

      // 6. Upsert engine_model_years
      await pool.query(
        `INSERT INTO engine_model_years
           (model_id, engine_id, year_from, year_to)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (model_id, engine_id, year_from, year_to) DO NOTHING`,
        [model.id, engineId, yearFrom, yearTo]
      );

      // 7. Upsert motor_compatibility
      const pos = row.position ? String(row.position).trim().toUpperCase() : null;
      await pool.query(
        `INSERT INTO motor_compatibility
           (product_sku, engine_id, position, notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_sku, engine_id, position)
         DO UPDATE SET is_active = TRUE, updated_at = now()`,
        [sku, engineId, pos, row.notes || null]
      );

      imported++;
    } catch (err) {
      skipped++;
      errors.push({ row, reason: err.message });
    }
  }

  return { imported, skipped, errors };
}

// ──────────────────────────────────────────────────────────────────────────────
// searchByText — búsqueda libre usando índices GIN pg_trgm
// Busca en descripción, SKU, engine_code, make name, model name.
// Requiere sql/search-indexes.sql ejecutado (sin él funciona pero con Seq Scan).
// ──────────────────────────────────────────────────────────────────────────────
async function searchByText({ q, limit = 20 } = {}) {
  const term = String(q || '').trim();
  const lim  = Math.min(Number(limit) || 20, 100);

  const { rows } = await pool.query(
    `SELECT DISTINCT
       mc.product_sku,
       p.descripcion,
       p.precio_usd,
       p.landed_cost_usd,
       e.engine_code,
       e.displacement_cc,
       vma.name  AS make_name,
       vm.name   AS model_name,
       emy.year_from,
       emy.year_to,
       COALESCE((
         SELECT SUM(bs.qty_available)
         FROM bin_stock bs
         WHERE bs.product_sku = mc.product_sku
       ), 0) AS total_stock
     FROM motor_compatibility mc
     JOIN products              p   ON p.sku    = mc.product_sku
     JOIN engines               e   ON e.id     = mc.engine_id
     LEFT JOIN engine_model_years emy ON emy.engine_id = e.id
     LEFT JOIN vehicle_models   vm  ON vm.id    = emy.model_id
     LEFT JOIN vehicle_makes    vma ON vma.id   = vm.make_id
     WHERE mc.is_active = TRUE
       AND (
         p.descripcion ILIKE '%' || $1 || '%'
         OR p.sku         ILIKE '%' || $1 || '%'
         OR e.engine_code ILIKE '%' || $1 || '%'
         OR vma.name      ILIKE '%' || $1 || '%'
         OR vm.name       ILIKE '%' || $1 || '%'
       )
     ORDER BY
       CASE WHEN p.sku ILIKE $1 THEN 0 ELSE 1 END,
       p.descripcion
     LIMIT $2`,
    [term, lim]
  );
  return rows;
}

module.exports = {
  listMakes,
  createMake,
  listModels,
  createModel,
  listEngines,
  createEngine,
  linkEngineToModel,
  addCompatibility,
  removeCompatibility,
  listCompatibilitiesByProduct,
  searchByVehicle,
  searchByText,
  setValveSpecs,
  getValveSpecs,
  findValveEquivalences,
  bulkImport,
};
