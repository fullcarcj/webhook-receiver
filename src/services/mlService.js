'use strict';

const pino = require('pino');
const { pool } = require('../../db');

const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'ml_service' });
const ML_BASE = 'https://api.mercadolibre.com';

async function writeApiLog({
  mlItemId = null,
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

function ensureToken() {
  const token = String(process.env.ML_ACCESS_TOKEN || '').trim();
  if (!token) {
    const err = new Error('ML_ACCESS_TOKEN no definido');
    err.code = 'MISSING_ML_ACCESS_TOKEN';
    err.status = 503;
    throw err;
  }
  return token;
}

async function mlRequest({ method, path, body = null, mlItemId = null, action, executedBy = 'system' }) {
  const token = ensureToken();
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

async function pauseItem(mlItemId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { status: 'paused' },
    mlItemId,
    action: 'pause',
    executedBy,
  });
}

async function activateItem(mlItemId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { status: 'active' },
    mlItemId,
    action: 'activate',
    executedBy,
  });
}

async function updatePrice(mlItemId, priceUsd, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { price: Number(priceUsd) },
    mlItemId,
    action: 'price_update',
    executedBy,
  });
}

async function updateStock(mlItemId, availableQuantity, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { available_quantity: Number(availableQuantity) },
    mlItemId,
    action: 'stock_update',
    executedBy,
  });
}

async function closeItem(mlItemId, executedBy = 'system') {
  return mlRequest({
    method: 'PUT',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    body: { status: 'closed' },
    mlItemId,
    action: 'close',
    executedBy,
  });
}

async function getItem(mlItemId, executedBy = 'system') {
  return mlRequest({
    method: 'GET',
    path: `/items/${encodeURIComponent(mlItemId)}`,
    mlItemId,
    action: 'get_item',
    executedBy,
  });
}

async function getSellerItems(offset = 0, limit = 100, executedBy = 'system') {
  const userId = String(process.env.ML_USER_ID || '').trim();
  if (!userId) {
    const err = new Error('ML_USER_ID no definido');
    err.code = 'MISSING_ML_USER_ID';
    err.status = 503;
    throw err;
  }
  return mlRequest({
    method: 'GET',
    path: `/users/${encodeURIComponent(userId)}/items/search?offset=${offset}&limit=${limit}`,
    action: 'list_items',
    executedBy,
  });
}

module.exports = {
  pauseItem,
  activateItem,
  updatePrice,
  updateStock,
  closeItem,
  getItem,
  getSellerItems,
};
