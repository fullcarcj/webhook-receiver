'use strict';

const pino = require('pino');
const { pool } = require('../../db');
const mlService = require('./mlService');
const { emit } = require('./sseService');

const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'ml_publications' });

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try { return JSON.parse(payload); } catch (_) { return {}; }
}

/**
 * Resuelve ml_user_id de una publicación y lanza si no está definido
 * (protege contra llamadas de mlService sin cuenta asignada).
 */
function requireMlUserId(pub) {
  if (!pub.ml_user_id) {
    const err = new Error(`La publicación ${pub.ml_item_id} no tiene ml_user_id asignado. Asignar la cuenta ML antes de operar.`);
    err.code = 'MISSING_ML_USER_ID';
    err.status = 409;
    throw err;
  }
  return Number(pub.ml_user_id);
}

async function listPublications({ status, localStatus, search, onlyZeroStock, mlUserId, limit = 100, offset = 0 } = {}) {
  const params = [status || null, localStatus || null, search || null, !!onlyZeroStock, mlUserId ? Number(mlUserId) : null, limit, offset];
  const { rows } = await pool.query(`
    SELECT
      mp.*,
      COUNT(*) OVER() AS total_count
    FROM ml_publications mp
    WHERE ($1::text IS NULL OR mp.ml_status = $1)
      AND ($2::text IS NULL OR mp.local_status = $2)
      AND ($3::text IS NULL OR mp.sku ILIKE '%' || $3 || '%' OR mp.ml_item_id ILIKE '%' || $3 || '%' OR COALESCE(mp.ml_title,'') ILIKE '%' || $3 || '%')
      AND ($4::boolean = FALSE OR mp.stock_qty <= 0)
      AND ($5::bigint IS NULL OR mp.ml_user_id = $5)
    ORDER BY mp.updated_at DESC
    LIMIT $6 OFFSET $7
  `, params);

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map((r) => {
      const { total_count, ...rest } = r;
      return rest;
    }),
    total,
    limit,
    offset,
  };
}

async function getPublicationByItemId(mlItemId) {
  const { rows } = await pool.query(`
    SELECT mp.* FROM ml_publications mp WHERE mp.ml_item_id = $1
  `, [mlItemId]);
  return rows[0] || null;
}

async function getPausedPublications({ limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT
      mp.id,
      mp.product_id,
      mp.sku,
      mp.ml_item_id,
      mp.ml_title,
      mp.ml_status,
      mp.local_status,
      mp.stock_qty,
      mp.ml_user_id,
      mpp.pause_type,
      mpp.pause_reason,
      mpp.paused_by,
      mpp.approved_by,
      mpp.paused_at,
      COUNT(*) OVER() AS total_count
    FROM ml_publications mp
    JOIN LATERAL (
      SELECT *
      FROM ml_paused_publications x
      WHERE x.ml_publication_id = mp.id
        AND x.reactivated_at IS NULL
      ORDER BY x.paused_at DESC
      LIMIT 1
    ) mpp ON TRUE
    WHERE mp.ml_status = 'paused'
    ORDER BY mpp.paused_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map((r) => {
      const { total_count, ...rest } = r;
      return rest;
    }),
    total,
    limit,
    offset,
  };
}

