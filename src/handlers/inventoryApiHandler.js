'use strict';
const { z } = require('zod');
const svc   = require('../services/inventoryService');
const { pool } = require('../../db');
const skuPrefixService = require('../services/skuPrefixService');
const { generateSuggestedPurchaseOrder } = require('../workers/inventoryWorker');
const { allocateNextSku } = require('../services/skuGeneratorService');
const pricingService = require('../services/pricingService');
const { requireAdminOrPermission, checkAdminSecretOrJwt } = require('../utils/authMiddleware');
const { getTodayRate } = require('../services/currencyService');

// ── Auth + helpers ────────────────────────────────────────────────────────────

function ok(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data }));
}

function fail(res, code, message, status = 400) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(Object.assign(e, { code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

function idParam(url) {
  return Number(url.searchParams.get('_id'));
}

/** Entero >= 1 (el id 1 es válido; evitar solo `if (!id)` porque confunde la lectura). */
function parsePositiveIntId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** company_id desde query (?company_id=); default 1; inválido → null */
function parseCompanyIdQuery(url, defaultVal = 1) {
  const raw = url.searchParams.get('company_id');
  if (raw == null || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

// Validación de cuerpos
const StockAdjustSchema = z.object({
  qty_change:   z.number().refine(v => v !== 0, { message: 'qty_change no puede ser 0' }),
  type:         z.enum(['purchase','adjustment','return']),
  notes:        z.string().min(3).max(500),
  created_by:   z.string().min(1),
  reference_id: z.string().optional(),
});

const ProductConfigSchema = z.object({
  lead_time_days: z.number().int().min(1).max(365).optional(),
  safety_factor:  z.number().min(1.0).max(5.0).optional(),
  stock_max:      z.number().min(0).optional(),
  supplier_id:    z.number().int().positive().optional(),
}).strict();

/** POST /api/inventory/products/:id/price-adjustment */
const PriceAdjustmentSchema = z.object({
  unit_price_usd: z.coerce.number().min(0),
  reason:         z.string().min(1).max(300).optional(),
}).strict();

/** PATCH /api/inventory/products/:id — catálogo + stock básico */
const ProductPatchSchema = z.object({
  name:             z.string().min(1).optional(),
  description:      z.union([z.string(), z.null()]).optional(),
  category:         z.union([z.string(), z.null()]).optional(),
  brand:            z.union([z.string(), z.null()]).optional(),
  unit_price_usd:   z.coerce.number().min(0).optional(),
  stock_qty:        z.coerce.number().min(0).optional(),
  stock_min:        z.coerce.number().min(0).optional(),
}).strict();

/** PATCH /api/inventory/products/:id/identity — cambio de clasificación con verificación de movimientos */
const ProductIdentitySchema = z.object({
  brand_id:       z.number().int().positive().optional(),
  subcategory_id: z.number().int().positive().optional(),
  category_id:    z.number().int().positive().optional(),
}).strict().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Se requiere al menos un campo: brand_id, subcategory_id o category_id' }
);

/**
 * POST /api/inventory/products — alta atómica (SKU + inventario + OEM).
 * - vehicle_brand_id → crm_vehicle_brands (MMM del SKU); en BD: products.brand_id.
 * - manufacturer_id → manufacturers; en BD: products.manufacturer_id.
 * - brand_id / category_id en el body se ignoran (ver handler).
 */
const ProductCreateSchema = z.object({
  subcategory_id:    z.coerce.number().int().positive(),
  vehicle_brand_id:  z.coerce.number().int().positive(),
  manufacturer_id:   z.coerce.number().int().positive(),
  oem_code:          z.string().min(1, { message: 'Debe ingresar al menos un código OEM o de fabricante' }).max(500),
  name:              z.string().min(1).max(500),
  description:       z.union([z.string(), z.null()]).optional(),
  unit_price_usd:    z.coerce.number().min(0).optional(),
  stock_qty:         z.coerce.number().min(0).optional(),
  stock_min:         z.coerce.number().min(0).optional(),
  company_id:        z.coerce.number().int().positive().optional(),
}).strict();

const PricingRunSchema = z.object({
  channel: z.enum(['mostrador', 'whatsapp', 'ml', 'ecommerce']),
  company_id: z.number().int().positive().optional(),
}).strict();

const FinancialSettingsPatchSchema = z
  .object({
    flete_nacional_pct: z.number().min(0).max(1).optional(),
    arancel_pct: z.number().min(0).max(1).optional(),
    gasto_admin_pct: z.number().min(0).max(1).optional(),
    storage_cost_pct: z.number().min(0).max(1).optional(),
    picking_packing_usd: z.number().min(0).optional(),
    iva_pct: z.number().min(0).max(1).optional(),
    igtf_pct: z.number().min(0).max(0.999).optional(),
    igtf_absorbed: z.boolean().optional(),
    spread_alert_pct: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Se requiere al menos un campo' });

const PolicyChannelPatchSchema = z
  .object({
    markup_pct: z.number().min(0).max(10).optional(),
    commission_pct: z.number().min(0).max(0.999).optional(),
    max_discount_pct: z.number().min(0).max(0.999).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Se requiere al menos un campo' });

const PaymentSettingPatchSchema = z
  .object({
    rate_source: z.enum(['bcv', 'binance', 'adjusted']).optional(),
    applies_igtf: z.boolean().optional(),
    method_commission_pct: z.number().min(0).max(0.999).optional(),
    collection_currency: z.enum(['USD', 'VES', 'USDT']).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: 'Se requiere al menos un campo' });

const CreatePOSchema = z.object({
  supplier_id:  z.number().int().positive().optional(),
  notes:        z.string().max(1000).optional(),
  items:        z.array(z.object({
    product_id:    z.number().int().positive(),
    sku:           z.string().min(1),
    name:          z.string().min(1),
    qty_suggested: z.number().positive(),
    unit_price_usd: z.number().min(0).optional(),
    reason:        z.string().optional(),
  })).min(1),
});

const GeneratePOSchema = z.object({
  supplier_id:  z.number().int().positive().optional(),
  approved_by:  z.string().min(1).optional(),
});

const POStatusSchema = z.object({
  status:      z.enum(['approved','ordered','received','cancelled']),
  approved_by: z.string().min(1).optional(),
  notes:       z.string().max(1000).optional(),
});

const SupplierSchema = z.object({
  name:          z.string().min(1),
  country:       z.string().optional(),
  lead_time_days: z.number().int().min(1).optional(),
  currency:      z.enum(['USD','BS','ZELLE','BINANCE','PANAMA']).optional(),
  contact_info:  z.record(z.any()).optional(),
});

const CategoryProductCreateSchema = z.object({
  category_descripcion: z.string().min(1).max(500),
  category_ml: z.union([z.string().max(200), z.null()]).optional(),
  sku_prefix: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : String(v).toUpperCase().trim()),
    z.string().length(2).regex(/^[A-Z]{2}$/).optional()
  ),
}).strict();

const ProductSubcategoryCreateSchema = z.object({
  category_id: z.coerce.number().int().positive(),
  name: z.string().min(1).max(500),
  sort_order: z.number().int().min(0).optional(),
  sku_prefix: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : String(v).toUpperCase().trim()),
    z.string().length(3).regex(/^[A-Z]{3}$/).optional()
  ),
}).strict();

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * Retorna true si el handler manejó la request.
 * Prefijo de rutas: /api/inventory
 */
async function handleInventoryApiRequest(req, res, url) {
  const pathname =
    String(url.pathname || '')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/, '') || '/';
  if (!pathname.startsWith('/api/inventory')) return false;

  if (!await requireAdminOrPermission(req, res, 'catalog')) return true;

  const method  = req.method.toUpperCase();
  const parts   = pathname.split('/').filter(Boolean);
  // parts[0]='api', parts[1]='inventory', parts[2]=grupo, parts[3]=id...

  try {
    // ── GRUPO 1 — Catálogo y Stock ─────────────────────────────────────────

    // GET /api/inventory/stats
    if (method === 'GET' && pathname === '/api/inventory/stats') {
      const data = await svc.getInventoryStats();
      return ok(res, data), true;
    }

    // GET /api/inventory/alerts
    if (method === 'GET' && pathname === '/api/inventory/alerts') {
      const data = await svc.getAlerts();
      return ok(res, data), true;
    }

    // GET /api/inventory/stockouts (alias rápido)
    if (method === 'GET' && pathname === '/api/inventory/stockouts') {
      const data = await svc.getImmStockouts();
      return ok(res, { stockouts: data }), true;
    }

    // ── /api/inventory/pricing/* (todas bajo el mismo prefijo) ─────────────
    if (parts[2] === 'pricing') {
      const companyId = parseCompanyIdQuery(url, 1);
      if (companyId == null) {
        return fail(res, 'VALIDATION', 'company_id inválido', 400), true;
      }

      // GET /api/inventory/pricing/settings
      if (method === 'GET' && parts[3] === 'settings' && !parts[4]) {
        const data = await pricingService.getPricingSettings(companyId);
        return ok(res, data), true;
      }

      // PATCH /api/inventory/pricing/settings/financial
      if (method === 'PATCH' && parts[3] === 'settings' && parts[4] === 'financial' && !parts[5]) {
        const body = await readBody(req);
        const parsed = FinancialSettingsPatchSchema.safeParse(body);
        if (!parsed.success) {
          return fail(res, 'VALIDATION', parsed.error.issues[0]?.message || 'Body inválido', 400), true;
        }
        try {
          const row = await pricingService.patchFinancialSettings(companyId, parsed.data);
          return ok(res, { financial_settings: row }), true;
        } catch (e) {
          if (e && e.code === 'NOT_FOUND') {
            return fail(res, 'NOT_FOUND', e.message, 404), true;
          }
          if (e && e.code === 'VALIDATION') {
            return fail(res, 'VALIDATION', e.message, 400), true;
          }
          throw e;
        }
      }

      // PATCH /api/inventory/pricing/settings/policy/:channel
      if (method === 'PATCH' && parts[3] === 'settings' && parts[4] === 'policy' && parts[5]) {
        const channel = decodeURIComponent(parts[5]);
        const body = await readBody(req);
        const parsed = PolicyChannelPatchSchema.safeParse(body);
        if (!parsed.success) {
          return fail(res, 'VALIDATION', parsed.error.issues[0]?.message || 'Body inválido', 400), true;
        }
        try {
          const row = await pricingService.patchPricingPolicyGlobal(companyId, channel, parsed.data);
          return ok(res, { pricing_policy: row }), true;
        } catch (e) {
          if (e && e.code === 'NOT_FOUND') {
            return fail(res, 'NOT_FOUND', e.message, 404), true;
          }
          if (e && e.code === 'VALIDATION') {
            return fail(res, 'VALIDATION', e.message, 400), true;
          }
          throw e;
        }
      }

      // PATCH /api/inventory/pricing/settings/payment/:paymentCode
      if (method === 'PATCH' && parts[3] === 'settings' && parts[4] === 'payment' && parts[5]) {
        const paymentCode = decodeURIComponent(parts[5]);
        const body = await readBody(req);
        const parsed = PaymentSettingPatchSchema.safeParse(body);
        if (!parsed.success) {
          return fail(res, 'VALIDATION', parsed.error.issues[0]?.message || 'Body inválido', 400), true;
        }
        try {
          const row = await pricingService.patchPaymentMethodSetting(companyId, paymentCode, parsed.data);
          return ok(res, { payment_method_setting: row }), true;
        } catch (e) {
          if (e && e.code === 'NOT_FOUND') {
            return fail(res, 'NOT_FOUND', e.message, 404), true;
          }
          if (e && e.code === 'VALIDATION') {
            return fail(res, 'VALIDATION', e.message, 400), true;
          }
          throw e;
        }
      }

      // GET /api/inventory/pricing/spread-alert
      if (method === 'GET' && parts[3] === 'spread-alert' && !parts[4]) {
        const data = await pricingService.getSpreadAlertOverview(companyId);
        return ok(res, data), true;
      }

      // GET /api/inventory/pricing/prices — listado paginado
      if (method === 'GET' && parts[3] === 'prices' && !parts[4]) {
        const sp = url.searchParams;
        const channel = sp.get('channel')?.trim() || undefined;
        const search = sp.get('search')?.trim() || undefined;
        const page = sp.get('page') || '1';
        const limit = sp.get('limit') || '50';
        try {
          const data = await pricingService.listProductPrices({
            companyId,
            channel,
            search,
            page,
            limit,
          });
          return ok(res, data), true;
        } catch (e) {
          if (e && e.code === 'VALIDATION') {
            return fail(res, 'VALIDATION', e.message || 'Validación fallida', 400), true;
          }
          throw e;
        }
      }

      // POST /api/inventory/pricing/run
      if (method === 'POST' && parts[3] === 'run' && !parts[4]) {
        const body = await readBody(req);
        const parsed = PricingRunSchema.safeParse(body);
        if (!parsed.success) {
          return fail(res, 'VALIDATION', parsed.error.issues[0]?.message || 'Body inválido', 400), true;
        }
        const runCompanyId = parsed.data.company_id ?? 1;
        try {
          const summary = await pricingService.runPricingUpdate({
            companyId: runCompanyId,
            channels: [parsed.data.channel],
          });
          return ok(res, summary), true;
        } catch (e) {
          if (e instanceof pricingService.PricingError) {
            const code = e.code;
            const status =
              code === pricingService.PRICING_ERROR_CODES.NO_RATE_TODAY ||
              code === pricingService.PRICING_ERROR_CODES.NO_FINANCIAL_SETTINGS
                ? 503
                : 400;
            return fail(res, code, e.message || code, status), true;
          }
          throw e;
        }
      }

      return fail(res, 'NOT_FOUND', `Ruta no encontrada: ${method} ${pathname}`, 404), true;
    }

    // GET /api/inventory/category-products (respaldo; en server.js debe ir antes de este handler).
    if (method === 'GET' && pathname === '/api/inventory/category-products') {
      const data = await svc.listCategoryProducts();
      return ok(res, data), true;
    }

    // GET /api/inventory/manufacturers?q=&limit=
    // Por defecto lee PostgreSQL. Si INVENTORY_MANUFACTURERS_PROXY_URL está definida, reenvía GET al upstream (ver load-env-local.js).
    if (method === 'GET' && pathname === '/api/inventory/manufacturers') {
      const proxyUrl = process.env.INVENTORY_MANUFACTURERS_PROXY_URL;
      if (proxyUrl != null && String(proxyUrl).trim() !== '') {
        const base = String(proxyUrl).trim();
        let upstream;
        try {
          const u = new URL(base);
          for (const [k, v] of url.searchParams) {
            if (v === '') u.searchParams.delete(k);
            else u.searchParams.set(k, v);
          }
          upstream = u.toString();
        } catch {
          return fail(
            res,
            'PROXY_CONFIG',
            'INVENTORY_MANUFACTURERS_PROXY_URL debe ser una URL absoluta válida (https://host/...)',
            500
          ), true;
        }
        const secret =
          process.env.INVENTORY_MANUFACTURERS_PROXY_SECRET ||
          req.headers['x-admin-secret'] ||
          process.env.ADMIN_SECRET ||
          '';
        const headers = { Accept: 'application/json' };
        if (secret) headers['X-Admin-Secret'] = secret;
        let r;
        try {
          r = await fetch(upstream, { method: 'GET', headers });
        } catch (err) {
          return fail(
            res,
            'PROXY_UPSTREAM',
            `No se pudo contactar INVENTORY_MANUFACTURERS_PROXY_URL: ${err.message}`,
            502
          ), true;
        }
        const text = await r.text();
        let body;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          return fail(res, 'PROXY_INVALID', 'Upstream no devolvió JSON válido', 502), true;
        }
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
        return true;
      }
      const q = url.searchParams.get('q') || undefined;
      const limRaw = url.searchParams.get('limit');
      const data = await svc.listManufacturers({
        q,
        limit: limRaw != null && String(limRaw).trim() !== '' ? Number(limRaw) : undefined,
      });
      return ok(res, { manufacturers: data }), true;
    }

    // POST /api/inventory/category-products — creación con sku_prefix mnemotécnico o manual
    if (method === 'POST' && pathname === '/api/inventory/category-products') {
      const body = await readBody(req);
      const parsed = CategoryProductCreateSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      const d = parsed.data;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let resolved;
        try {
          resolved = await skuPrefixService.resolveSkuPrefixForSave({
            table: 'category_products',
            name: d.category_descripcion.trim(),
            manualPrefix: d.sku_prefix,
            client,
          });
        } catch (pe) {
          await client.query('ROLLBACK');
          if (pe && pe.code === 'SKU_PREFIX_CONFLICT') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                code: 'SKU_PREFIX_CONFLICT',
                message: pe.message,
                suggested_prefix: pe.suggested_prefix,
              },
            }));
            return true;
          }
          if (pe && pe.code === 'INVALID_SKU_PREFIX_FORMAT') {
            return fail(res, 'INVALID_SKU_PREFIX', pe.message, 422), true;
          }
          throw pe;
        }
        const { rows } = await client.query(
          `INSERT INTO category_products (category_descripcion, category_ml, sku_prefix)
           VALUES ($1, $2, $3)
           RETURNING id, category_descripcion, category_ml, sku_prefix`,
          [d.category_descripcion.trim(), d.category_ml ?? null, resolved.sku_prefix]
        );
        await client.query('COMMIT');
        return ok(res, {
          category: rows[0],
          prefix_meta: {
            source: resolved.source,
            suggested_mnemonic: resolved.suggested_mnemonic,
          },
        }, 201), true;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e && e.code === '42703') {
          return fail(res, 'SCHEMA_MISSING', 'Columna sku_prefix: npm run db:sku-prefixes', 503), true;
        }
        throw e;
      } finally {
        client.release();
      }
    }

    // POST /api/inventory/product-subcategories
    if (method === 'POST' && pathname === '/api/inventory/product-subcategories') {
      const body = await readBody(req);
      const parsed = ProductSubcategoryCreateSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      const d = parsed.data;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cat = await client.query('SELECT 1 FROM category_products WHERE id = $1', [d.category_id]);
        if (!cat.rowCount) {
          await client.query('ROLLBACK');
          return fail(res, 'NOT_FOUND', 'category_id no existe en category_products', 404), true;
        }
        let resolved;
        try {
          resolved = await skuPrefixService.resolveSkuPrefixForSave({
            table: 'product_subcategories',
            name: d.name.trim(),
            manualPrefix: d.sku_prefix,
            client,
          });
        } catch (pe) {
          await client.query('ROLLBACK');
          if (pe && pe.code === 'SKU_PREFIX_CONFLICT') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                code: 'SKU_PREFIX_CONFLICT',
                message: pe.message,
                suggested_prefix: pe.suggested_prefix,
              },
            }));
            return true;
          }
          if (pe && pe.code === 'INVALID_SKU_PREFIX_FORMAT') {
            return fail(res, 'INVALID_SKU_PREFIX', pe.message, 422), true;
          }
          throw pe;
        }
        const sort = d.sort_order != null ? d.sort_order : 0;
        const { rows } = await client.query(
          `INSERT INTO product_subcategories (category_id, name, sort_order, sku_prefix)
           VALUES ($1, $2, $3, $4)
           RETURNING id, category_id, name, sort_order, sku_prefix`,
          [d.category_id, d.name.trim(), sort, resolved.sku_prefix]
        );
        await client.query('COMMIT');
        return ok(res, {
          subcategory: rows[0],
          prefix_meta: {
            source: resolved.source,
            suggested_mnemonic: resolved.suggested_mnemonic,
          },
        }, 201), true;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e && e.code === '42703') {
          return fail(res, 'SCHEMA_MISSING', 'Columna sku_prefix: npm run db:sku-prefixes', 503), true;
        }
        throw e;
      } finally {
        client.release();
      }
    }

    // GET /api/inventory/subcategories?category_id=<id>
    if (method === 'GET' && pathname === '/api/inventory/subcategories') {
      const raw = url.searchParams.get('category_id');
      const categoryId = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return fail(res, 'INVALID_CATEGORY_ID', 'category_id es obligatorio y debe ser numérico', 400), true;
      }
      try {
        const data = await svc.listProductSubcategoriesByCategoryId(categoryId);
        return ok(res, data), true;
      } catch (e) {
        if (e && e.code === '42P01') {
          return fail(
            res,
            'TABLE_NOT_FOUND',
            'No existe la tabla product_subcategories. Ejecuta npm run db:product-subcategories.',
            503
          ), true;
        }
        throw e;
      }
    }

    // GET /api/inventory/products/search?q=...
    if (method === 'GET' && pathname === '/api/inventory/products/search') {
      const q = url.searchParams.get('q') || '';
      if (!q) return fail(res, 'MISSING_QUERY', 'Parámetro q requerido'), true;
      const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
      const companyId = parseCompanyIdQuery(url, 1);
      const rows = await svc.searchProducts(q, { limit });
      let quoteFx = null;
      let bin = null;
      try {
        quoteFx = await getTodayRate(companyId);
        if (quoteFx && Number(quoteFx.binance_rate) > 0) {
          bin = Number(quoteFx.binance_rate);
        }
      } catch (_e) {
        quoteFx = null;
      }
      const products = rows.map((p) => {
        const usd = p.unit_price_usd != null ? Number(p.unit_price_usd) : null;
        const unitPriceBsQuote =
          bin != null && usd != null && Number.isFinite(usd)
            ? Math.round(usd * bin * 100) / 100
            : null;
        return { ...p, unit_price_bs_quote: unitPriceBsQuote };
      });
      return ok(res, {
        products,
        quote_fx: quoteFx
          ? {
              company_id: companyId,
              rate_date: quoteFx.rate_date,
              binance_rate: quoteFx.binance_rate != null ? Number(quoteFx.binance_rate) : null,
              bcv_rate: quoteFx.bcv_rate != null ? Number(quoteFx.bcv_rate) : null,
              active_rate: quoteFx.active_rate != null ? Number(quoteFx.active_rate) : null,
              active_rate_type: quoteFx.active_rate_type || null,
            }
          : null,
      }), true;
    }

    // POST /api/inventory/products/deactivate  body: { product_id } (preferido; evita rutas anidadas raras)
    if (method === 'POST' && pathname === '/api/inventory/products/deactivate') {
      const body = await readBody(req);
      const productId = parsePositiveIntId(body?.product_id);
      if (productId == null) return fail(res, 'VALIDATION', 'product_id requerido y entero >= 1', 400), true;
      const data = await svc.deactivateProduct(productId);
      if (!data) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
      return ok(res, data), true;
    }

    // POST /api/inventory/products — crear producto + inventario (SKU vía allocateNextSku en la misma TX)
    if (method === 'POST' && pathname === '/api/inventory/products') {
      const rawBody = await readBody(req);
      const body = { ...rawBody };
      if (Object.prototype.hasOwnProperty.call(body, 'brand_id')) {
        // products.brand_id en BD = crm_vehicle_brands; el cliente debe enviar vehicle_brand_id.
        console.warn(
          '[inventory-api] POST /api/inventory/products: se ignora brand_id del body; usar vehicle_brand_id (crm_vehicle_brands).'
        );
        delete body.brand_id;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'category_id')) {
        console.warn(
          '[inventory-api] POST /api/inventory/products: se ignora category_id; se deriva de subcategory_id.'
        );
        delete body.category_id;
      }
      const parsed = ProductCreateSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      try {
        const data = await svc.createProductWithAllocatedSku(parsed.data);
        return ok(res, data, 201), true;
      } catch (e) {
        const code = e && e.code;
        const msg = (e && e.message) || 'Error al crear producto';
        if (code === 'VALIDATION' || code === 'INVALID_IDS') {
          return fail(res, code === 'INVALID_IDS' ? 'INVALID_IDS' : 'VALIDATION', msg, 400), true;
        }
        if (
          code === 'OEM_INVALID' ||
          code === 'SUBCATEGORY_NOT_FOUND' ||
          code === 'MANUFACTURER_NOT_FOUND'
        ) {
          return fail(res, code, msg, 400), true;
        }
        if (code === 'DUPLICATE_OEM') {
          return fail(res, 'DUPLICATE_OEM', msg, 409), true;
        }
        if (code === 'PREFIX_LOOKUP_FAILED') {
          return fail(res, 'PREFIX_LOOKUP_FAILED', msg, 404), true;
        }
        if (
          code === 'MISSING_PREFIX' ||
          code === 'INVALID_PREFIX_SS' ||
          code === 'INVALID_PREFIX_SSS' ||
          code === 'INVALID_PREFIX_MMM'
        ) {
          return fail(res, code, msg, 422), true;
        }
        if (code === 'SKU_COUNTER_EXHAUSTED' || code === 'DUPLICATE_SKU') {
          return fail(res, code, msg, 409), true;
        }
        if (e && e.code === '42P01') {
          return fail(
            res,
            'TABLE_NOT_FOUND',
            'Falta una tabla de catálogo (p. ej. product_subcategories). Revisa migraciones.',
            503
          ), true;
        }
        if (e && e.code === '42703') {
          return fail(res, 'SCHEMA_MISSING', 'Esquema incompleto (columnas). Ejecuta migraciones de inventario/sku.', 503), true;
        }
        throw e;
      }
    }

    // GET /api/inventory/products/:id
    // PATCH /api/inventory/products/:id/stock
    // PATCH /api/inventory/products/:id/config
    if (parts[2] === 'products' && parts[3] && parts[3] !== 'search') {
      const productId = parsePositiveIntId(parts[3]);
      if (productId == null) return fail(res, 'INVALID_ID', 'ID inválido (entero >= 1)', 400), true;

      // PATCH /api/inventory/products/:id/stock
      if (method === 'PATCH' && parts[4] === 'stock') {
        const body = await readBody(req);
        const parsed = StockAdjustSchema.safeParse(body);
        if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
        const data = await svc.adjustStock(productId, parsed.data);
        return ok(res, data), true;
      }

      // PATCH /api/inventory/products/:id/config
      if (method === 'PATCH' && parts[4] === 'config') {
        const body = await readBody(req);
        const parsed = ProductConfigSchema.safeParse(body);
        if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
        const data = await svc.updateProductConfig(productId, parsed.data);
        return ok(res, data), true;
      }

      // PATCH /api/inventory/products/:id  (nombre, descripción, categoría, marca, precio, stock)
      if (method === 'PATCH' && !parts[4]) {
        const body = await readBody(req);
        const parsed = ProductPatchSchema.safeParse(body);
        if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
        try {
          const data = await svc.updateProductById(productId, parsed.data);
          if (!data) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
          return ok(res, data), true;
        } catch (e) {
          if (e && e.code === 'EMPTY_UPDATE') {
            return fail(res, 'VALIDATION', e.message || 'Nada que actualizar', 400), true;
          }
          if (e && e.code === 'SKU_IMMUTABLE') {
            return fail(res, 'SKU_IMMUTABLE', e.message || 'El SKU no puede modificarse', 409), true;
          }
          throw e;
        }
      }

      // PATCH /api/inventory/products/:id/identity — reclasificación con verificación de movimientos
      if (method === 'PATCH' && parts[4] === 'identity') {
        const body = await readBody(req);
        const parsed = ProductIdentitySchema.safeParse(body);
        if (!parsed.success) return fail(res, 'VALIDATION_ERROR', parsed.error.issues[0].message, 400), true;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // PASO 1 — SELECT con bloqueo
          const { rows: prodRows } = await client.query(
            `SELECT id, sku, brand_id, subcategory_id, category_id
             FROM products WHERE id = $1 FOR UPDATE`,
            [productId]
          );
          if (!prodRows.length) {
            await client.query('ROLLBACK');
            return fail(res, 'PRODUCT_NOT_FOUND', 'Producto no encontrado', 404), true;
          }
          const prod = prodRows[0];

          // PASO 2 — Detectar cambio real
          const d = parsed.data;
          const changed =
            (d.brand_id       !== undefined && d.brand_id       !== prod.brand_id)       ||
            (d.subcategory_id !== undefined && d.subcategory_id !== prod.subcategory_id) ||
            (d.category_id    !== undefined && d.category_id    !== prod.category_id);

          if (!changed) {
            await client.query('COMMIT');
            const data = await svc.getProductById(productId);
            return ok(res, data), true;
          }

          // PASO 3 — Verificar movimientos
          const mvRes = await client.query(
            `SELECT EXISTS (
              SELECT 1 FROM stock_movements
                WHERE product_id = $1
              UNION ALL
              SELECT 1 FROM sale_lines
                WHERE product_sku = $2
              UNION ALL
              SELECT 1 FROM purchase_lines
                WHERE product_sku = $2
              UNION ALL
              SELECT 1 FROM ml_order_reservations
                WHERE producto_sku = $2 AND status != 'RELEASED'
              UNION ALL
              SELECT 1 FROM ml_order_items
                WHERE product_sku = $2 AND reservation_status != 'NO_SKU_MAP'
              UNION ALL
              SELECT 1 FROM bin_stock
                WHERE product_sku = $2 AND qty_available > 0
              UNION ALL
              SELECT 1 FROM product_lots
                WHERE producto_sku = $2 AND status != 'EXHAUSTED'
            ) AS has_movements`,
            [prod.id, prod.sku]
          );

          // PASO 4 — Evaluar has_movements
          if (mvRes.rows[0].has_movements) {
            await client.query('ROLLBACK');
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                code: 'CONFLICT_PRODUCT_HAS_MOVEMENTS',
                message: 'El producto tiene movimientos. No se puede cambiar su identidad.',
              },
              product_id:    prod.id,
              sku:           prod.sku,
              blocked_fields: ['brand_id', 'subcategory_id', 'category_id'],
              duplicate_url: `/api/inventory/products/${prod.id}/duplicate`,
            }));
            return true;
          }

          // PASO 5 — Actualizar identidad, propagar SKU, regenerar SKU
          const finalBrandId       = d.brand_id       ?? prod.brand_id;
          const finalSubcategoryId = d.subcategory_id ?? prod.subcategory_id;
          const finalCategoryId    = d.category_id    ?? prod.category_id;

          // Validar que los IDs de identidad no sean NULL antes de generar SKU
          if (!finalSubcategoryId || !finalBrandId) {
            await client.query('ROLLBACK');
            return fail(res, 'MISSING_IDENTITY',
              'El producto no tiene marca o subcategoría. Asigna ambos campos.', 422), true;
          }

          // 5a — UPDATE identidad en products
          await client.query(
            `UPDATE products
             SET brand_id = $2, subcategory_id = $3, category_id = $4, updated_at = NOW()
             WHERE id = $1`,
            [productId, finalBrandId, finalSubcategoryId, finalCategoryId]
          );

          // 5b — Generar nuevo SKU (dentro de la misma TX con client)
          let newSku;
          try {
            newSku = await allocateNextSku(client, finalSubcategoryId, finalBrandId);
          } catch (skuErr) {
            await client.query('ROLLBACK');
            const skuCode = skuErr && skuErr.code;
            if (skuCode === 'PREFIX_LOOKUP_FAILED') return fail(res, skuCode, skuErr.message, 404), true;
            if (skuCode === 'MISSING_PREFIX' || (skuCode && skuCode.startsWith('INVALID_PREFIX'))) {
              return fail(res, skuCode, skuErr.message, 422), true;
            }
            if (skuCode === 'SKU_COUNTER_EXHAUSTED') return fail(res, skuCode, skuErr.message, 409), true;
            throw skuErr;
          }

          const oldSku = prod.sku;

          // 5c — Propagar oldSku → newSku en todas las tablas con FK/ref a products(sku) PRIMERO
          const propagateTables = [
            ['sale_lines',            'product_sku',  'product_sku'],
            ['purchase_lines',        'product_sku',  'product_sku'],
            ['bin_stock',             'product_sku',  'product_sku'],
            ['stock_movements_audit', 'product_sku',  'product_sku'],
            ['import_shipment_lines', 'product_sku',  'product_sku'],
            ['landed_cost_audit',     'product_sku',  'product_sku'],
            ['ml_order_reservations', 'producto_sku', 'producto_sku'],
            ['ml_order_items',        'product_sku',  'product_sku'],
            ['product_lots',          'producto_sku', 'producto_sku'],
            ['count_lines',           'product_sku',  'product_sku'],
            ['motor_compatibility',   'product_sku',  'product_sku'],
            ['valve_specs',           'product_sku',  'product_sku'],
            ['ml_item_sku_map',       'product_sku',  'product_sku'],
          ];
          for (const [table, setCol, whereCol] of propagateTables) {
            await client.query(
              `UPDATE ${table} SET ${setCol} = $1 WHERE ${whereCol} = $2`,
              [newSku, oldSku]
            );
          }

          // 5d — Actualizar SKU en products DESPUÉS de propagar hijos (evita violación FK inmediata)
          await client.query(
            `UPDATE products SET sku = $1, updated_at = NOW() WHERE id = $2`,
            [newSku, productId]
          );

          await client.query('COMMIT');
          const data = await svc.getProductById(productId);
          return ok(res, data), true;

        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // POST /api/inventory/products/:id/price-adjustment — ajuste de precio con historial
      // Auth: ya pasó catalog:write al inicio del handler; no exigir settings (muchos SUPERVISOR no lo tienen).
      if (method === 'POST' && parts[4] === 'price-adjustment') {
        const auditUser = await checkAdminSecretOrJwt(req, res);
        if (!auditUser) return true;
        const body = await readBody(req);
        const parsed = PriceAdjustmentSchema.safeParse(body);
        if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
        const meta = {
          userId:   auditUser.userId != null ? Number(auditUser.userId) : null,
          userName: auditUser.username != null ? String(auditUser.username) : null,
          reason:   parsed.data.reason   ?? null,
          source:   'ui',
        };
        const result = await svc.addPriceAdjustment(productId, parsed.data.unit_price_usd, meta);
        if (!result) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
        return ok(res, result), true;
      }

      // GET /api/inventory/products/:id/price-history — historial de ajustes de precio
      if (method === 'GET' && parts[4] === 'price-history') {
        const qs = req.url ? new URL(req.url, 'http://localhost').searchParams : new URLSearchParams();
        const limit  = Math.min(Number(qs.get('limit')  ?? 50), 200);
        const offset = Math.max(Number(qs.get('offset') ?? 0),  0);
        const data = await svc.getPriceHistory(productId, { limit, offset });
        return ok(res, data), true;
      }

      // POST /api/inventory/products/:id/duplicate — copia superficial con nuevo SKU
      if (method === 'POST' && parts[4] === 'duplicate') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // PASO 1 — Obtener producto original + datos de inventory
          const { rows: origRows } = await client.query(
            `SELECT id, sku, name, description, unit_price_usd, landed_cost_usd,
                    brand_id, subcategory_id, category_id, unit_type, company_id
             FROM products WHERE id = $1`,
            [productId]
          );
          if (!origRows.length) {
            await client.query('ROLLBACK');
            return fail(res, 'PRODUCT_NOT_FOUND', 'Producto no encontrado', 404), true;
          }
          const orig = origRows[0];

          const { rows: invRows } = await client.query(
            `SELECT supplier_id, stock_min FROM inventory WHERE product_id = $1`,
            [productId]
          );
          const inv = invRows[0] || { supplier_id: null, stock_min: 0 };

          // NULL guard: brand_id y subcategory_id son obligatorios para generar SKU
          if (!orig.subcategory_id || !orig.brand_id) {
            await client.query('ROLLBACK');
            return fail(res, 'MISSING_IDENTITY',
              'El producto no tiene marca o subcategoría. Usa /identity primero.', 422), true;
          }

          // PASO 2 — Generar nuevo SKU
          let newSku;
          try {
            newSku = await allocateNextSku(client, orig.subcategory_id, orig.brand_id);
          } catch (skuErr) {
            await client.query('ROLLBACK');
            const skuCode = skuErr && skuErr.code;
            if (skuCode === 'PREFIX_LOOKUP_FAILED') return fail(res, skuCode, skuErr.message, 404), true;
            if (skuCode === 'MISSING_PREFIX' || (skuCode && skuCode.startsWith('INVALID_PREFIX'))) {
              return fail(res, skuCode, skuErr.message, 422), true;
            }
            if (skuCode === 'SKU_COUNTER_EXHAUSTED') return fail(res, skuCode, skuErr.message, 409), true;
            throw skuErr;
          }

          // PASO 3 — INSERT en products
          const { rows: newProdRows } = await client.query(
            `INSERT INTO products (
               sku, name, description, unit_price_usd, landed_cost_usd,
               brand_id, subcategory_id, category_id, unit_type, company_id,
               source, is_active
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',FALSE)
             RETURNING id`,
            /* is_active = FALSE → producto en borrador hasta que el usuario lo active.
               Cuando se implemente status TEXT ('draft'|'active'|'inactive'), reemplazar
               este flag por source='manual', status='draft', is_active=TRUE. */
            [
              newSku,
              orig.name,
              orig.description,
              orig.unit_price_usd,
              orig.landed_cost_usd,
              orig.brand_id,
              orig.subcategory_id,
              orig.category_id,
              orig.unit_type,
              orig.company_id,
            ]
          );
          const newProductId = newProdRows[0].id;

          // PASO 4 — INSERT en inventory (obligatorio: sin él getProductById no encuentra el producto)
          await client.query(
            `INSERT INTO inventory (product_id, supplier_id, stock_qty, stock_min, stock_alert)
             VALUES ($1, $2, 0, 0, FALSE)`,
            [newProductId, inv.supplier_id]
          );

          await client.query('COMMIT');
          const data = await svc.getProductById(newProductId);
          return ok(res, data, 201), true;

        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // POST /api/inventory/products/:id/deactivate (misma baja lógica; útil si DELETE no llega al servidor)
      if (method === 'POST' && parts[4] === 'deactivate') {
        const data = await svc.deactivateProduct(productId);
        if (!data) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
        return ok(res, data), true;
      }

      // DELETE /api/inventory/products/:id (baja lógica is_active = false)
      if (method === 'DELETE' && !parts[4]) {
        const data = await svc.deactivateProduct(productId);
        if (!data) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
        return ok(res, data), true;
      }

      // GET /api/inventory/products/:id  (después de PATCH :id sin subruta)
      if (method === 'GET' && !parts[4]) {
        const data = await svc.getProductById(productId);
        if (!data) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
        return ok(res, data), true;
      }
    }

    // GET /api/inventory/products
    if (method === 'GET' && pathname === '/api/inventory/products') {
      const sp     = url.searchParams;
      const alertV = sp.get('alert');
      const search = sp.get('search')?.trim() || undefined;
      const rawSearchBy = sp.get('search_by') || '';
      const searchBy = rawSearchBy === 'name' || rawSearchBy === 'sku' ? rawSearchBy : undefined;
      const maxLimit = search ? 500 : 200;
      const rawLimit = Number(sp.get('limit') || (search ? 200 : 50));
      const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50), maxLimit);
      const data   = await svc.listProducts({
        limit,
        offset:   Number(sp.get('offset') || 0),
        alert:    alertV !== null ? alertV === 'true' : undefined,
        category: sp.get('category') || undefined,
        brand:    sp.get('brand')    || undefined,
        search,
        searchBy,
      });
      return ok(res, data), true;
    }

    // ── GRUPO 2 — Proyecciones ─────────────────────────────────────────────

    // POST /api/inventory/projections/recalculate
    if (method === 'POST' && pathname === '/api/inventory/projections/recalculate') {
      const { calculateProjections } = require('../workers/inventoryWorker');
      setImmediate(async () => {
        try { await calculateProjections(); } catch (_) { /* background */ }
      });
      return ok(res, { message: 'Recálculo iniciado en background' }), true;
    }

    // GET /api/inventory/projections/stockouts
    if (method === 'GET' && pathname === '/api/inventory/projections/stockouts') {
      const days = Math.min(Number(url.searchParams.get('days') || 30), 365);
      const data = await svc.getStockouts({ days });
      return ok(res, data), true;
    }

    // GET /api/inventory/projections/:id
    if (method === 'GET' && parts[2] === 'projections' && parts[3] && parts[3] !== 'stockouts') {
      const productId = parsePositiveIntId(parts[3]);
      if (productId == null) return fail(res, 'INVALID_ID', 'ID inválido (entero >= 1)', 400), true;
      const data = await svc.getProjectionByProductId(productId);
      if (!data) return fail(res, 'NOT_FOUND', 'Proyección no encontrada', 404), true;
      return ok(res, data), true;
    }

    // GET /api/inventory/projections
    if (method === 'GET' && pathname === '/api/inventory/projections') {
      const sp   = url.searchParams;
      const data = await svc.listProjections({
        limit:  Math.min(Number(sp.get('limit')  || 50), 200),
        offset: Number(sp.get('offset') || 0),
      });
      return ok(res, data), true;
    }

    // ── GRUPO 3 — Órdenes de Compra ────────────────────────────────────────

    // POST /api/inventory/purchase-orders/generate
    if (method === 'POST' && pathname === '/api/inventory/purchase-orders/generate') {
      const body   = await readBody(req);
      const parsed = GeneratePOSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      const orderId = await generateSuggestedPurchaseOrder(parsed.data.supplier_id || null);
      if (!orderId) return ok(res, { message: 'Sin SKUs con alerta activa — orden no generada', order_id: null }), true;
      const order = await svc.getPurchaseOrderById(orderId);
      return ok(res, order, 201), true;
    }

    // PATCH /api/inventory/purchase-orders/:id/status
    if (method === 'PATCH' && parts[2] === 'purchase-orders' && parts[3] && parts[4] === 'status') {
      const orderId = Number(parts[3]);
      if (!orderId) return fail(res, 'INVALID_ID', 'ID inválido'), true;
      const body   = await readBody(req);
      const parsed = POStatusSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      const data = await svc.updatePurchaseOrderStatus(orderId, parsed.data);
      return ok(res, data), true;
    }

    // GET /api/inventory/purchase-orders/:id
    if (method === 'GET' && parts[2] === 'purchase-orders' && parts[3]) {
      const orderId = Number(parts[3]);
      if (!orderId) return fail(res, 'INVALID_ID', 'ID inválido'), true;
      const data = await svc.getPurchaseOrderById(orderId);
      if (!data) return fail(res, 'NOT_FOUND', 'Orden no encontrada', 404), true;
      return ok(res, data), true;
    }

    // POST /api/inventory/purchase-orders
    if (method === 'POST' && pathname === '/api/inventory/purchase-orders') {
      const body   = await readBody(req);
      const parsed = CreatePOSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      const data = await svc.createPurchaseOrder(parsed.data);
      return ok(res, data, 201), true;
    }

    // GET /api/inventory/purchase-orders
    if (method === 'GET' && pathname === '/api/inventory/purchase-orders') {
      const sp   = url.searchParams;
      const data = await svc.listPurchaseOrders({
        limit:  Math.min(Number(sp.get('limit')  || 50), 200),
        offset: Number(sp.get('offset') || 0),
        status: sp.get('status') || undefined,
      });
      return ok(res, data), true;
    }

    // ── GRUPO 4 — Proveedores ──────────────────────────────────────────────

    // PATCH /api/inventory/suppliers/:id
    if (method === 'PATCH' && parts[2] === 'suppliers' && parts[3]) {
      const sId  = Number(parts[3]);
      if (!sId) return fail(res, 'INVALID_ID', 'ID inválido'), true;
      const body = await readBody(req);
      const data = await svc.updateSupplier(sId, body);
      return ok(res, data), true;
    }

    // POST /api/inventory/suppliers
    if (method === 'POST' && pathname === '/api/inventory/suppliers') {
      const body   = await readBody(req);
      const parsed = SupplierSchema.safeParse(body);
      if (!parsed.success) return fail(res, 'VALIDATION', parsed.error.issues[0].message), true;
      const data = await svc.createSupplier(parsed.data);
      return ok(res, data, 201), true;
    }

    // GET /api/inventory/suppliers
    if (method === 'GET' && pathname === '/api/inventory/suppliers') {
      const data = await svc.listSuppliers();
      return ok(res, { suppliers: data }), true;
    }

    // Ruta no encontrada dentro del prefijo
    fail(res, 'NOT_FOUND', `Ruta no encontrada: ${method} ${pathname}`, 404);
    return true;

  } catch (err) {
    if (err.code === 'NOT_FOUND')           return fail(res, 'NOT_FOUND',        err.message, 404), true;
    if (err.code === 'INVALID_TRANSITION')  return fail(res, 'INVALID_TRANSITION', err.message, 422), true;
    if (err.code === 'NEGATIVE_STOCK')      return fail(res, 'NEGATIVE_STOCK',   err.message, 422), true;
    if (err.code === 'ALREADY_JUSTIFIED')   return fail(res, 'ALREADY_JUSTIFIED', err.message, 409), true;
    if (err.code === 'INVALID_JSON')        return fail(res, 'INVALID_JSON',      'JSON inválido en el cuerpo', 400), true;
    console.error('[inventoryApiHandler]', err.message);
    fail(res, 'INTERNAL_ERROR', 'Error interno del servidor', 500);
    return true;
  }
}

module.exports = { handleInventoryApiRequest };
