'use strict';

const pino = require('pino');
const { pool } = require('../../db');
const { getAccessTokenForMlUser } = require('../../oauth-token');

const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'ml_service' });
const ML_BASE = process.env.ML_API_BASE || 'https://api.mercadolibre.com';

async function writeApiLog({
  mlItemId = null,
  mlUserId = null,
  action,
  requestBody = null,
  responseCode = null,
  responseBody = null,
  success = false,
  errorMessage = null,
  executedBy = 'system',
}) {
  try {
    await pool.query(`
      INSERT INTO ml_api_log
        (ml_item_id, action, request_body, response_code, response_body, success, error_message, executed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      mlItemId,
      action,
      requestBody ? JSON.stringify(requestBody) : null,
      responseCode,
      responseBody ? JSON.stringify(responseBody) : null,
      !!success,
      errorMessage,
      executedBy,
    ]);
  } catch (err) {
    log.error({ err: err.message, action, mlItemId }, 'ml_service: error guardando ml_api_log');
  }
}

/**
 * HTTP PUT/POST/GET autenticado contra la API de ML usando OAuth multi-cuenta.
 * @param {{ method: string, path: string, body?: object|null, mlItemId?: string|null,
 *           mlUserId: number, action: string, executedBy?: string }} opts
 */
async function mlRequest({ method, path, body = null, mlItemId = null, mlUserId, action, executedBy = 'system' }) {
  if (!mlUserId) {
    const err = new Error('mlUserId requerido para llamadas a la API de ML');
    err.code = 'MISSING_ML_USER_ID';
    err.status = 400;
    throw err;
  }

  const token = await getAccessTokenForMlUser(Number(mlUserId));
  const url = `${ML_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  let response = null;
  let responseBody = null;
  let success = false;
  let errorMessage = null;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    try {
      responseBody = await response.json();
    } catch (_) {
      responseBody = null;
    }

    success = !!response.ok;
    if (!success) {
      errorMessage = responseBody?.message || `HTTP ${response.status}`;
      const err = new Error(`ML API error: ${errorMessage}`);
      err.code = response.status === 429
        ? 'ML_RATE_LIMIT'
        : response.status === 401
          ? 'ML_TOKEN_EXPIRED'
          : 'ML_API_ERROR';
      err.status = response.status;
      err.retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
      throw err;
    }
  } catch (err) {
    if (!errorMessage) errorMessage = err.message || 'error desconocido';
    await writeApiLog({
      mlItemId,
      mlUserId,
      action,
      requestBody: body,
      responseCode: response?.status || null,
      responseBody,
      success: false,
      errorMessage,
      executedBy,
    });
    throw err;
  }

  await writeApiLog({
    mlItemId,
    mlUserId,
    action,
    requestBody: body,
    responseCode: response?.status || null,
    responseBody,
    success: true,
    errorMessage: null,
    executedBy,
  });
  return responseBody;
}

async function pauseItem(mlItemId, mlUserId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { status: 'paused' },
    mlItemId,
    mlUserId,
    action: 'pause',
    executedBy,
  });
}

async function activateItem(mlItemId, mlUserId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { status: 'active' },
    mlItemId,
    mlUserId,
    action: 'activate',
    executedBy,
  });
}

async function updatePrice(mlItemId, priceUsd, mlUserId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { price: Number(priceUsd) },
    mlItemId,
    mlUserId,
    action: 'price_update',
    executedBy,
  });
}

async function updateStock(mlItemId, availableQuantity, mlUserId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { available_quantity: Number(availableQuantity) },
    mlItemId,
    mlUserId,
    action: 'stock_update',
    executedBy,
  });
}

async function closeItem(mlItemId, mlUserId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { status: 'closed' },
    mlItemId,
    mlUserId,
    action: 'close',
    executedBy,
  });
}

async function getItem(mlItemId, mlUserId, executedBy = 'system') {
  return mlRequest({
    method: 'GET',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    mlItemId,
    mlUserId,
    action: 'get_item',
    executedBy,
  });
}

/**
 * Lista los items de la cuenta mlUserId en la API de ML.
 * Usa scroll_id si está disponible; fallback a offset/limit.
 */
async function getSellerItems(mlUserId, { offset = 0, limit = 100, scrollId = null } = {}, executedBy = 'system') {
  const uid = encodeURIComponent(String(mlUserId));
  const lim = Math.min(100, Math.max(1, Number(limit) || 100));
  const p = new URLSearchParams();
  p.set('limit', String(lim));
  if (scrollId) {
    p.set('search_type', 'scan');
    p.set('scroll_id', scrollId);
  } else {
    p.set('offset', String(Math.max(0, Number(offset) || 0)));
  }
  return mlRequest({
    method: 'GET',
    path: `/users/${uid}/items/search?${p.toString()}`,
    mlUserId,
    action: 'list_items',
    executedBy,
  });
}

/**
 * Resuelve el ml_user_id de una publicación a partir de su ml_item_id.
 * Devuelve null si no está registrada.
 */
async function resolveUserIdForItem(mlItemId) {
  const { rows } = await pool.query(
    `SELECT ml_user_id FROM ml_publications WHERE ml_item_id = $1 LIMIT 1`,
    [mlItemId]
  );
  return rows[0]?.ml_user_id ? Number(rows[0].ml_user_id) : null;
}

module.exports = {
  pauseItem,
  activateItem,
  updatePrice,
  updateStock,
  closeItem,
  getItem,
  getSellerItems,
  resolveUserIdForItem,
};
