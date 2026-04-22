'use strict';
const { pool } = require('../../db');
const pino = require('pino');
const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'inventory_service' });
const { allocateNextSku } = require('./skuGeneratorService');

function maybeSyncMlPublicationState(productId, qtyBefore, qtyAfter) {
  if (qtyAfter <= 0 && qtyBefore > 0) {
    const { triggerAutoPause } = require('./mlPublicationsService');
    triggerAutoPause(productId).catch((err) => {
      log.error({ err: err.message, productId }, 'inventory_service: error triggerAutoPause');
    });
  } else if (qtyAfter > 0 && qtyBefore <= 0) {
    const { triggerAutoActivate } = require('./mlPublicationsService');
    triggerAutoActivate(productId, qtyAfter).catch((err) => {
      log.error({ err: err.message, productId }, 'inventory_service: error triggerAutoActivate');
    });
  }
}

// ── Catálogo + Stock ─────────────────────────────────────────────────────────

async function listProducts({ limit = 50, offset = 0, alert, category, brand, search, searchBy } = {}) {
  const ACCENT_FROM = "áéíóúüñàèìòùäëïöõÁÉÍÓÚÜÑÀÈÌÒÙÄËÏÖÕ";
  const ACCENT_TO = "aeiouunaieouaeiouoAEIOUUNAEIOUAEIOU";

  const params = [
    alert !== undefined ? alert : null,
    category !== undefined ? category : null,
    brand !== undefined ? brand : null,
  ];

  const s = search !== undefined && search != null ? String(search).trim() : "";
  const safeBy = searchBy === "name" ? "name" : searchBy === "sku" ? "sku" : null;
  let searchWhere = "TRUE";

  if (s.length >= 1) {
    if (safeBy === "name") {
      const tokens = s.split(/\s+/).filter((t) => t.length > 0).slice(0, 10);
      if (tokens.length > 0) {
        const foldCol = `translate(lower(p.name), '${ACCENT_FROM}', '${ACCENT_TO}')`;
        const pieces = [];
        for (const t of tokens) {
          params.push(t);
          const idx = params.length;
          pieces.push(
            `${foldCol} LIKE ('%' || translate(lower($${idx}::text), '${ACCENT_FROM}', '${ACCENT_TO}') || '%')`
          );
        }
        searchWhere = `(${pieces.join(" AND ")})`;
      }
    } else if (safeBy === "sku") {
      params.push(s);
      const idx = params.length;
      searchWhere = `p.sku ILIKE ('%' || $${idx}::text || '%')`;
    } else {
      params.push(s);
      const idx = params.length;
      searchWhere = `(p.sku ILIKE '%' || $${idx}::text || '%' OR p.name ILIKE '%' || $${idx}::text || '%')`;
    }
  }

  params.push(limit, offset);
  const limIdx = params.length - 1;
  const offIdx = params.length;

  /**
   * Listado: sin JOIN a inventory_projections (el front solo usa sku, nombre, stock, etc.).
   * Ese JOIN + ventana COUNT(*) era muy caro en catálogos grandes y en cold start Render.
   */
  const listSql = `
    SELECT
      p.id, p.sku, p.name, p.description, p.category, p.brand,
      p.unit_price_usd, p.source, p.is_active,
      i.stock_qty, i.stock_min, i.stock_max, i.stock_alert,
      i.lead_time_days, i.safety_factor, i.supplier_id,
      COUNT(*) OVER() AS total_count
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    WHERE p.is_active = TRUE
      AND ($1::boolean IS NULL OR i.stock_alert = $1)
      AND ($2::text    IS NULL OR p.category = $2)
      AND ($3::text    IS NULL OR p.brand ILIKE '%' || $3 || '%')
      AND ${searchWhere}
    ORDER BY
      i.stock_alert DESC,
      p.name ASC
    LIMIT $${limIdx} OFFSET $${offIdx}
  `;

  const summarySql = `
    SELECT
      COUNT(*) FILTER (WHERE p.is_active)                        AS total_products,
      COUNT(*) FILTER (WHERE i.stock_alert)                      AS alerts_count,
      COUNT(*) FILTER (WHERE ip.days_to_stockout IS NOT NULL
                         AND ip.days_to_stockout <= i.lead_time_days) AS stockout_count
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
  `;

  const [{ rows }, summaryRes] = await Promise.all([
    pool.query(listSql, params),
    pool.query(summarySql),
  ]);

  const total = rows.length ? Number(rows[0].total_count) : 0;

  const [sumRow] = summaryRes.rows;

  return {
    products: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
    pagination: { total, limit, offset, has_more: offset + rows.length < total },
    summary: {
      total_products:  Number(sumRow.total_products),
      alerts_count:    Number(sumRow.alerts_count),
      stockout_count:  Number(sumRow.stockout_count),
      ok_count:        Number(sumRow.total_products) - Number(sumRow.alerts_count),
    },
  };
}