async function getZeroStockPublications({ limit = 100, offset = 0 } = {}) {
  const { rows: publications } = await pool.query(`
    SELECT
      mp.ml_item_id,
      mp.sku,
      mp.ml_title,
      mp.ml_status,
      mp.stock_qty,
      mp.auto_pause_enabled,
      mp.last_synced_at,
      mp.ml_user_id,
      COALESCE(
        EXTRACT(DAY FROM (NOW() - z.paused_at))::int,
        EXTRACT(DAY FROM (NOW() - mp.updated_at))::int,
        0
      ) AS days_without_stock,
      COUNT(*) OVER() AS total_count
    FROM ml_publications mp
    LEFT JOIN LATERAL (
      SELECT paused_at
      FROM ml_paused_publications x
      WHERE x.ml_publication_id = mp.id
      ORDER BY x.paused_at DESC
      LIMIT 1
    ) z ON TRUE
    WHERE mp.stock_qty <= 0
      AND mp.ml_status = 'active'
    ORDER BY mp.updated_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const { rows: summaryRows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE mp.ml_status = 'active' AND mp.stock_qty <= 0) AS active_zero_stock,
      COUNT(*) FILTER (
        WHERE mp.ml_status = 'paused'
          AND EXISTS (
            SELECT 1 FROM ml_paused_publications x
            WHERE x.ml_publication_id = mp.id
              AND x.pause_type = 'auto'
              AND x.reactivated_at IS NULL
          )
      ) AS paused_auto,
      COUNT(*) FILTER (
        WHERE mp.ml_status = 'paused'
          AND EXISTS (
            SELECT 1 FROM ml_paused_publications x
            WHERE x.ml_publication_id = mp.id
              AND x.pause_type = 'manual'
              AND x.reactivated_at IS NULL
          )
      ) AS paused_manual,
      (SELECT COUNT(*) FROM ml_pending_actions WHERE status = 'pending' AND expires_at > NOW()) AS pending_actions
    FROM ml_publications mp
  `);

  const total = publications.length ? Number(publications[0].total_count) : 0;
  const items = publications.map((r) => {
    const { total_count, ...rest } = r;
    return { ...rest, suggested_action: 'PAUSAR' };
  });

  return {
    publications: items,
    total,
    summary: {
      active_zero_stock: Number(summaryRows[0]?.active_zero_stock || 0),
      paused_auto: Number(summaryRows[0]?.paused_auto || 0),
      paused_manual: Number(summaryRows[0]?.paused_manual || 0),
      pending_actions: Number(summaryRows[0]?.pending_actions || 0),
    },
    limit,
    offset,
  };
}

async function markPendingStatus(id, next) {
  await pool.query(
    `UPDATE ml_publications SET local_status = $1, updated_at = NOW() WHERE id = $2`,
    [next, id]
  );
}

async function triggerAutoPause(productId) {
  const { rows } = await pool.query(`
    UPDATE ml_publications
    SET local_status = 'pending_pause', updated_at = NOW()
    WHERE product_id = $1
      AND auto_pause_enabled = TRUE
      AND ml_status = 'active'
      AND local_status <> 'pending_pause'
      AND COALESCE(ml_item_id, '') <> ''
    RETURNING id, product_id, sku, ml_item_id, stock_qty, ml_user_id
  `, [productId]);

  if (!rows.length) return { paused: 0, skipped: 0 };

  let paused = 0;
  let skipped = 0;
  for (const pub of rows) {
    try {
      const mlUserId = requireMlUserId(pub);
      await mlService.pauseItem(pub.ml_item_id, mlUserId, 'system');
      await pool.query(`
        UPDATE ml_publications
        SET ml_status = 'paused',
            local_status = 'paused',
            stock_qty = 0,
            updated_at = NOW()
        WHERE id = $1
      `, [pub.id]);
      await pool.query(`
        INSERT INTO ml_paused_publications
          (ml_publication_id, ml_item_id, sku, pause_type, pause_reason, paused_by, stock_at_pause)
        SELECT $1,$2,$3,'auto','stock_cero','system',$4
        WHERE NOT EXISTS (
          SELECT 1
          FROM ml_paused_publications x
          WHERE x.ml_publication_id = $1
            AND x.reactivated_at IS NULL
        )
      `, [pub.id, pub.ml_item_id, pub.sku, Number(pub.stock_qty || 0)]);

      paused++;
      emit('ml_publication_paused', {
        ml_item_id: pub.ml_item_id,
        product_id: pub.product_id,
        sku: pub.sku,
        pause_type: 'auto',
        reason: 'stock_cero',
      });
    } catch (err) {
      skipped++;
      await markPendingStatus(pub.id, 'active');
      log.error({ err: err.message, ml_item_id: pub.ml_item_id }, 'triggerAutoPause: error');
    }
  }

  return { paused, skipped };
}

