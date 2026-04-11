'use strict';

const { z } = require('zod');
const { ensureAdmin } = require('../middleware/adminAuth');
const svc = require('../services/mlPublicationsService');

function ok(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ data }));
  return true;
}

function fail(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code, message } }));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (_) { reject(Object.assign(new Error('JSON inválido'), { status: 400, code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

const upsertPublicationSchema = z.object({
  product_id: z.number().int().positive(),
  sku: z.string().min(1),
  ml_item_id: z.string().min(3),
  ml_user_id: z.number().int().positive(),
  ml_title: z.string().optional(),
  ml_status: z.enum(['active', 'paused', 'closed', 'under_review']).optional(),
  stock_qty: z.number().min(0).optional(),
  price_usd: z.number().positive().optional(),
  price_bs: z.number().positive().optional(),
  auto_pause_enabled: z.boolean().optional(),
});

const requestActionSchema = z.object({
  ml_item_id: z.string().min(3),
  action_type: z.enum(['pause', 'activate', 'price_update', 'close']),
  reason: z.string().min(5).max(500),
  requested_by: z.string().min(1).max(100),
  payload: z.object({
    new_price_usd: z.number().positive().optional(),
  }).optional(),
});

const reviewActionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewed_by: z.string().min(1).max(100),
  rejection_reason: z.string().min(5).optional(),
}).refine((v) => v.decision === 'approved' || !!v.rejection_reason, {
  message: 'rejection_reason requerido al rechazar',
});

const autoPauseConfigSchema = z.object({
  auto_pause_enabled: z.boolean(),
  updated_by: z.string().min(1).max(100),
});

const updateStockSchema = z.object({
  stock_qty: z.number().min(0),
  updated_by: z.string().min(1).max(100).optional(),
});

const updatePriceSchema = z.object({
  price_usd: z.number().positive(),
  updated_by: z.string().min(1).max(100).optional(),
});

function parsePagination(url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
  return { limit, offset };
}

async function handleMlApiRequest(req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = url.pathname;

  if (!path.startsWith('/api/ml')) return false;
  if (!ensureAdmin(req, res, url)) return true;

  try {
    // ── Listado de publicaciones ───────────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/publications') {
      const { limit, offset } = parsePagination(url);
      const out = await svc.listPublications({
        status: url.searchParams.get('status') || null,
        localStatus: url.searchParams.get('local_status') || null,
        search: url.searchParams.get('q') || null,
        onlyZeroStock: url.searchParams.get('zero_stock') === '1',
        mlUserId: url.searchParams.get('ml_user_id') ? Number(url.searchParams.get('ml_user_id')) : null,
        limit,
        offset,
      });
      return ok(res, out);
    }

    // ── Alta / upsert de publicación ─────────────────────────────────────
    if (method === 'POST' && path === '/api/ml/publications') {
      const body = await readBody(req);
      const parsed = upsertPublicationSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '));
      const out = await svc.upsertPublication({
        productId: parsed.data.product_id,
        sku: parsed.data.sku,
        mlItemId: parsed.data.ml_item_id,
        mlUserId: parsed.data.ml_user_id,
        mlTitle: parsed.data.ml_title || null,
        mlStatus: parsed.data.ml_status || 'active',
        stockQty: parsed.data.stock_qty ?? 0,
        priceUsd: parsed.data.price_usd ?? null,
        priceBs: parsed.data.price_bs ?? null,
        autoPauseEnabled: parsed.data.auto_pause_enabled !== false,
      });
      return ok(res, out, 201);
    }

    // ── Publicaciones pausadas ────────────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/publications/paused') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.getPausedPublications({ limit, offset }));
    }

    // ── Publicaciones sin stock ────────────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/publications/zero-stock') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.getZeroStockPublications({ limit, offset }));
    }

    // ── Sincronización con API ML ──────────────────────────────────────────
    if (method === 'POST' && path === '/api/ml/publications/sync') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 300);
      return ok(res, await svc.syncPublicationsStatus(limit));
    }

    // ── Acciones pendientes ────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/actions/pending') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.listPendingActions({ limit, offset }));
    }

    // ── Solicitar acción manual ────────────────────────────────────────────
    if (method === 'POST' && path === '/api/ml/actions/request') {
      const body = await readBody(req);
      const parsed = requestActionSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '));
      const out = await svc.requestManualAction({
        mlItemId: parsed.data.ml_item_id,
        actionType: parsed.data.action_type,
        reason: parsed.data.reason,
        requestedBy: parsed.data.requested_by,
        payload: parsed.data.payload || {},
      });
      return ok(res, out, 201);
    }

    // ── Historial de pausas ────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/paused-history') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.listPausedHistory({ limit, offset }));
    }

    // ── Log de llamadas a la API de ML ─────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/api-log') {
      const { limit, offset } = parsePagination(url);
      const successRaw = url.searchParams.get('success');
      const success = successRaw === null ? undefined : successRaw === '1' || /^true$/i.test(successRaw);
      return ok(res, await svc.listApiLog({
        success,
        action: url.searchParams.get('action') || null,
        limit,
        offset,
      }));
    }

    // ── Rutas parametrizadas ───────────────────────────────────────────────

    const pubAutoPauseMatch = path.match(/^\/api\/ml\/publications\/([^/]+)\/auto-pause$/);
    if (method === 'PATCH' && pubAutoPauseMatch) {
      const body = await readBody(req);
      const parsed = autoPauseConfigSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '));
      const mlItemId = decodeURIComponent(pubAutoPauseMatch[1]);
      const out = await svc.setAutoPauseConfig({
        mlItemId,
        autoPauseEnabled: parsed.data.auto_pause_enabled,
        updatedBy: parsed.data.updated_by,
      });
      return ok(res, out);
    }

    const pubStockMatch = path.match(/^\/api\/ml\/publications\/([^/]+)\/stock$/);
    if (method === 'PATCH' && pubStockMatch) {
      const body = await readBody(req);
      const parsed = updateStockSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '));
      const mlItemId = decodeURIComponent(pubStockMatch[1]);
      const out = await svc.updateStockForPublication({
        mlItemId,
        newStock: parsed.data.stock_qty,
        updatedBy: parsed.data.updated_by || 'admin',
      });
      return ok(res, out);
    }

    const pubPriceMatch = path.match(/^\/api\/ml\/publications\/([^/]+)\/price$/);
    if (method === 'PATCH' && pubPriceMatch) {
      const body = await readBody(req);
      const parsed = updatePriceSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '));
      const mlItemId = decodeURIComponent(pubPriceMatch[1]);
      const out = await svc.updatePriceForPublication({
        mlItemId,
        newPriceUsd: parsed.data.price_usd,
        updatedBy: parsed.data.updated_by || 'admin',
      });
      return ok(res, out);
    }

    const reviewMatch = path.match(/^\/api\/ml\/actions\/(\d+)\/review$/);
    if (method === 'POST' && reviewMatch) {
      const actionId = Number(reviewMatch[1]);
      const body = await readBody(req);
      const parsed = reviewActionSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', parsed.error.errors.map((e) => e.message).join(', '));
      const out = await svc.reviewManualAction({
        actionId,
        decision: parsed.data.decision,
        reviewedBy: parsed.data.reviewed_by,
        rejectionReason: parsed.data.rejection_reason || null,
      });
      return ok(res, out);
    }

    const pubDetailMatch = path.match(/^\/api\/ml\/publications\/([^/]+)$/);
    if (method === 'GET' && pubDetailMatch) {
      const mlItemId = decodeURIComponent(pubDetailMatch[1]);
      const pub = await svc.getPublicationByItemId(mlItemId);
      if (!pub) return fail(res, 404, 'NOT_FOUND', 'Publicación no encontrada');
      return ok(res, pub);
    }

    return fail(res, 404, 'NOT_FOUND', `Endpoint ${path} no existe`);
  } catch (err) {
    return fail(res, err.status || 500, err.code || 'INTERNAL_ERROR', err.message || 'Error interno');
  }
}

module.exports = { handleMlApiRequest };
