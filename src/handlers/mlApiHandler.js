'use strict';

const { z } = require('zod');
const { requireAdminOrPermission } = require('../utils/authMiddleware');
const svc = require('../services/mlPublicationsService');
const { pool } = require('../../db');
const { getAccessTokenForMlUser } = require('../../oauth-token');
const { mlQueuedCall } = require('../utils/mlQueue');

const ML_BASE = process.env.ML_API_BASE || 'https://api.mercadolibre.com';

/** Lectura CRM (preguntas, listings, reputación) vs operaciones admin de catálogo/publicaciones. */
function mlApiPermissionModule(pathname) {
  if (
    pathname === '/api/ml/questions' ||
    pathname === '/api/ml/listings' ||
    pathname === '/api/ml/reputation'
  ) {
    return 'crm';
  }
  return 'settings';
}

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

/**
 * Construye el payload de atributos de compatibilidad para ML y lo envía
 * vía PUT /items/:mlItemId. Actualiza ml_publications.attributes_synced.
 * Lanza error si la publicación no tiene compatibilidades en BD o ML rechaza.
 *
 * @param {{ mlItemId: string, sku: string, mlUserId: number }} opts
 * @returns {{ synced: boolean, attributes_count: number }}
 */
async function _syncAttributesForItem({ mlItemId, sku, mlUserId }) {
  const { rows: compRows } = await pool.query(`
    SELECT vma.name AS make_name,
           vm.name  AS model_name,
           emy.year_from,
           emy.year_to,
           e.engine_code
    FROM motor_compatibility mc
    JOIN engines e             ON e.id  = mc.engine_id
    JOIN engine_model_years emy ON emy.engine_id = e.id
    JOIN vehicle_models vm     ON vm.id = emy.model_id
    JOIN vehicle_makes vma     ON vma.id = vm.make_id
    WHERE mc.product_sku = $1 AND mc.is_active = TRUE
    ORDER BY vma.name, vm.name, emy.year_from
  `, [sku]);

  if (!compRows.length) {
    throw new Error(`Sin compatibilidades en BD para SKU ${sku}`);
  }

  const compatValues = [];
  for (const r of compRows) {
    const yEnd = r.year_to || r.year_from;
    for (let yr = r.year_from; yr <= yEnd; yr++) {
      compatValues.push({ struct: { brand: r.make_name, model: r.model_name, year: yr } });
    }
  }

  const makes = [...new Set(compRows.map((r) => r.make_name))];
  const attributes = [];
  if (makes.length) attributes.push({ id: 'BRAND', value_name: makes[0] });
  if (compatValues.length) attributes.push({ id: 'COMPATIBLE_WITH', values: compatValues });

  const token = await getAccessTokenForMlUser(mlUserId);
  const mlRes = await fetch(`${ML_BASE}/items/${mlItemId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes }),
  });

  const mlStatus = mlRes.status;
  let mlRespText = '';
  try { mlRespText = await mlRes.text(); } catch (_) { /* ignore */ }

  await pool.query(`
    INSERT INTO ml_api_log (ml_user_id, action, ml_item_id, success, request_payload, response_payload)
    VALUES ($1, 'sync_attributes', $2, $3, $4, $5)
  `, [
    mlUserId, mlItemId, mlRes.ok,
    JSON.stringify({ attributes_count: attributes.length }),
    mlRespText,
  ]).catch(() => {});

  if (!mlRes.ok) {
    throw new Error(`ML API ${mlStatus}: ${mlRespText.slice(0, 300)}`);
  }

  await pool.query(`
    UPDATE ml_publications
    SET attributes_synced = TRUE, attributes_synced_at = NOW()
    WHERE ml_item_id = $1
  `, [mlItemId]);

  return { synced: true, attributes_count: compatValues.length };
}

async function handleMlApiRequest(req, res, url) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = url.pathname;

  if (!path.startsWith('/api/ml')) return false;
  if (!await requireAdminOrPermission(req, res, mlApiPermissionModule(path))) return true;

  try {
    // ── Lectura CRM (permiso crm) ───────────────────────────────────────────
    if (method === 'GET' && path === '/api/ml/questions') {
      const { limit, offset } = parsePagination(url);
      const [{ rows }, { rows: cntRows }] = await Promise.all([
        pool.query(
          `SELECT id, ml_question_id, ml_user_id, item_id, buyer_id, question_text, ml_status,
                  date_created, created_at, updated_at, ia_auto_route_detail
           FROM ml_questions_pending
           ORDER BY updated_at DESC NULLS LAST
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::bigint AS n FROM ml_questions_pending`),
      ]);
      return ok(res, {
        rows,
        total: Number(cntRows[0]?.n || 0),
        limit,
        offset,
      });
    }

    if (method === 'GET' && path === '/api/ml/listings') {
      const { limit, offset } = parsePagination(url);
      const mlUserId = url.searchParams.get('ml_user_id');
      const baseParams = [];
      let where = 'WHERE TRUE';
      if (mlUserId != null && String(mlUserId).trim() !== '') {
        baseParams.push(Number(mlUserId));
        where += ` AND ml_user_id = $${baseParams.length}`;
      }
      const limIdx = baseParams.length + 1;
      const offIdx = baseParams.length + 2;
      const [{ rows }, { rows: cntRows }] = await Promise.all([
        pool.query(
          `SELECT id, ml_user_id, item_id, site_id, status, title, price, currency_id,
                  available_quantity, sold_quantity, category_id, permalink, thumbnail,
                  fetched_at, updated_at
           FROM ml_listings ${where}
           ORDER BY updated_at DESC NULLS LAST
           LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...baseParams, limit, offset]
        ),
        pool.query(`SELECT COUNT(*)::bigint AS n FROM ml_listings ${where}`, baseParams),
      ]);
      return ok(res, {
        rows,
        total: Number(cntRows[0]?.n || 0),
        limit,
        offset,
      });
    }

    if (method === 'GET' && path === '/api/ml/reputation') {
      const { rows } = await pool.query(
        `SELECT ml_user_id, nickname, updated_at FROM ml_accounts ORDER BY ml_user_id ASC`
      );
      return ok(res, { sellers: rows });
    }

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

    // ── Publicaciones activas sin mapeo SKU ───────────────────────────────
    if (method === 'GET' && path === '/api/ml/listings/unmapped') {
      const { limit, offset } = parsePagination(url);
      const out = await svc.listUnmappedListings({ limit, offset });
      return ok(res, out);
    }

    // ── Sync manual de stock WMS→ML por SKU ───────────────────────────────
    // GET /api/ml/publications/sync/:sku
    // Nota: 2 segmentos tras /publications/ → no colisiona con /:ml_item_id
    const syncSkuMatch = path.match(/^\/api\/ml\/publications\/sync\/(.+)$/);
    if (method === 'GET' && syncSkuMatch) {
      const sku = decodeURIComponent(syncSkuMatch[1]);
      if (!sku) return fail(res, 400, 'MISSING_SKU', 'sku requerido');
      const result = await svc.syncMlStockForSku(sku, { updatedBy: 'manual_sync' });
      return ok(res, result);
    }

    // ── Shipment ID desde orden ML ─────────────────────────────────────────
    // GET /api/ml/orders/:orderId/shipment?ml_user_id=X
    // Nota: 3 segmentos → no colisiona con rutas de publicaciones
    const orderShipmentMatch = path.match(/^\/api\/ml\/orders\/(\d+)\/shipment\/?$/);
    if (method === 'GET' && orderShipmentMatch) {
      const mlOrderId = Number(orderShipmentMatch[1]);
      const mlUserId  = Number(url.searchParams.get('ml_user_id') || '0');
      if (!mlOrderId) return fail(res, 400, 'INVALID_ORDER_ID', 'orderId debe ser numérico');
      if (!mlUserId)  return fail(res, 400, 'MISSING_ML_USER_ID', 'ml_user_id requerido');

      // 1. Buscar en BD (raw_json de ml_orders contiene shipping.id)
      const { rows: dbRows } = await pool.query(
        `SELECT raw_json FROM ml_orders WHERE order_id = $1 AND ml_user_id = $2 LIMIT 1`,
        [mlOrderId, mlUserId]
      );
      let shipmentId = null;
      if (dbRows.length && dbRows[0].raw_json) {
        try {
          const rj = typeof dbRows[0].raw_json === 'string'
            ? JSON.parse(dbRows[0].raw_json) : dbRows[0].raw_json;
          shipmentId = rj?.shipping?.id != null ? String(rj.shipping.id) : null;
        } catch (_) {}
      }

      // 2. Si no está en BD, llamar ML API
      if (!shipmentId) {
        const token = await getAccessTokenForMlUser(mlUserId);
        const mlRes = await fetch(`${ML_BASE}/orders/${mlOrderId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!mlRes.ok) {
          const body = await mlRes.json().catch(() => ({}));
          return fail(res, mlRes.status, 'ML_API_ERROR', body?.message || `HTTP ${mlRes.status}`);
        }
        const order = await mlRes.json();
        shipmentId = order?.shipping?.id != null ? String(order.shipping.id) : null;
      }

      if (!shipmentId) {
        return fail(res, 404, 'SHIPMENT_NOT_FOUND', 'Esta orden no tiene envío asociado en ML');
      }
      return ok(res, { shipment_id: shipmentId, order_id: mlOrderId, ml_user_id: mlUserId });
    }

    // ── Etiqueta de envío ML (PDF o ZPL) ───────────────────────────────────
    // GET /api/ml/shipments/:shipmentId/label?ml_user_id=X&format=pdf|zpl
    // Devuelve el archivo directamente (binario), no JSON.
    const labelMatch = path.match(/^\/api\/ml\/shipments\/(\d+)\/label\/?$/);
    if (method === 'GET' && labelMatch) {
      const shipmentId = labelMatch[1];
      const mlUserId   = Number(url.searchParams.get('ml_user_id') || '0');
      const format     = (url.searchParams.get('format') || 'pdf').toLowerCase();

      if (!mlUserId) return fail(res, 400, 'MISSING_ML_USER_ID', 'ml_user_id requerido');
      if (!['pdf', 'zpl'].includes(format)) return fail(res, 400, 'INVALID_FORMAT', 'format debe ser pdf o zpl');

      const responseType = format === 'zpl' ? 'zpl2' : 'pdf2';
      const contentType  = format === 'zpl' ? 'application/x-zebra-zpl' : 'application/pdf';

      const token = await getAccessTokenForMlUser(mlUserId);
      const mlUrl = `${ML_BASE}/shipments/${shipmentId}/shipment_labels?response_type=${responseType}`;
      const mlRes = await fetch(mlUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      // Log en ml_api_log (best-effort)
      await pool.query(`
        INSERT INTO ml_api_log (ml_item_id, action, request_body, response_code, success, executed_by)
        VALUES ($1, 'get_label', NULL, $2, $3, 'system')
      `, [shipmentId, mlRes.status, mlRes.ok]).catch(() => {});

      if (!mlRes.ok) {
        const errBody = await mlRes.json().catch(() => ({}));
        return fail(res, mlRes.status, 'ML_LABEL_ERROR',
          errBody?.message || `Error ML HTTP ${mlRes.status}`);
      }

      const buffer = Buffer.from(await mlRes.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `attachment; filename="label-${shipmentId}.${format}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
      return true;
    }

    // GET /api/ml/publications/sync-attributes-batch?limit=10
    if (method === 'GET' && path === '/api/ml/publications/sync-attributes-batch') {
      const rawLimit = Number(url.searchParams.get('limit') || '10');
      const batchLimit = Math.min(Math.max(1, rawLimit), 50);

      const { rows: candidates } = await pool.query(`
        SELECT DISTINCT ON (m.ml_item_id)
          m.ml_item_id, m.master_sku AS sku, m.ml_user_id
        FROM ml_sku_mapping m
        JOIN motor_compatibility mc ON mc.product_sku = m.master_sku AND mc.is_active = TRUE
        LEFT JOIN ml_publications pub ON pub.ml_item_id = m.ml_item_id
        WHERE m.ml_item_id IS NOT NULL
          AND m.sync_status = 'active'
          AND (pub.attributes_synced IS DISTINCT FROM TRUE)
        LIMIT $1
      `, [batchLimit]);

      const errors = [];
      let processed = 0;
      for (const c of candidates) {
        await mlQueuedCall(async () => {
          try {
            await _syncAttributesForItem({ mlItemId: c.ml_item_id, sku: c.sku, mlUserId: c.ml_user_id });
            processed++;
          } catch (err) {
            errors.push({ ml_item_id: c.ml_item_id, error: err.message });
          }
        });
      }
      return ok(res, { processed, total_candidates: candidates.length, errors });
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

    // GET /api/ml/publications/:mlItemId/attributes?ml_user_id=X
    const pubAttributesMatch = path.match(/^\/api\/ml\/publications\/([^/]+)\/attributes\/?$/);
    if (method === 'GET' && pubAttributesMatch) {
      const mlItemId = decodeURIComponent(pubAttributesMatch[1]);
      const mlUserId = Number(url.searchParams.get('ml_user_id') || '0');
      if (!mlUserId) return fail(res, 400, 'MISSING_PARAM', 'ml_user_id es requerido');

      const token = await getAccessTokenForMlUser(mlUserId);
      const mlRes = await fetch(`${ML_BASE}/items/${mlItemId}/attributes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!mlRes.ok) {
        const body = await mlRes.text().catch(() => '');
        return fail(res, mlRes.status, 'ML_API_ERROR', body.slice(0, 500));
      }
      const attrs = await mlRes.json();
      return ok(res, { ml_item_id: mlItemId, attributes: attrs });
    }

    // POST /api/ml/publications/:mlItemId/sync-attributes?ml_user_id=X
    const pubSyncAttrsMatch = path.match(/^\/api\/ml\/publications\/([^/]+)\/sync-attributes\/?$/);
    if (method === 'POST' && pubSyncAttrsMatch) {
      const mlItemId = decodeURIComponent(pubSyncAttrsMatch[1]);

      let mlUserId = Number(url.searchParams.get('ml_user_id') || '0');
      if (!mlUserId) {
        const { rows: mRows } = await pool.query(
          `SELECT ml_user_id FROM ml_sku_mapping WHERE ml_item_id = $1 LIMIT 1`, [mlItemId]
        );
        if (!mRows.length) return fail(res, 404, 'NOT_MAPPED', `Sin mapeo ML para ${mlItemId}`);
        mlUserId = mRows[0].ml_user_id;
      }

      const { rows: skuRows } = await pool.query(
        `SELECT master_sku FROM ml_sku_mapping WHERE ml_item_id = $1 LIMIT 1`, [mlItemId]
      );
      if (!skuRows.length) return fail(res, 404, 'NOT_MAPPED', `Sin SKU mapeado para ${mlItemId}`);
      const sku = skuRows[0].master_sku;

      const result = await _syncAttributesForItem({ mlItemId, sku, mlUserId });
      return ok(res, result);
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