async function triggerAutoActivate(productId, newStock) {
  const { rows } = await pool.query(`
    UPDATE ml_publications
    SET local_status = 'pending_activate', updated_at = NOW()
    WHERE product_id = $1
      AND ml_status = 'paused'
      AND local_status <> 'pending_activate'
      AND COALESCE(ml_item_id, '') <> ''
      AND EXISTS (
        SELECT 1
        FROM ml_paused_publications mpp
        WHERE mpp.ml_publication_id = ml_publications.id
          AND mpp.pause_type = 'auto'
          AND mpp.reactivated_at IS NULL
      )
    RETURNING id, product_id, sku, ml_item_id, ml_user_id
  `, [productId]);

  if (!rows.length) return { activated: 0, skipped: 0 };

  let activated = 0;
  let skipped = 0;
  for (const pub of rows) {
    try {
      const mlUserId = requireMlUserId(pub);
      await mlService.updateStock(pub.ml_item_id, Math.max(0, Math.floor(Number(newStock || 0))), mlUserId, 'system');
      await mlService.activateItem(pub.ml_item_id, mlUserId, 'system');
      await pool.query(`
        UPDATE ml_publications
        SET ml_status = 'active',
            local_status = 'active',
            stock_qty = $1,
            updated_at = NOW()
        WHERE id = $2
      `, [Number(newStock || 0), pub.id]);
      await pool.query(`
        UPDATE ml_paused_publications
        SET reactivated_at = NOW(),
            reactivated_by = 'system'
        WHERE ml_publication_id = $1
          AND pause_type = 'auto'
          AND reactivated_at IS NULL
      `, [pub.id]);
      activated++;
      emit('ml_publication_activated', {
        ml_item_id: pub.ml_item_id,
        product_id: pub.product_id,
        sku: pub.sku,
        new_stock: Number(newStock || 0),
      });
    } catch (err) {
      skipped++;
      await markPendingStatus(pub.id, 'paused');
      log.error({ err: err.message, ml_item_id: pub.ml_item_id }, 'triggerAutoActivate: error');
    }
  }

  return { activated, skipped };
}

