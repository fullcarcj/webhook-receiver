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

const requestActionSchema = z.object({
  ml_item_id: z.string().min(3),
  action_type: z.enum(['pause', 'activate', 'price_update', 'close']),
  reason: z.string().min(5).max(500),
  requested_by: z.enum(['Jesus', 'Sebastian', 'Javier']),
  payload: z.object({
    new_price_usd: z.number().positive().optional(),
  }).optional(),
});

const reviewActionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reviewed_by: z.enum(['Javier', 'supervisor']),
  rejection_reason: z.string().min(5).optional(),
}).refine((v) => v.decision === 'approved' || !!v.rejection_reason, {
  message: 'rejection_reason requerido al rechazar',
});

const autoPauseConfigSchema = z.object({
  auto_pause_enabled: z.boolean(),
  updated_by: z.enum(['Javier', 'supervisor']),
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
    if (method === 'GET' && path === '/api/ml/publications') {
      const { limit, offset } = parsePagination(url);
      const out = await svc.listPublications({
        status: url.searchParams.get('status') || null,
        localStatus: url.searchParams.get('local_status') || null,
        search: url.searchParams.get('q') || null,
        onlyZeroStock: url.searchParams.get('zero_stock') === '1',
        limit,
        offset,
      });
      return ok(res, out);
    }

    if (method === 'GET' && path === '/api/ml/publications/paused') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.getPausedPublications({ limit, offset }));
    }

    if (method === 'GET' && path === '/api/ml/publications/zero-stock') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.getZeroStockPublications({ limit, offset }));
    }

    if (method === 'POST' && path === '/api/ml/publications/sync') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 300);
      return ok(res, await svc.syncPublicationsStatus(limit));
    }

    if (method === 'GET' && path === '/api/ml/actions/pending') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.listPendingActions({ limit, offset }));
    }

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

    if (method === 'GET' && path === '/api/ml/paused-history') {
      const { limit, offset } = parsePagination(url);
      return ok(res, await svc.listPausedHistory({ limit, offset }));
    }

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
