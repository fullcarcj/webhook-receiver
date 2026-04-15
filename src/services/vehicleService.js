"use strict";

const { pool } = require("../../db");

function yearRange(row) {
  const ys = row.year_start;
  const ye = row.year_end;
  if (ye == null) return `${ys}–presente`;
  return `${ys}–${ye}`;
}

async function listBrandsWithCounts() {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.sku_prefix, COUNT(m.id)::int AS models_count
     FROM crm_vehicle_brands b
     LEFT JOIN crm_vehicle_models m ON m.brand_id = b.id
     GROUP BY b.id, b.name, b.sku_prefix
     ORDER BY b.name ASC`
  );
  return rows;
}

async function listModelsByBrand(brandId) {
  const bid = Number(brandId);
  const { rows } = await pool.query(
    `SELECT m.id, m.brand_id, m.name, COUNT(g.id)::int AS generations_count
     FROM crm_vehicle_models m
     LEFT JOIN crm_vehicle_generations g ON g.model_id = m.id
     WHERE m.brand_id = $1
     GROUP BY m.id
     ORDER BY m.name ASC`,
    [bid]
  );
  return rows;
}

async function listGenerationsByModel(modelId) {
  const mid = Number(modelId);
  const { rows } = await pool.query(
    `SELECT * FROM crm_vehicle_generations WHERE model_id = $1 ORDER BY year_start DESC`,
    [mid]
  );
  return rows.map((r) => ({
    ...r,
    year_range: yearRange(r),
  }));
}

/**
 * Búsqueda de compatibilidades por año/motor opcional.
 * @param {{ brandId?: number|null, modelId?: number|null, year: number, engine?: string|null }}
 */
async function searchCompatibility({ brandId, modelId, year, engine }) {
  const y = Number(year);
  const eng = engine != null && String(engine).trim() !== "" ? String(engine).trim() : null;
  const bid = brandId != null ? Number(brandId) : null;
  const mid = modelId != null ? Number(modelId) : null;

  const { rows } = await pool.query(
    `SELECT
       vg.id            AS generation_id,
       b.name           AS brand,
       mo.name          AS model,
       vg.year_start,
       vg.year_end,
       vg.engine_info,
       vg.body_type,
       pc.sku,
       pc.part_name,
       pc.notes         AS compatibility_notes
     FROM crm_vehicle_generations vg
     JOIN crm_vehicle_models mo       ON mo.id = vg.model_id
     JOIN crm_vehicle_brands b        ON b.id  = mo.brand_id
     LEFT JOIN product_compatibility pc ON pc.generation_id = vg.id
     WHERE ($1::bigint IS NULL OR mo.brand_id = $1)
       AND ($2::bigint IS NULL OR vg.model_id = $2)
       AND vg.year_start <= $3::int
       AND (vg.year_end IS NULL OR vg.year_end >= $3::int)
       AND ($4::text IS NULL OR vg.engine_info ILIKE '%' || $4 || '%')
     ORDER BY b.name, mo.name, vg.year_start, pc.sku NULLS LAST`,
    [bid, mid, y, eng]
  );

  const byGen = new Map();
  for (const r of rows) {
    const gid = r.generation_id;
    if (!byGen.has(gid)) {
      byGen.set(gid, {
        generation_id: gid,
        brand: r.brand,
        model: r.model,
        year_start: r.year_start,
        year_end: r.year_end,
        engine_info: r.engine_info,
        compatible_parts: [],
      });
    }
    if (r.sku) {
      byGen.get(gid).compatible_parts.push({
        sku: r.sku,
        part_name: r.part_name,
        notes: r.compatibility_notes,
      });
    }
  }

  const generations = Array.from(byGen.values());
  const totalParts = rows.filter((x) => x.sku).length;
  return { generations, total_parts: totalParts };
}

async function insertCompatibility({ generationId, sku, partName, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO product_compatibility (generation_id, sku, part_name, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [generationId, sku, partName, notes ?? null]
  );
  return rows[0];
}

module.exports = {
  listBrandsWithCounts,
  listModelsByBrand,
  listGenerationsByModel,
  searchCompatibility,
  insertCompatibility,
  yearRange,
};
