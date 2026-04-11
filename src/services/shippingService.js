"use strict";

const { pool } = require("../../db-postgres");

const SHIPPING_SETTING_KEYS = [
  "default_rate_basis",
  "default_volumetric_factor",
  "preferred_import_mode",
  "preferred_national_mode",
  "freight_markup_pct",
];

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

function validateRateBasis(rateBasis, ratePerCbmUsd, ratePerKgUsd, flatRateUsd) {
  const b = String(rateBasis || "").trim();
  if (!b) {
    const err = new Error("rate_basis es obligatorio");
    err.code = "INVALID_RATE_BASIS";
    err.status = 422;
    throw err;
  }
  if (b === "CBM" && (ratePerCbmUsd == null || !Number.isFinite(Number(ratePerCbmUsd)))) {
    const err = new Error("rate_per_cbm_usd es obligatorio para CBM");
    err.code = "INVALID_RATE_BASIS";
    err.status = 422;
    throw err;
  }
  if (b === "KG" && (ratePerKgUsd == null || !Number.isFinite(Number(ratePerKgUsd)))) {
    const err = new Error("rate_per_kg_usd es obligatorio para KG");
    err.code = "INVALID_RATE_BASIS";
    err.status = 422;
    throw err;
  }
  if (b === "CBM_OR_KG") {
    if (ratePerCbmUsd == null || !Number.isFinite(Number(ratePerCbmUsd))) {
      const err = new Error("rate_per_cbm_usd es obligatorio para CBM_OR_KG");
      err.code = "INVALID_RATE_BASIS";
      err.status = 422;
      throw err;
    }
    if (ratePerKgUsd == null || !Number.isFinite(Number(ratePerKgUsd))) {
      const err = new Error("rate_per_kg_usd es obligatorio para CBM_OR_KG");
      err.code = "INVALID_RATE_BASIS";
      err.status = 422;
      throw err;
    }
  }
  if (b === "FLAT" && (flatRateUsd == null || !Number.isFinite(Number(flatRateUsd)))) {
    const err = new Error("flat_rate_usd es obligatorio para FLAT");
    err.code = "INVALID_RATE_BASIS";
    err.status = 422;
    throw err;
  }
}

/**
 * @param {number} companyId
 */
async function getShippingSettings(companyId = 1) {
  const { rows } = await pool.query(
    `SELECT key, get_shipping_setting(key, $1::int) AS v
     FROM (VALUES
       ('default_rate_basis'),
       ('default_volumetric_factor'),
       ('preferred_import_mode'),
       ('preferred_national_mode'),
       ('freight_markup_pct')
     ) AS keys(key)`,
    [companyId]
  );
  const raw = {};
  for (const r of rows) raw[r.key] = r.v != null ? String(r.v) : null;

  const vf = parseFloat(raw.default_volumetric_factor || "5000");
  const mk = parseFloat(raw.freight_markup_pct || "0");

  return {
    defaultRateBasis: raw.default_rate_basis || "CBM_OR_KG",
    defaultVolumetricFactor: Number.isFinite(vf) ? vf : 5000,
    preferredImportMode: raw.preferred_import_mode || "SEA_LCL",
    preferredNationalMode: raw.preferred_national_mode || "LAND",
    freightMarkupPct: Number.isFinite(mk) ? mk : 0,
    _raw: raw,
  };
}

/**
 * @param {{ key: string, value: string, companyId?: number, updatedBy?: number|null, notes?: string|null }} p
 */