/** Baja lógica: deja de listarse en catálogo activo. */
async function deactivateProduct(productId) {
  const upd = await pool.query(
    `UPDATE products SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND is_active = TRUE
     RETURNING id`,
    [productId]
  );
  if (upd.rowCount) return { id: productId, deactivated: true };
  const { rows } = await pool.query(
    `SELECT id FROM products WHERE id = $1`,
    [productId]
  );
  if (!rows.length) return null;
  return { id: productId, already_inactive: true };
}

async function getProductById(id) {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.description, p.category, p.brand,
      p.manufacturer_id,
      p.unit_price_usd, p.source, p.source_id, p.is_active, p.created_at, p.updated_at,
      i.stock_qty, i.stock_min, i.stock_max, i.stock_alert,
      i.lead_time_days, i.safety_factor, i.supplier_id, i.last_purchase_at,
      ip.avg_daily_sales, ip.avg_weekly_sales, ip.avg_monthly_sales,
      ip.days_to_stockout, ip.reorder_point, ip.suggested_order_qty,
      ip.velocity_trend, ip.last_calculated_at
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
    WHERE p.id = $1
  `, [id]);
  return rows[0] || null;
}

/**
 * Actualiza campos de catálogo (products) y/o stock (inventory) en una transacción.
 * @param {object} patch — campos opcionales: name, description, category, brand, unit_price_usd, stock_qty, stock_min
 */
async function updateProductById(productId, patch) {
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'sku')) {
    throw Object.assign(new Error('El SKU no puede modificarse tras crear el producto'), { code: 'SKU_IMMUTABLE' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: exist } = await client.query(
      `SELECT 1 FROM products p
       JOIN inventory i ON i.product_id = p.id
       WHERE p.id = $1`,
      [productId]
    );
    if (!exist.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const pSets = [];
    const pVals = [];
    let idx = 1;
    if (patch.name !== undefined) { pSets.push(`name = $${idx++}`); pVals.push(patch.name); }
    if (patch.description !== undefined) { pSets.push(`description = $${idx++}`); pVals.push(patch.description); }
    if (patch.category !== undefined) { pSets.push(`category = $${idx++}`); pVals.push(patch.category); }
    if (patch.brand !== undefined) { pSets.push(`brand = $${idx++}`); pVals.push(patch.brand); }
    if (patch.unit_price_usd !== undefined) {
      pSets.push(`unit_price_usd = $${idx++}`);
      pVals.push(patch.unit_price_usd);
    }
    if (pSets.length) {
      pSets.push('updated_at = NOW()');
      pVals.push(productId);
      const upd = await client.query(
        `UPDATE products SET ${pSets.join(', ')} WHERE id = $${idx} RETURNING id`,
        pVals
      );
      if (!upd.rowCount) throw Object.assign(new Error('No se pudo actualizar el producto'), { code: 'NOT_FOUND' });
    }

    if (patch.stock_qty !== undefined || patch.stock_min !== undefined) {
      const { rows: inv } = await client.query(
        'SELECT stock_qty, stock_min FROM inventory WHERE product_id = $1 FOR UPDATE',
        [productId]
      );
      if (!inv.length) throw Object.assign(new Error('Producto sin registro de inventario'), { code: 'NOT_FOUND' });

      const qtyBefore = Number(inv[0].stock_qty);
      const sq = patch.stock_qty !== undefined ? Number(patch.stock_qty) : qtyBefore;
      const sm = patch.stock_min !== undefined ? Number(patch.stock_min) : Number(inv[0].stock_min || 0);
      if (Number.isNaN(sq) || sq < 0) throw Object.assign(new Error('stock_qty inválido'), { code: 'VALIDATION' });
      if (Number.isNaN(sm) || sm < 0) throw Object.assign(new Error('stock_min inválido'), { code: 'VALIDATION' });

      const stockAlert = sq <= sm;
      await client.query(
        `UPDATE inventory
         SET stock_qty = $1, stock_min = $2, stock_alert = $3, updated_at = NOW()
         WHERE product_id = $4`,
        [sq, sm, stockAlert, productId]
      );
      maybeSyncMlPublicationState(productId, qtyBefore, sq);
    }

    if (!pSets.length && patch.stock_qty === undefined && patch.stock_min === undefined) {
      throw Object.assign(new Error('Nada que actualizar'), { code: 'EMPTY_UPDATE' });
    }

    await client.query('COMMIT');
    return getProductById(productId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function normalizeOemForProduct(s) {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Crea producto + inventario + OEM en una sola transacción; el SKU se reserva con `allocateNextSku`.
 * @param {object} opts
 * @param {number} opts.subcategory_id — `product_subcategories.id`
 * @param {number} opts.vehicle_brand_id — `crm_vehicle_brands.id` (tramo MMM del SKU)
 * @param {number} opts.manufacturer_id — `manufacturers.id` (fabricante del repuesto → products.manufacturer_id)
 * @param {string} opts.oem_code — OEM tal cual; se guarda en product_oem_codes y se normaliza para duplicados
 * @param {string} opts.name
 * @param {string|null} [opts.description]
 * @param {number} [opts.unit_price_usd]
 * @param {number} [opts.stock_qty]
 * @param {number} [opts.stock_min]
 * @param {number} [opts.company_id] — default 1
 */
async function createProductWithAllocatedSku(opts) {
  const sid = Number(opts.subcategory_id);
  const vehicleBrandId = Number(opts.vehicle_brand_id);
  const manufacturerId = Number(opts.manufacturer_id);
  if (!Number.isInteger(sid) || sid <= 0) {
    throw Object.assign(new Error('subcategory_id debe ser un entero positivo'), { code: 'INVALID_IDS' });
  }
  if (!Number.isInteger(vehicleBrandId) || vehicleBrandId <= 0) {
    throw Object.assign(new Error('vehicle_brand_id debe ser un entero positivo'), { code: 'INVALID_IDS' });
  }
  if (!Number.isInteger(manufacturerId) || manufacturerId <= 0) {
    throw Object.assign(new Error('manufacturer_id debe ser un entero positivo'), { code: 'INVALID_IDS' });
  }
  const name = String(opts.name || '').trim();
  if (!name.length) {
    throw Object.assign(new Error('name es obligatorio'), { code: 'VALIDATION' });
  }
  const oemOriginal = String(opts.oem_code ?? '').trim();
  const oemNormalized = normalizeOemForProduct(oemOriginal);
  if (!oemOriginal.length) {
    throw Object.assign(new Error('Debe ingresar al menos un código OEM o de fabricante'), { code: 'VALIDATION' });
  }
  if (!oemNormalized.length) {
    throw Object.assign(new Error('Código OEM inválido'), { code: 'OEM_INVALID' });
  }
  const description = opts.description === undefined || opts.description === null
    ? null
    : String(opts.description);
  const unitPriceUsd = opts.unit_price_usd != null && opts.unit_price_usd !== ''
    ? Number(opts.unit_price_usd)
    : 0;
  const stockQty = opts.stock_qty != null && opts.stock_qty !== ''
    ? Number(opts.stock_qty)
    : 0;
  const stockMin = opts.stock_min != null && opts.stock_min !== ''
    ? Number(opts.stock_min)
    : 0;
  const companyId = opts.company_id != null && opts.company_id !== ''
    ? Number(opts.company_id)
    : 1;

  if (!Number.isFinite(unitPriceUsd) || unitPriceUsd < 0) {
    throw Object.assign(new Error('unit_price_usd inválido'), { code: 'VALIDATION' });
  }
  if (!Number.isFinite(stockQty) || stockQty < 0) {
    throw Object.assign(new Error('stock_qty inválido'), { code: 'VALIDATION' });
  }
  if (!Number.isFinite(stockMin) || stockMin < 0) {
    throw Object.assign(new Error('stock_min inválido'), { code: 'VALIDATION' });
  }
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw Object.assign(new Error('company_id inválido'), { code: 'VALIDATION' });
  }

  const { rows: subRows } = await pool.query(
    `SELECT category_id FROM product_subcategories WHERE id = $1`,
    [sid]
  );
  if (!subRows.length) {
    throw Object.assign(new Error('Subcategoría no encontrada'), { code: 'SUBCATEGORY_NOT_FOUND' });
  }
  const derivedCategoryId = subRows[0].category_id;

  const { rows: mfrRows } = await pool.query(
    `SELECT id FROM manufacturers WHERE id = $1`,
    [manufacturerId]
  );
  if (!mfrRows.length) {
    throw Object.assign(new Error('Fabricante no encontrado'), { code: 'MANUFACTURER_NOT_FOUND' });
  }

  const { rows: dupRows } = await pool.query(
    `
    SELECT poc.product_id, p.sku, m.name AS manufacturer
    FROM product_oem_codes poc
    JOIN products p ON p.id = poc.product_id
    JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE poc.oem_normalized = $1 AND p.manufacturer_id = $2
    LIMIT 1
    `,
    [oemNormalized, manufacturerId]
  );
  if (dupRows.length) {
    const r = dupRows[0];
    const mname = r.manufacturer != null ? String(r.manufacturer) : 'el fabricante';
    throw Object.assign(
      new Error(`El código ${oemOriginal} ya existe para ${mname}. SKU: ${r.sku}`),
      { code: 'DUPLICATE_OEM' }
    );
  }

  const { rows: altRows } = await pool.query(
    `
    SELECT p.sku, m.name AS manufacturer
    FROM product_oem_codes poc
    JOIN products p ON p.id = poc.product_id
    JOIN manufacturers m ON m.id = p.manufacturer_id
    WHERE poc.oem_normalized = $1 AND p.manufacturer_id <> $2
    `,
    [oemNormalized, manufacturerId]
  );
  const warnings = altRows.map((r) => {
    const mname = r.manufacturer != null ? String(r.manufacturer) : 'otro fabricante';
    return `OEM ${oemOriginal} también registrado para ${mname} (SKU: ${r.sku})`;
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sku = await allocateNextSku(client, sid, vehicleBrandId);

    const { rows: metaRows } = await client.query(
      `
      SELECT
        ps.id AS subcategory_id,
        ps.category_id,
        cp.category_descripcion,
        b.id AS vehicle_brand_id,
        b.name AS vehicle_brand_name
      FROM product_subcategories ps
      JOIN category_products cp ON cp.id = ps.category_id
      JOIN crm_vehicle_brands b ON b.id = $2
      WHERE ps.id = $1
      `,
      [sid, vehicleBrandId]
    );
    if (!metaRows.length) {
      throw Object.assign(new Error('No se pudo resolver catálogo para el producto'), { code: 'PREFIX_LOOKUP_FAILED' });
    }
    const meta = metaRows[0];
    const categoryText = meta.category_descripcion != null ? String(meta.category_descripcion) : null;
    const vehicleBrandText = meta.vehicle_brand_name != null ? String(meta.vehicle_brand_name) : null;
    const categoryIdForInsert = meta.category_id != null ? Number(meta.category_id) : derivedCategoryId;

    const stockAlert = stockQty <= stockMin;

    let insProd;
    try {
      insProd = await client.query(
        `
        INSERT INTO products (
          sku, name, description, category, brand,
          unit_price_usd, precio_usd, source, is_active,
          subcategory_id, brand_id, manufacturer_id, category_id, company_id
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $6, 'manual', TRUE,
          $7, $8, $9, $10, $11
        )
        RETURNING id
        `,
        [
          sku,
          name,
          description,
          categoryText,
          vehicleBrandText,
          unitPriceUsd,
          sid,
          vehicleBrandId,
          manufacturerId,
          categoryIdForInsert,
          companyId,
        ]
      );
    } catch (insErr) {
      if (insErr && insErr.code === '23505') {
        const dup = Object.assign(
          new Error('Conflicto de SKU único; reintenta o revisa prefijos'),
          { code: 'DUPLICATE_SKU' }
        );
        throw dup;
      }
      throw insErr;
    }

    const productId = insProd.rows[0].id;

    await client.query(
      `
      INSERT INTO inventory (product_id, stock_qty, stock_min, stock_alert)
      VALUES ($1, $2, $3, $4)
      `,
      [productId, stockQty, stockMin, stockAlert]
    );

    await client.query(
      `
      INSERT INTO product_oem_codes (product_id, oem_original, oem_normalized, source)
      VALUES ($1, $2, $3, 'manual_creation')
      `,
      [productId, oemOriginal, oemNormalized]
    );

    await client.query('COMMIT');
    const row = await getProductById(productId);
    return {
      ...row,
      manufacturer_id: manufacturerId,
      oem_original: oemOriginal,
      oem_normalized: oemNormalized,
      warnings,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function searchProducts(q, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `
    SELECT
      p.id,
      p.sku,
      p.sku_old,
      p.name,
      p.description,
      NULLIF(
        TRIM(
          CONCAT_WS(
            E'\n',
            NULLIF(TRIM(p.name), ''),
            NULLIF(TRIM(p.description), '')
          )
        ),
        ''
      ) AS catalog_full_text,
      p.brand,
      p.unit_price_usd,
      p.company_id,
      i.stock_qty,
      i.stock_alert,
      ip.days_to_stockout
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
    WHERE p.is_active = TRUE
      AND (
        p.sku ILIKE '%' || $1 || '%'
        OR p.name ILIKE '%' || $1 || '%'
        OR COALESCE(p.sku_old, '') ILIKE '%' || $1 || '%'
        OR COALESCE(p.description, '') ILIKE '%' || $1 || '%'
      )
    ORDER BY p.name ASC
    LIMIT $2
  `,
    [q, limit]
  );
  return rows;
}

async function getAlerts() {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.stock_min, i.lead_time_days, i.supplier_id,
      ip.days_to_stockout, ip.suggested_order_qty, ip.velocity_trend,
      CASE
        WHEN ip.days_to_stockout IS NOT NULL
          AND ip.days_to_stockout <= i.lead_time_days  THEN 'PEDIR_URGENTE'
        WHEN ip.days_to_stockout IS NOT NULL
          AND ip.days_to_stockout <= i.lead_time_days * 2 THEN 'PEDIR_PRONTO'
        ELSE 'MONITOREAR'
      END AS action
    FROM products p
    JOIN inventory i ON i.product_id = p.id
    LEFT JOIN inventory_projections ip ON ip.product_id = p.id
    WHERE p.is_active = TRUE AND i.stock_alert = TRUE
    ORDER BY ip.days_to_stockout ASC NULLS LAST
  `);

  const critical = rows.filter(r => r.action === 'PEDIR_URGENTE');
  const warning  = rows.filter(r => r.action !== 'PEDIR_URGENTE');

  const estInvestment = rows.reduce((sum, r) =>
    sum + Number(r.suggested_order_qty || 0) * Number(r.unit_price_usd || 0), 0
  );

  return {
    critical,
    warning,
    total_critical: critical.length,
    total_warning:  warning.length,
    estimated_investment_usd: Number(estInvestment.toFixed(2)),
  };
}