async function syncPublicationsStatus(limit = 50) {
  const { rows } = await pool.query(`
    SELECT id, ml_item_id, ml_user_id
    FROM ml_publications
    WHERE COALESCE(ml_item_id, '') <> ''
      AND ml_user_id IS NOT NULL
      AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '1 hour')
    ORDER BY last_synced_at ASC NULLS FIRST
    LIMIT $1
  `, [limit]);

  let synced = 0;
  let errors = 0;
  for (const pub of rows) {
    try {
      const mlUserId = Number(pub.ml_user_id);
      const item = await mlService.getItem(pub.ml_item_id, mlUserId, 'system');
      await pool.query(`
        UPDATE ml_publications
        SET ml_status = $1,
            ml_title = COALESCE($2, ml_title),
            price_usd = CASE WHEN $3::numeric IS NULL THEN price_usd ELSE $3::numeric END,
            stock_qty = CASE WHEN $4::numeric IS NULL THEN stock_qty ELSE $4::numeric END,
            last_synced_at = NOW(),
            updated_at = NOW()
        WHERE id = $5
      `, [
        String(item?.status || 'active'),
        item?.title || null,
        item?.price != null ? Number(item.price) : null,
        item?.available_quantity != null ? Number(item.available_quantity) : null,
        pub.id,
      ]);
      synced++;
    } catch (err) {
      errors++;
      log.error({ err: err.message, ml_item_id: pub.ml_item_id }, 'syncPublicationsStatus: error');
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { synced, errors, inspected: rows.length };
}

async function requestManualAction({ mlItemId, actionType, reason, requestedBy, payload = {} }) {
  const { rows: pubs } = await pool.query(`
    SELECT id, sku, ml_item_id, ml_user_id
    FROM ml_publications
    WHERE ml_item_id = $1
    LIMIT 1
  `, [mlItemId]);

  if (!pubs.length) {
    const err = new Error('Publicación no encontrada');
    err.code = 'PUBLICATION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const pub = pubs[0];
  const { rows } = await pool.query(`
    INSERT INTO ml_pending_actions
      (ml_publication_id, ml_item_id, sku, action_type, reason, requested_by, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    RETURNING id, expires_at
  `, [pub.id, pub.ml_item_id, pub.sku, actionType, reason, requestedBy, JSON.stringify(payload || {})]);

  const action = rows[0];
  emit('ml_action_requested', {
    action_id: action.id,
    ml_item_id: pub.ml_item_id,
    sku: pub.sku,
    action_type: actionType,
    requested_by: requestedBy,
    expires_at: action.expires_at,
  });

  return { action_id: action.id, status: 'pending', expires_at: action.expires_at };
}

async function listPendingActions({ limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT *, COUNT(*) OVER() AS total_count
    FROM ml_pending_actions
    WHERE status = 'pending'
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map((r) => {
      const { total_count, ...rest } = r;
      return { ...rest, payload: parsePayload(rest.payload) };
    }),
    total,
    limit,
    offset,
  };
}

async function runApprovedAction(client, action, reviewedBy) {
  const { rows: pubRows } = await client.query(
    `SELECT ml_user_id, stock_qty FROM ml_publications WHERE id = $1`,
    [action.ml_publication_id]
  );
  const pub = pubRows[0] || {};
  const mlUserId = pub.ml_user_id ? Number(pub.ml_user_id) : null;

  if (!mlUserId) {
    const err = new Error(`Publicación sin ml_user_id — asignar cuenta ML antes de ejecutar acciones`);
    err.code = 'MISSING_ML_USER_ID';
    err.status = 409;
    throw err;
  }

  if (action.action_type === 'pause') {
    await mlService.pauseItem(action.ml_item_id, mlUserId, reviewedBy);
    await client.query(`
      UPDATE ml_publications
      SET ml_status = 'paused',
          local_status = 'paused',
          updated_at = NOW()
      WHERE id = $1
    `, [action.ml_publication_id]);
    const stockAtPause = Number(pub.stock_qty || 0);
    await client.query(`
      INSERT INTO ml_paused_publications
        (ml_publication_id, ml_item_id, sku, pause_type, pause_reason, paused_by, approved_by, stock_at_pause)
      SELECT $1,$2,$3,'manual',$4,$5,$6,$7
      WHERE NOT EXISTS (
        SELECT 1
        FROM ml_paused_publications x
        WHERE x.ml_publication_id = $1
          AND x.reactivated_at IS NULL
      )
    `, [
      action.ml_publication_id,
      action.ml_item_id,
      action.sku,
      action.reason,
      action.requested_by,
      reviewedBy,
      stockAtPause,
    ]);
  } else if (action.action_type === 'activate') {
    await mlService.activateItem(action.ml_item_id, mlUserId, reviewedBy);
    await client.query(`
      UPDATE ml_publications
      SET ml_status = 'active',
          local_status = 'active',
          updated_at = NOW()
      WHERE id = $1
    `, [action.ml_publication_id]);
    await client.query(`
      UPDATE ml_paused_publications
      SET reactivated_at = NOW(),
          reactivated_by = $2
      WHERE ml_publication_id = $1
        AND reactivated_at IS NULL
    `, [action.ml_publication_id, reviewedBy]);
  } else if (action.action_type === 'price_update') {
    const payload = parsePayload(action.payload);
    await mlService.updatePrice(action.ml_item_id, Number(payload.new_price_usd), mlUserId, reviewedBy);
    await client.query(`
      UPDATE ml_publications
      SET price_usd = $2, updated_at = NOW()
      WHERE id = $1
    `, [action.ml_publication_id, Number(payload.new_price_usd)]);
  } else if (action.action_type === 'close') {
    await mlService.closeItem(action.ml_item_id, mlUserId, reviewedBy);
    await client.query(`
      UPDATE ml_publications
      SET ml_status = 'closed',
          local_status = 'paused',
          updated_at = NOW()
      WHERE id = $1
    `, [action.ml_publication_id]);
  }
}

async function reviewManualAction({ actionId, decision, reviewedBy, rejectionReason = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT *
      FROM ml_pending_actions
      WHERE id = $1
      FOR UPDATE
    `, [actionId]);
    if (!rows.length) {
      const err = new Error('Acción no encontrada');
      err.code = 'ACTION_NOT_FOUND';
      err.status = 404;
      throw err;
    }
    const action = rows[0];
    if (action.status !== 'pending' || new Date(action.expires_at).getTime() <= Date.now()) {
      await client.query(`
        UPDATE ml_pending_actions
        SET status = 'expired',
            reviewed_at = NOW()
        WHERE id = $1
          AND status = 'pending'
      `, [actionId]);
      const err = new Error('Acción vencida o no pendiente');
      err.code = 'ACTION_NOT_FOUND_OR_EXPIRED';
      err.status = 409;
      throw err;
    }

    if (decision === 'rejected') {
      await client.query(`
        UPDATE ml_pending_actions
        SET status = 'rejected',
            approved_by = $2,
            rejection_reason = $3,
            reviewed_at = NOW()
        WHERE id = $1
      `, [actionId, reviewedBy, rejectionReason || 'sin motivo']);
      await client.query('COMMIT');
      emit('ml_action_rejected', { action_id: actionId, ml_item_id: action.ml_item_id, reviewed_by: reviewedBy });
      return { action_id: actionId, status: 'rejected' };
    }

    await client.query(`
      UPDATE ml_pending_actions
      SET status = 'approved',
          approved_by = $2,
          reviewed_at = NOW()
      WHERE id = $1
    `, [actionId, reviewedBy]);

    await runApprovedAction(client, action, reviewedBy);

    await client.query(`
      UPDATE ml_pending_actions
      SET status = 'executed',
          executed_at = NOW()
      WHERE id = $1
    `, [actionId]);
    await client.query('COMMIT');

    emit('ml_action_executed', {
      action_id: actionId,
      ml_item_id: action.ml_item_id,
      action_type: action.action_type,
      reviewed_by: reviewedBy,
    });
    return { action_id: actionId, status: 'executed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listPausedHistory({ limit = 200, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT mpp.*, COUNT(*) OVER() AS total_count
    FROM ml_paused_publications mpp
    ORDER BY mpp.paused_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map((r) => {
      const { total_count, ...rest } = r;
      return rest;
    }),
    total,
    limit,
    offset,
  };
}

async function listApiLog({ success, action, limit = 200, offset = 0 } = {}) {
  const { rows } = await pool.query(`
    SELECT *, COUNT(*) OVER() AS total_count
    FROM ml_api_log
    WHERE ($1::boolean IS NULL OR success = $1)
      AND ($2::text IS NULL OR action = $2)
    ORDER BY created_at DESC
    LIMIT $3 OFFSET $4
  `, [success === undefined ? null : !!success, action || null, limit, offset]);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return {
    rows: rows.map((r) => {
      const { total_count, ...rest } = r;
      return rest;
    }),
    total,
    limit,
    offset,
  };
}

async function setAutoPauseConfig({ mlItemId, autoPauseEnabled, updatedBy }) {
  const { rows } = await pool.query(`
    UPDATE ml_publications
    SET auto_pause_enabled = $2,
        updated_at = NOW()
    WHERE ml_item_id = $1
    RETURNING id, ml_item_id, sku, auto_pause_enabled, updated_at
  `, [mlItemId, !!autoPauseEnabled]);

  if (!rows.length) {
    const err = new Error('Publicación no encontrada');
    err.code = 'PUBLICATION_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  emit('ml_autopause_updated', {
    ml_item_id: rows[0].ml_item_id,
    sku: rows[0].sku,
    auto_pause_enabled: rows[0].auto_pause_enabled,
    updated_by: updatedBy,
  });
  return rows[0];
}

/**
 * Registra una publicación de ML en la BD local.
 * Hace upsert por ml_item_id.
 */
async function upsertPublication({ productId, sku, mlItemId, mlUserId, mlTitle, mlStatus, stockQty, priceUsd, priceBs, autoPauseEnabled }) {
  const { rows } = await pool.query(`
    INSERT INTO ml_publications
      (product_id, sku, ml_item_id, ml_user_id, ml_title, ml_status, stock_qty, price_usd, price_bs, auto_pause_enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (ml_item_id) DO UPDATE SET
      product_id         = EXCLUDED.product_id,
      sku                = EXCLUDED.sku,
      ml_user_id         = EXCLUDED.ml_user_id,
      ml_title           = COALESCE(EXCLUDED.ml_title, ml_publications.ml_title),
      ml_status          = EXCLUDED.ml_status,
      stock_qty          = EXCLUDED.stock_qty,
      price_usd          = COALESCE(EXCLUDED.price_usd, ml_publications.price_usd),
      price_bs           = COALESCE(EXCLUDED.price_bs, ml_publications.price_bs),
      auto_pause_enabled = EXCLUDED.auto_pause_enabled,
      updated_at         = NOW()
    RETURNING *
  `, [
    productId,
    sku,
    mlItemId,
    mlUserId,
    mlTitle || null,
    mlStatus || 'active',
    stockQty != null ? Number(stockQty) : 0,
    priceUsd != null ? Number(priceUsd) : null,
    priceBs != null ? Number(priceBs) : null,
    autoPauseEnabled !== false,
  ]);
  return rows[0];
}

/**
 * Actualiza stock en BD local y en ML.
 */
async function updateStockForPublication({ mlItemId, newStock, updatedBy }) {
  const { rows } = await pool.query(
    `SELECT id, ml_user_id FROM ml_publications WHERE ml_item_id = $1`,
    [mlItemId]
  );
  if (!rows.length) {
    const err = new Error('Publicación no encontrada');
    err.code = 'PUBLICATION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const pub = rows[0];
  const mlUserId = requireMlUserId(pub);
  const qty = Math.max(0, Math.floor(Number(newStock || 0)));

  await mlService.updateStock(mlItemId, qty, mlUserId, updatedBy || 'admin');
  await pool.query(`
    UPDATE ml_publications
    SET stock_qty = $1, updated_at = NOW()
    WHERE id = $2
  `, [qty, pub.id]);

  emit('ml_stock_updated', { ml_item_id: mlItemId, new_stock: qty, updated_by: updatedBy });
  return { ml_item_id: mlItemId, stock_qty: qty };
}

/**
 * Actualiza precio en BD local y en ML.
 */
async function updatePriceForPublication({ mlItemId, newPriceUsd, updatedBy }) {
  const { rows } = await pool.query(
    `SELECT id, ml_user_id FROM ml_publications WHERE ml_item_id = $1`,
    [mlItemId]
  );
  if (!rows.length) {
    const err = new Error('Publicación no encontrada');
    err.code = 'PUBLICATION_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const pub = rows[0];
  const mlUserId = requireMlUserId(pub);
  const price = Number(newPriceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    const err = new Error('Precio inválido');
    err.code = 'INVALID_PRICE';
    err.status = 400;
    throw err;
  }

  await mlService.updatePrice(mlItemId, price, mlUserId, updatedBy || 'admin');
  await pool.query(`
    UPDATE ml_publications
    SET price_usd = $1, updated_at = NOW()
    WHERE id = $2
  `, [price, pub.id]);

  emit('ml_price_updated', { ml_item_id: mlItemId, new_price_usd: price, updated_by: updatedBy });
  return { ml_item_id: mlItemId, price_usd: price };
}

module.exports = {
  listPublications,
  getPublicationByItemId,
  getPausedPublications,
  getZeroStockPublications,
  triggerAutoPause,
  triggerAutoActivate,
  syncPublicationsStatus,
  requestManualAction,
  listPendingActions,
  reviewManualAction,
  listPausedHistory,
  listApiLog,
  setAutoPauseConfig,
  upsertPublication,
  updateStockForPublication,
  updatePriceForPublication,
};