async function updateShippingSetting(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const key = String(p.key || "").trim();
  if (!key) throw Object.assign(new Error("key requerido"), { status: 400 });

  const { rows: metaRows } = await pool.query(
    `SELECT value_type, allowed_values FROM settings_shipping
     WHERE company_id = $1 AND key = $2
     ORDER BY effective_from DESC LIMIT 1`,
    [companyId, key]
  );
  if (!metaRows.length) {
    throw Object.assign(new Error(`Clave desconocida: ${key}`), { status: 404, code: "UNKNOWN_KEY" });
  }
  const valueType = String(metaRows[0].value_type || "string");
  const allowed = metaRows[0].allowed_values != null ? String(metaRows[0].allowed_values) : "";
  const rawVal = p.value != null ? String(p.value).trim() : "";

  if (valueType === "number") {
    if (rawVal === "" || !Number.isFinite(Number(rawVal))) {
      throw Object.assign(new Error("Valor numérico inválido"), { status: 400 });
    }
  } else if (valueType === "boolean") {
    if (rawVal !== "0" && rawVal !== "1") {
      throw Object.assign(new Error("boolean debe ser 0 o 1"), { status: 400 });
    }
  } else if (valueType === "enum" && allowed) {
    const set = new Set(
      allowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (!set.has(rawVal)) {
      throw Object.assign(
        new Error(`Valor no permitido. Opciones: ${allowed}`),
        { status: 400 }
      );
    }
  }

  const { rows: todayRows } = await pool.query(
    `SELECT id FROM settings_shipping
     WHERE company_id = $1 AND key = $2 AND effective_from = CURRENT_DATE`,
    [companyId, key]
  );

  if (todayRows.length) {
    await pool.query(
      `UPDATE settings_shipping
       SET value = $1, updated_by = $2, updated_at = now()
       WHERE id = $3`,
      [rawVal, p.updatedBy != null ? Number(p.updatedBy) : null, todayRows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO settings_shipping
        (company_id, key, value, value_type, description, allowed_values, effective_from, updated_by)
       SELECT company_id, key, $1::text, value_type, description, allowed_values, CURRENT_DATE, $2::int
       FROM settings_shipping
       WHERE company_id = $3 AND key = $4
       ORDER BY effective_from DESC
       LIMIT 1`,
      [rawVal, p.updatedBy != null ? Number(p.updatedBy) : null, companyId, key]
    );
  }

  const v = await pool.query(`SELECT get_shipping_setting($1::text, $2::int) AS val`, [key, companyId]);
  return { key, value: v.rows[0] ? v.rows[0].val : rawVal };
}

async function listProviders({ companyId = 1, scope = null, isActive = null } = {}) {
  let sql = `SELECT * FROM shipping_providers WHERE company_id = $1`;
  const params = [companyId];
  let i = 2;
  if (scope) {
    sql += ` AND scope = $${i}::shipping_scope`;
    params.push(scope);
    i++;
  }
  if (isActive !== null && isActive !== undefined) {
    sql += ` AND is_active = $${i}`;
    params.push(Boolean(isActive));
  }
  sql += ` ORDER BY scope NULLS LAST, name ASC`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getProvider(providerId) {
  const { rows: pr } = await pool.query(`SELECT * FROM shipping_providers WHERE id = $1`, [providerId]);
  if (!pr[0]) return null;
  const { rows: rates } = await pool.query(
    `SELECT * FROM v_shipping_rates_current WHERE provider_id = $1 ORDER BY category_name NULLS FIRST, shipment_mode`,
    [providerId]
  );
  return { ...pr[0], rates };
}

async function createProvider(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const name = String(p.name || "").trim();
  const scope = String(p.scope || "").trim();
  if (!name || !scope) {
    const e = new Error("name y scope son obligatorios");
    e.status = 400;
    throw e;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO shipping_providers
        (company_id, name, scope, contact_name, contact_email, contact_phone,
         origin_country, destination, notes, transport_mode, is_active)
       VALUES ($1,$2,$3::shipping_scope,$4,$5,$6,$7,$8,$9,
         COALESCE($10::transport_mode, 'SEA'::transport_mode), TRUE)
       RETURNING *`,
      [
        companyId,
        name,
        scope,
        p.contactName || null,
        p.contactEmail || p.contact_email || null,
        p.contactPhone || p.contact_phone || null,
        p.originCountry || p.origin_country || null,
        p.destination || null,
        p.notes || null,
        p.transport_mode || null,
      ]
    );
    return rows[0];
  } catch (e) {
    if (e && e.code === "23505") {
      const err = new Error("Ya existe un proveedor con ese nombre");
      err.code = "DUPLICATE_PROVIDER";
      err.status = 409;
      throw err;
    }
    throw e;
  }
}

async function updateProvider({ providerId, ...patch }) {
  const allowed = new Set([
    "name",
    "scope",
    "contact_name",
    "contact_email",
    "contact_phone",
    "origin_country",
    "destination",
    "notes",
    "is_active",
    "transport_mode",
  ]);
  const keys = Object.keys(patch).filter((k) => allowed.has(k) && patch[k] !== undefined);
  if (!keys.length) {
    const { rows } = await pool.query(`SELECT * FROM shipping_providers WHERE id = $1`, [providerId]);
    return rows[0] || null;
  }
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of keys) {
    if (k === "scope") {
      sets.push(`scope = $${i}::shipping_scope`);
      vals.push(patch[k]);
    } else if (k === "transport_mode") {
      sets.push(`transport_mode = $${i}::transport_mode`);
      vals.push(patch[k]);
    } else {
      sets.push(`${k} = $${i}`);
      vals.push(patch[k]);
    }
    i++;
  }
  vals.push(providerId);
  const { rows } = await pool.query(
    `UPDATE shipping_providers SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0] || null;
}

async function listCategories(companyId = 1) {
  const { rows } = await pool.query(
    `SELECT * FROM shipping_categories
     WHERE company_id = $1 AND is_active = TRUE
     ORDER BY is_default DESC NULLS LAST, name ASC`,
    [companyId]
  );
  return rows;
}

async function getCategory(categoryId) {
  const { rows } = await pool.query(
    `SELECT sc.*,
            (SELECT COUNT(*)::int FROM products p WHERE p.shipping_category_id = sc.id) AS products_assigned
     FROM shipping_categories sc
     WHERE sc.id = $1`,
    [categoryId]
  );
  return rows[0] || null;
}

async function createCategory(p) {
  const companyId = p.companyId != null ? Number(p.companyId) : 1;
  const name = String(p.name || "").trim();
  if (!name) {
    const e = new Error("name es obligatorio");
    e.status = 400;
    throw e;
  }
  const vf = p.volumetricFactor != null ? Number(p.volumetricFactor) : 5000;
  if (!Number.isFinite(vf) || vf <= 0) {
    const e = new Error("volumetric_factor debe ser > 0");
    e.status = 400;
    throw e;
  }
  const isDefault = Boolean(p.isDefault || p.is_default);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(
        `UPDATE shipping_categories SET is_default = FALSE, updated_at = now()
         WHERE company_id = $1 AND provider_id IS NULL`,
        [companyId]
      );
    }
    const { rows } = await client.query(
      `INSERT INTO shipping_categories
        (company_id, provider_id, name, description, volumetric_factor, is_default,
         transport_mode, rate_per_cbm, min_charge_cbm, is_active)
       VALUES ($1, NULL, $2, $3, $4, $5, 'SEA'::transport_mode, 1, 0.1, TRUE)
       RETURNING *`,
      [companyId, name, p.description || null, vf, isDefault]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if (e && e.code === "23505") {
      const err = new Error("Ya existe una categoría con ese nombre");
      err.status = 409;
      throw err;
    }
    throw e;
  } finally {
    client.release();
  }
}

async function setRate(p) {
  validateRateBasis(
    p.rateBasis || p.rate_basis,
    p.ratePerCbmUsd != null ? p.ratePerCbmUsd : p.rate_per_cbm_usd,
    p.ratePerKgUsd != null ? p.ratePerKgUsd : p.rate_per_kg_usd,
    p.flatRateUsd != null ? p.flatRateUsd : p.flat_rate_usd
  );
  const providerId = Number(p.providerId || p.provider_id);
  const categoryId =
    p.categoryId !== undefined && p.categoryId !== null
      ? Number(p.categoryId)
      : p.category_id !== undefined && p.category_id !== null
        ? Number(p.category_id)
        : null;
  const shipmentMode = String(p.shipmentMode || p.shipment_mode || "").trim();
  const effectiveFrom = p.effectiveFrom || p.effective_from || new Date().toISOString().slice(0, 10);

  const cols = {
    provider_id: providerId,
    category_id: Number.isFinite(categoryId) ? categoryId : null,
    shipment_mode: shipmentMode,
    rate_basis: rateBasis,
    rate_per_cbm_usd: p.ratePerCbmUsd ?? p.rate_per_cbm_usd ?? null,
    rate_per_kg_usd: p.ratePerKgUsd ?? p.rate_per_kg_usd ?? null,
    flat_rate_usd: p.flatRateUsd ?? p.flat_rate_usd ?? null,
    min_charge_usd: p.minChargeUsd != null ? Number(p.minChargeUsd) : p.min_charge_usd != null ? Number(p.min_charge_usd) : 0,
    surcharge_pct: p.surchargePct != null ? Number(p.surchargePct) : p.surcharge_pct != null ? Number(p.surcharge_pct) : 0,
    effective_from: effectiveFrom,
    effective_to: p.effectiveTo || p.effective_to || null,
    notes: p.notes || null,
  };

  const { rows } = await pool.query(
    `INSERT INTO shipping_rates (
       provider_id, category_id, shipment_mode, rate_basis,
       rate_per_cbm_usd, rate_per_kg_usd, flat_rate_usd,
       min_charge_usd, surcharge_pct, effective_from, effective_to, notes
     ) VALUES ($1,$2,$3::shipment_mode,$4::freight_rate_basis,$5,$6,$7,$8,$9,$10::date,$11::date,$12)
     ON CONFLICT (provider_id, category_id, shipment_mode, effective_from) DO NOTHING
     RETURNING *`,
    [
      cols.provider_id,
      cols.category_id,
      cols.shipment_mode,
      cols.rate_basis,
      cols.rate_per_cbm_usd,
      cols.rate_per_kg_usd,
      cols.flat_rate_usd,
      cols.min_charge_usd,
      cols.surcharge_pct,
      cols.effective_from,
      cols.effective_to,
      cols.notes,
    ]
  );
  if (rows[0]) return { inserted: true, rate: rows[0] };
  const { rows: existing } = await pool.query(
    `SELECT * FROM shipping_rates
     WHERE provider_id = $1
       AND shipment_mode = $2::shipment_mode
       AND effective_from = $3::date
       AND category_id IS NOT DISTINCT FROM $4`,
    [cols.provider_id, cols.shipment_mode, cols.effective_from, cols.category_id]
  );
  return { inserted: false, rate: existing[0] || null };
}

async function calculateFreight({
  providerId,
  categoryId,
  shipmentMode,
  totalCbm,
  totalKg,
  date,
  companyId: _companyId,
} = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM calculate_freight($1::bigint, $2::bigint, $3::shipment_mode, $4::numeric, $5::numeric, $6::date)`,
      [
        Number(providerId),
        categoryId != null ? Number(categoryId) : null,
        String(shipmentMode),
        Number(totalCbm) || 0,
        Number(totalKg) || 0,
        d,
      ]
    );
    return rows[0] || null;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/Sin tarifa vigente/i.test(msg)) {
      const err = new Error(msg);
      err.code = "NO_RATE";
      err.status = 404;
      throw err;
    }
    throw e;
  }
}