async function getImmStockouts() {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.lead_time_days,
      ip.avg_daily_sales, ip.days_to_stockout,
      ip.suggested_order_qty, ip.velocity_trend
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = p.id
    WHERE ip.days_to_stockout IS NOT NULL
      AND ip.days_to_stockout <= i.lead_time_days
    ORDER BY ip.days_to_stockout ASC
  `);
  return rows;
}

// ── Ajuste manual de stock ───────────────────────────────────────────────────

async function adjustStock(productId, { qty_change, type, notes, created_by, reference_id }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: inv } = await client.query(
      'SELECT stock_qty, stock_min FROM inventory WHERE product_id = $1 FOR UPDATE',
      [productId]
    );
    if (!inv.length) throw Object.assign(new Error('Producto sin registro de inventario'), { code: 'NOT_FOUND' });

    const qtyBefore = Number(inv[0].stock_qty);
    const qtyAfter  = qtyBefore + qty_change;
    if (qtyAfter < 0) throw Object.assign(new Error('Stock resultante negativo'), { code: 'NEGATIVE_STOCK' });

    const stockMin   = Number(inv[0].stock_min || 0);
    const stockAlert = qtyAfter <= stockMin;

    await client.query(`
      UPDATE inventory
      SET stock_qty = $1, stock_alert = $2, updated_at = NOW()
      WHERE product_id = $3
    `, [qtyAfter, stockAlert, productId]);

    await client.query(`
      INSERT INTO stock_movements
        (product_id, type, qty_before, qty_change, qty_after, reference_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [productId, type, qtyBefore, qty_change, qtyAfter, reference_id || null, notes, created_by]);

    await client.query('COMMIT');
    maybeSyncMlPublicationState(productId, qtyBefore, qtyAfter);
    return { product_id: productId, qty_before: qtyBefore, qty_change, qty_after: qtyAfter, stock_alert: stockAlert };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Configurar parámetros de reposición ─────────────────────────────────────

async function updateProductConfig(productId, { lead_time_days, safety_factor, stock_max, supplier_id }) {
  const sets = [];
  const vals = [];
  let idx = 1;

  if (lead_time_days !== undefined) { sets.push(`lead_time_days = $${idx++}`); vals.push(lead_time_days); }
  if (safety_factor  !== undefined) { sets.push(`safety_factor  = $${idx++}`); vals.push(safety_factor); }
  if (stock_max      !== undefined) { sets.push(`stock_max      = $${idx++}`); vals.push(stock_max); }
  if (supplier_id    !== undefined) { sets.push(`supplier_id    = $${idx++}`); vals.push(supplier_id); }

  if (!sets.length) throw Object.assign(new Error('Nada que actualizar'), { code: 'EMPTY_UPDATE' });

  sets.push(`updated_at = NOW()`);
  vals.push(productId);

  const { rows } = await pool.query(
    `UPDATE inventory SET ${sets.join(', ')} WHERE product_id = $${idx} RETURNING *`,
    vals
  );
  if (!rows.length) throw Object.assign(new Error('Producto no encontrado'), { code: 'NOT_FOUND' });
  return rows[0];
}

async function listCategoryProducts() {
  const { rows } = await pool.query(`
    SELECT id, category_descripcion, category_ml
    FROM category_products
    ORDER BY category_descripcion ASC, id ASC
  `);
  return { categories: rows };
}

/**
 * Subcategorías de catálogo bajo un category_products.id.
 * @param {number} categoryId
 */
async function listProductSubcategoriesByCategoryId(categoryId) {
  const { rows } = await pool.query(
    `
    SELECT
      id,
      category_id,
      name AS subcategory_descripcion,
      sort_order,
      TRUE AS is_active
    FROM product_subcategories
    WHERE category_id = $1
    ORDER BY sort_order ASC, name ASC
    `,
    [categoryId]
  );
  return { subcategories: rows };
}

// ── Proyecciones ─────────────────────────────────────────────────────────────

async function listProjections({ limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      ip.*,
      p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.lead_time_days, i.stock_alert,
      COUNT(*) OVER() AS total_count
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = ip.product_id
    ORDER BY ip.days_to_stockout ASC NULLS LAST
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    projections: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
    pagination: { total, limit, offset, has_more: offset + rows.length < total },
  };
}

async function getProjectionByProductId(productId) {
  const { rows } = await pool.query(`
    SELECT ip.*, p.sku, p.name, i.stock_qty, i.lead_time_days
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = ip.product_id
    WHERE ip.product_id = $1
  `, [productId]);
  return rows[0] || null;
}

async function getStockouts({ days = 30 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.sku, p.name, p.unit_price_usd,
      i.stock_qty, i.lead_time_days,
      ip.avg_daily_sales, ip.days_to_stockout,
      ip.suggested_order_qty, ip.velocity_trend,
      (CURRENT_DATE + ip.days_to_stockout)               AS stockout_date,
      (CURRENT_DATE + ip.days_to_stockout - i.lead_time_days) AS must_order_by
    FROM inventory_projections ip
    JOIN products p ON p.id = ip.product_id
    JOIN inventory i ON i.product_id = ip.product_id
    WHERE ip.days_to_stockout IS NOT NULL
      AND ip.days_to_stockout <= $1
    ORDER BY ip.days_to_stockout ASC
  `, [days]);

  const totalInvestment = rows.reduce((sum, r) =>
    sum + Number(r.suggested_order_qty || 0) * Number(r.unit_price_usd || 0), 0
  );

  return {
    days_analyzed:              days,
    stockouts:                  rows,
    total_skus_at_risk:         rows.length,
    total_investment_needed_usd: Number(totalInvestment.toFixed(2)),
  };
}

// ── Órdenes de compra ────────────────────────────────────────────────────────

async function listPurchaseOrders({ limit = 50, offset = 0, status } = {}) {
  const { rows } = await pool.query(`
    SELECT po.*, s.name AS supplier_name, COUNT(*) OVER() AS total_count
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE ($1::text IS NULL OR po.status = $1)
    ORDER BY po.created_at DESC
    LIMIT $2 OFFSET $3
  `, [status || null, limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    orders: rows.map(r => { const { total_count, ...rest } = r; return rest; }),
    pagination: { total, limit, offset, has_more: offset + rows.length < total },
  };
}

async function getPurchaseOrderById(id) {
  const { rows: [order] } = await pool.query(`
    SELECT po.*, s.name AS supplier_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = $1
  `, [id]);
  if (!order) return null;

  const { rows: items } = await pool.query(`
    SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id
  `, [id]);

  return { ...order, items };
}

async function createPurchaseOrder({ supplier_id, notes, items }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const totalUsd = (items || []).reduce((s, i) => s + (Number(i.qty_suggested) * Number(i.unit_price_usd || 0)), 0);
    const { rows: [order] } = await client.query(`
      INSERT INTO purchase_orders (supplier_id, status, total_usd, notes)
      VALUES ($1,'suggested',$2,$3)
      RETURNING *
    `, [supplier_id || null, totalUsd, notes || null]);

    for (const item of (items || [])) {
      await client.query(`
        INSERT INTO purchase_order_items
          (purchase_order_id, product_id, sku, name, qty_suggested, unit_price_usd, subtotal_usd, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        order.id, item.product_id, item.sku, item.name,
        item.qty_suggested, item.unit_price_usd,
        Number(item.qty_suggested) * Number(item.unit_price_usd || 0),
        item.reason || null,
      ]);
    }
    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const PO_TRANSITIONS = {
  suggested: ['approved', 'cancelled'],
  approved:  ['ordered', 'cancelled'],
  ordered:   ['received', 'cancelled'],
  received:  [],
  cancelled: [],
};

async function updatePurchaseOrderStatus(id, { status, approved_by, notes }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [po] } = await client.query(
      'SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]
    );
    if (!po) throw Object.assign(new Error('Orden no encontrada'), { code: 'NOT_FOUND' });
    if (!PO_TRANSITIONS[po.status]?.includes(status)) {
      throw Object.assign(
        new Error(`Transición inválida: ${po.status} → ${status}`),
        { code: 'INVALID_TRANSITION' }
      );
    }

    const extra = {};
    if (status === 'approved')  { extra.approved_by = approved_by; extra.approved_at = new Date(); }
    if (status === 'ordered')   { extra.ordered_at  = new Date(); }
    if (status === 'received')  { extra.received_at = new Date(); }

    await client.query(`
      UPDATE purchase_orders
      SET status = $1, notes = COALESCE($2, notes),
          approved_by = COALESCE($3, approved_by),
          approved_at = COALESCE($4, approved_at),
          ordered_at  = COALESCE($5, ordered_at),
          received_at = COALESCE($6, received_at)
      WHERE id = $7
    `, [
      status, notes || null,
      extra.approved_by || null, extra.approved_at || null,
      extra.ordered_at  || null, extra.received_at || null,
      id,
    ]);

    // Al recibir: actualizar stock por cada ítem
    if (status === 'received') {
      const mlTransitions = [];
      const { rows: items } = await client.query(
        'SELECT * FROM purchase_order_items WHERE purchase_order_id = $1', [id]
      );
      for (const item of items) {
        const { rows: [inv] } = await client.query(
          'SELECT stock_qty, stock_min FROM inventory WHERE product_id = $1 FOR UPDATE',
          [item.product_id]
        );
        if (!inv) continue;
        const qtyBefore = Number(inv.stock_qty);
        const qtyChange = Number(item.qty_ordered || item.qty_suggested);
        const qtyAfter  = qtyBefore + qtyChange;
        const newAlert  = qtyAfter <= Number(inv.stock_min || 0);

        await client.query(`
          UPDATE inventory
          SET stock_qty = $1, stock_alert = $2, last_purchase_at = NOW(), updated_at = NOW()
          WHERE product_id = $3
        `, [qtyAfter, newAlert, item.product_id]);

        await client.query(`
          INSERT INTO stock_movements
            (product_id, type, qty_before, qty_change, qty_after, reference_id, notes, created_by)
          VALUES ($1,'purchase',$2,$3,$4,$5,'Recepción orden de compra','system')
        `, [item.product_id, qtyBefore, qtyChange, qtyAfter, `PO-${id}`]);

        mlTransitions.push({
          product_id: Number(item.product_id),
          qty_before: qtyBefore,
          qty_after: qtyAfter,
        });
      }
      await client.query('COMMIT');
      for (const t of mlTransitions) {
        maybeSyncMlPublicationState(t.product_id, t.qty_before, t.qty_after);
      }
      return getPurchaseOrderById(id);
    }

    await client.query('COMMIT');
    return getPurchaseOrderById(id);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Fabricantes (repuesto) ───────────────────────────────────────────────────

/**
 * Listado de `manufacturers` para formularios (p. ej. alta de producto).
 * @param {{ q?: string, limit?: number }} [opts]
 */
async function listManufacturers({ q, limit = 500 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const search = q != null && String(q).trim() !== '' ? String(q).trim() : null;
  if (search) {
    const { rows } = await pool.query(
      `
      SELECT id, name, created_at
      FROM manufacturers
      WHERE name ILIKE $1
      ORDER BY name ASC
      LIMIT $2
      `,
      [`%${search}%`, lim]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `
    SELECT id, name, created_at
    FROM manufacturers
    ORDER BY name ASC
    LIMIT $1
    `,
    [lim]
  );
  return rows;
}

// ── Proveedores ──────────────────────────────────────────────────────────────

async function listSuppliers() {
  const { rows } = await pool.query(
    'SELECT * FROM suppliers WHERE is_active = TRUE ORDER BY name ASC'
  );
  return rows;
}

async function createSupplier(data) {
  const { rows: [s] } = await pool.query(`
    INSERT INTO suppliers (name, country, lead_time_days, currency, contact_info)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
  `, [data.name, data.country || 'Venezuela', data.lead_time_days || 7, data.currency || 'USD', JSON.stringify(data.contact_info || {})]);
  return s;
}

async function updateSupplier(id, data) {
  const sets = [];
  const vals = [];
  let idx = 1;
  ['name','country','lead_time_days','currency','is_active'].forEach(k => {
    if (data[k] !== undefined) { sets.push(`${k} = $${idx++}`); vals.push(data[k]); }
  });
  if (!sets.length) throw Object.assign(new Error('Nada que actualizar'), { code: 'EMPTY_UPDATE' });
  vals.push(id);
  const { rows: [s] } = await pool.query(
    `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals
  );
  return s;
}

// ── Stats del módulo ─────────────────────────────────────────────────────────

async function getInventoryStats() {
  const [catalog, alerts, proj, pos, value, lastCalc] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)                              AS total_skus,
        COUNT(*) FILTER (WHERE is_active)     AS active_skus
      FROM products
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE i.stock_alert)                               AS critical,
        COUNT(*) FILTER (WHERE NOT i.stock_alert AND i.stock_qty <= 0)      AS zero_stock,
        COUNT(*) FILTER (WHERE i.stock_qty > 0 AND NOT i.stock_alert)       AS ok
      FROM products p JOIN inventory i ON i.product_id = p.id
      WHERE p.is_active = TRUE
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE days_to_stockout <= 7)  AS stockouts_7d,
        COUNT(*) FILTER (WHERE days_to_stockout <= 15) AS stockouts_15d,
        COUNT(*) FILTER (WHERE days_to_stockout <= 30) AS stockouts_30d
      FROM inventory_projections
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'suggested')                                AS suggested,
        COUNT(*) FILTER (WHERE status = 'approved')                                 AS approved,
        COUNT(*) FILTER (WHERE status = 'ordered')                                  AS ordered,
        COUNT(*) FILTER (WHERE status = 'received'
          AND received_at >= DATE_TRUNC('month', NOW()))                            AS received_this_month
      FROM purchase_orders
    `),
    pool.query(`
      SELECT COALESCE(SUM(i.stock_qty * COALESCE(p.unit_price_usd, 0)), 0) AS inventory_value_usd
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE p.is_active = TRUE
    `),
    pool.query(`
      SELECT MAX(last_calculated_at) AS last_worker_run FROM inventory_projections
    `),
  ]);

  const c = catalog.rows[0];
  const a = alerts.rows[0];

  return {
    catalog: {
      total_skus:       Number(c.total_skus),
      active_skus:      Number(c.active_skus),
      skus_with_stock:  Number(c.active_skus) - Number(a.zero_stock || 0),
      skus_zero_stock:  Number(a.zero_stock || 0),
    },
    alerts: {
      critical: Number(a.critical),
      warning:  0,
      ok:       Number(a.ok),
    },
    projections: {
      stockouts_7d:  Number(proj.rows[0].stockouts_7d),
      stockouts_15d: Number(proj.rows[0].stockouts_15d),
      stockouts_30d: Number(proj.rows[0].stockouts_30d),
    },
    purchase_orders: {
      suggested:           Number(pos.rows[0].suggested),
      approved:            Number(pos.rows[0].approved),
      ordered:             Number(pos.rows[0].ordered),
      received_this_month: Number(pos.rows[0].received_this_month),
    },
    inventory_value_usd: Number(Number(value.rows[0].inventory_value_usd).toFixed(2)),
    last_worker_run:     lastCalc.rows[0].last_worker_run || null,
  };
}

/**
 * Registra un ajuste de precio de catálogo:
 *  1. Lee el precio actual (unit_price_usd) con bloqueo FOR UPDATE.
 *  2. Actualiza products.unit_price_usd.
 *  3. Inserta en product_unit_price_history dentro de la misma transacción.
 *
 * @param {number} productId
 * @param {number} newPrice
 * @param {{ userId?: number, userName?: string, reason?: string, source?: string }} meta
 * @returns {Promise<{ product: object, history: object }>}
 */
async function addPriceAdjustment(productId, newPrice, meta = {}) {
  if (!Number.isFinite(newPrice) || newPrice < 0) {
    throw Object.assign(new Error('unit_price_usd inválido'), { code: 'VALIDATION' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: cur } = await client.query(
      `SELECT id, unit_price_usd FROM products WHERE id = $1 FOR UPDATE`,
      [productId]
    );
    if (!cur.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const priceBefore = cur[0].unit_price_usd != null ? Number(cur[0].unit_price_usd) : null;

    await client.query(
      `UPDATE products SET unit_price_usd = $1, updated_at = NOW() WHERE id = $2`,
      [newPrice, productId]
    );

    const { rows: hist } = await client.query(
      `INSERT INTO product_unit_price_history
         (product_id, price_before, price_after, changed_by_id, changed_by_name, reason, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        productId,
        priceBefore,
        newPrice,
        meta.userId   ?? null,
        meta.userName ?? null,
        meta.reason   ?? null,
        meta.source   ?? 'ui',
      ]
    );

    await client.query('COMMIT');

    const product = await getProductById(productId);
    return { product, history: hist[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Devuelve el historial de ajustes de precio de un producto, más reciente primero.
 *
 * @param {number} productId
 * @param {{ limit?: number, offset?: number }} opts
 */
async function getPriceHistory(productId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, product_id, price_before, price_after,
            changed_by_id, changed_by_name, reason, source, created_at
       FROM product_unit_price_history
      WHERE product_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [productId, limit, offset]
  );
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM product_unit_price_history WHERE product_id = $1`,
    [productId]
  );
  return { items: rows, total: cnt[0]?.total ?? 0 };
}

module.exports = {
  listProducts,
  deactivateProduct,
  getProductById,
  updateProductById,
  addPriceAdjustment,
  getPriceHistory,
  createProductWithAllocatedSku,
  searchProducts,
  getAlerts,
  getImmStockouts,
  adjustStock,
  updateProductConfig,
  listProjections,
  getProjectionByProductId,
  getStockouts,
  listPurchaseOrders,
  getPurchaseOrderById,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
  listSuppliers,
  createSupplier,
  updateSupplier,
  getInventoryStats,
  listManufacturers,
  listCategoryProducts,
  listProductSubcategoriesByCategoryId,
};
