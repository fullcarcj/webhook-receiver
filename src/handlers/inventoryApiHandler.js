'use strict';
const { z } = require('zod');
const svc   = require('../services/inventoryService');
const { generateSuggestedPurchaseOrder } = require('../workers/inventoryWorker');

// ── Auth + helpers ────────────────────────────────────────────────────────────

function isAdmin(req, url) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  if (req.headers['x-admin-secret'] === secret) return true;
  if (url.searchParams.get('k') === secret) return true;
  return false;
}

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

  if (!isAdmin(req, url)) {
    fail(res, 'UNAUTHORIZED', 'Se requiere X-Admin-Secret', 401);
    return true;
  }

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

    // GET /api/inventory/category-products (respaldo; en server.js debe ir antes de este handler).
    if (method === 'GET' && pathname === '/api/inventory/category-products') {
      const data = await svc.listCategoryProducts();
      return ok(res, data), true;
    }

    // GET /api/inventory/products/search?q=...
    if (method === 'GET' && pathname === '/api/inventory/products/search') {
      const q = url.searchParams.get('q') || '';
      if (!q) return fail(res, 'MISSING_QUERY', 'Parámetro q requerido'), true;
      const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
      const data  = await svc.searchProducts(q, { limit });
      return ok(res, { products: data }), true;
    }

    // POST /api/inventory/products/deactivate  body: { product_id } (preferido; evita rutas anidadas raras)
    if (method === 'POST' && pathname === '/api/inventory/products/deactivate') {
      const body = await readBody(req);
      const productId = Number(body?.product_id);
      if (!productId) return fail(res, 'VALIDATION', 'product_id requerido y numérico', 400), true;
      const data = await svc.deactivateProduct(productId);
      if (!data) return fail(res, 'NOT_FOUND', 'Producto no encontrado', 404), true;
      return ok(res, data), true;
    }

    // GET /api/inventory/products/:id
    // PATCH /api/inventory/products/:id/stock
    // PATCH /api/inventory/products/:id/config
    if (parts[2] === 'products' && parts[3] && parts[3] !== 'search') {
      const productId = Number(parts[3]);
      if (!productId) return fail(res, 'INVALID_ID', 'ID inválido'), true;

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
          throw e;
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
      const productId = Number(parts[3]);
      if (!productId) return fail(res, 'INVALID_ID', 'ID inválido'), true;
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