async function quoteAllProviders({
  categoryId,
  shipmentMode,
  totalCbm,
  totalKg,
  companyId = 1,
  date,
} = {}) {
  const settings = await getShippingSettings(companyId);
  const d = date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT * FROM quote_all_providers($1::bigint, $2::shipment_mode, $3::numeric, $4::numeric, $5::int, $6::date)`,
    [
      categoryId != null ? Number(categoryId) : null,
      String(shipmentMode),
      Number(totalCbm) || 0,
      Number(totalKg) || 0,
      companyId,
      d,
    ]
  );
  const markup = settings.freightMarkupPct || 0;
  const quotes = (rows || []).map((r) => {
    const base = Number(r.total_freight_usd);
    const withMarkup =
      markup > 0 ? round4(base * (1 + markup / 100)) : base;
    return {
      ...r,
      total_freight_with_markup: withMarkup,
    };
  });
  quotes.sort((a, b) => Number(a.total_freight_usd) - Number(b.total_freight_usd));
  return quotes;
}

async function assignCategoryToProducts({ categoryId, skus }) {
  if (!categoryId || !Array.isArray(skus) || skus.length === 0) {
    const e = new Error("category_id y skus (array no vacío) son obligatorios");
    e.status = 400;
    throw e;
  }
  const { rowCount } = await pool.query(
    `UPDATE products SET shipping_category_id = $1 WHERE sku = ANY($2::text[])`,
    [Number(categoryId), skus.map((s) => String(s).trim()).filter(Boolean)]
  );
  return { updated: rowCount };
}

/** Legacy: array de { sku, shipping_category_id, volume_cbm } sobre productos */
async function assignCategoryToProductsLegacy(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new Error("assignments debe ser un array no vacío");
  }
  if (assignments.length > 500) {
    throw new Error("Máximo 500 asignaciones por llamada.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let updated = 0;
    const notFound = [];
    for (const a of assignments) {
      const sid = a.shipping_category_id;
      const sku = String(a.sku || "").trim();
      if (!sku) continue;
      const { rowCount } = await client.query(
        `UPDATE products SET
           shipping_category_id = $1,
           unit_volume_cbm = COALESCE($2, unit_volume_cbm)
         WHERE sku = $3`,
        [sid, a.volume_cbm || null, sku]
      );
      if (rowCount === 0) {
        await client.query(
          `UPDATE productos SET
             shipping_category_id = $1,
             volume_cbm = COALESCE($2, volume_cbm)
           WHERE sku = $3`,
          [sid, a.volume_cbm || null, sku]
        );
        const r2 = await client.query(`SELECT 1 FROM productos WHERE sku = $1`, [sku]);
        if (r2.rowCount === 0) notFound.push(sku);
        else updated++;
      } else updated++;
    }
    await client.query("COMMIT");
    return { success: true, updated, notFound };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getUnassignedProducts({ page = 1, pageSize = 100, companyId: _c = 1 } = {}) {
  const limit = Math.min(parseInt(String(pageSize), 10) || 100, 500);
  const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;
  const { rows } = await pool.query(
    `SELECT sku,
            COALESCE(NULLIF(trim(description), ''), sku::text) AS descripcion,
            precio_usd, unit_volume_cbm, unit_weight_kg
     FROM products
     WHERE shipping_category_id IS NULL
     ORDER BY sku
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: cntRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM products WHERE shipping_category_id IS NULL`
  );
  return { products: rows, total: cntRows[0] ? Number(cntRows[0].total) : 0, page, pageSize: limit };
}

async function validateShippingData(shipmentId) {
  const { rows } = await pool.query(
    `SELECT
       l.id,
       l.product_sku AS producto_sku,
       COALESCE(l.shipping_category_id, p.shipping_category_id) AS cat_id,
        (COALESCE(l.unit_volume_cbm, p.unit_volume_cbm, sc.avg_volume_cbm) * l.quantity) AS volume_resolved,
       sc.rate_per_cbm,
       sc.min_charge_cbm,
       sc.is_active,
       sc.name AS category_name
     FROM import_shipment_lines l
     JOIN products p ON p.sku = l.product_sku
     LEFT JOIN shipping_categories sc
       ON sc.id = COALESCE(l.shipping_category_id, p.shipping_category_id)
     WHERE l.shipment_id = $1`,
    [shipmentId]
  );

  const errors = [];
  for (const row of rows) {
    if (!row.cat_id) {
      errors.push({ sku: row.producto_sku, reason: "Sin shipping_category_id asignada" });
      continue;
    }
    if (!row.is_active) {
      errors.push({ sku: row.producto_sku, reason: `Categoría "${row.category_name}" inactiva` });
      continue;
    }
    const vol = Number(row.volume_resolved);
    if (!vol || vol <= 0) {
      errors.push({
        sku: row.producto_sku,
        reason: "Sin volumen: unit_volume_cbm en línea/producto o avg_volume_cbm en categoría",
      });
    }
    if (!row.rate_per_cbm || Number(row.rate_per_cbm) <= 0) {
      errors.push({ sku: row.producto_sku, reason: "rate_per_cbm inválido o cero en la categoría" });
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      code: "MISSING_SHIPPING_DATA",
      detail: `${errors.length} SKU(s) sin datos de envío completos`,
      errors,
    };
  }
  return { valid: true, lines: rows };
}

async function calculateFreightByCbm(shipmentId) {
  const validation = await validateShippingData(shipmentId);
  if (!validation.valid) {
    const err = new Error(validation.detail);
    err.code = validation.code;
    err.details = validation.errors;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: shipmentRows } = await client.query(
      `SELECT status FROM import_shipments WHERE id = $1 FOR UPDATE`,
      [shipmentId]
    );
    const shipment = shipmentRows[0];
    if (!shipment) throw new Error(`Shipment ${shipmentId} no encontrado`);
    if (["CLOSED", "CANCELLED"].includes(String(shipment.status || "").toUpperCase())) {
      throw new Error(`No se puede recalcular un shipment en estado ${shipment.status}`);
    }

    const { rows: lines } = await client.query(
      `SELECT
         l.id,
         l.quantity,
         l.product_sku AS producto_sku,
         COALESCE(l.shipping_category_id, p.shipping_category_id) AS cat_id,
         COALESCE(l.unit_volume_cbm, p.unit_volume_cbm, sc.avg_volume_cbm) AS volume_unit,
         sc.rate_per_cbm,
         sc.min_charge_cbm
       FROM import_shipment_lines l
       JOIN products p ON p.sku = l.product_sku
       JOIN shipping_categories sc
         ON sc.id = COALESCE(l.shipping_category_id, p.shipping_category_id)
       WHERE l.shipment_id = $1`,
      [shipmentId]
    );

    let totalFreight = 0;
    for (const line of lines) {
      const qty = Number(line.quantity);
      const volUnit = Number(line.volume_unit);
      const rate = Number(line.rate_per_cbm);
      const minCharge = Number(line.min_charge_cbm);

      const volTotalLine = volUnit * qty;
      const fleteReal = volTotalLine * rate;
      const fleteMinimo = minCharge * rate;
      const freightLine = Math.max(fleteReal, fleteMinimo);
      totalFreight += freightLine;

      await client.query(
        `UPDATE import_shipment_lines SET
           shipping_category_id = $1,
           volume_cbm_used      = $2,
           freight_line_usd     = $3,
           rate_snapshot_cbm    = $4,
           freight_source       = 'DYNAMIC_CBM'
         WHERE id = $5`,
        [line.cat_id, volTotalLine.toFixed(6), freightLine.toFixed(4), rate.toFixed(4), line.id]
      );
    }

    const { rowCount: deletedFreight } = await client.query(
      `DELETE FROM import_expenses
       WHERE shipment_id = $1 AND expense_type = 'FREIGHT'`,
      [shipmentId]
    );
    if (deletedFreight > 0) {
      console.log(
        "[shippingService] Eliminados %s registros FREIGHT manuales del shipment %s",
        deletedFreight,
        shipmentId
      );
    }

    await client.query("COMMIT");
    return {
      success: true,
      shipmentId,
      linesProcessed: lines.length,
      totalFreightUsd: Number(totalFreight.toFixed(4)),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  SHIPPING_SETTING_KEYS,
  getShippingSettings,
  updateShippingSetting,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  listCategories,
  getCategory,
  createCategory,
  setRate,
  calculateFreight,
  quoteAllProviders,
  assignCategoryToProducts,
  assignCategoryToProductsLegacy,
  getUnassignedProducts,
  validateShippingData,
  calculateFreightByCbm,
};
