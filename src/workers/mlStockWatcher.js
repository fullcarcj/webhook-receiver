'use strict';

const pino = require('pino');
const { pool } = require('../../db');
const {
  triggerAutoPause,
  triggerAutoActivate,
} = require('../services/mlPublicationsService');

const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'ml_stock_watcher' });

let isRunning = false;
let watcherHandle = null;

async function watcherCycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    const { rows: toPause } = await pool.query(`
      SELECT DISTINCT mp.product_id, i.stock_qty
      FROM ml_publications mp
      JOIN inventory i ON i.product_id = mp.product_id
      WHERE mp.ml_status = 'active'
        AND mp.auto_pause_enabled = TRUE
        AND mp.local_status <> 'pending_pause'
        AND i.stock_qty <= 0
        AND COALESCE(mp.ml_item_id, '') <> ''
    `);

    for (const row of toPause) {
      await triggerAutoPause(row.product_id);
    }

    const { rows: toActivate } = await pool.query(`
      SELECT DISTINCT mp.product_id, i.stock_qty
      FROM ml_publications mp
      JOIN inventory i ON i.product_id = mp.product_id
      JOIN ml_paused_publications mpp
        ON mpp.ml_publication_id = mp.id
       AND mpp.pause_type = 'auto'
       AND mpp.reactivated_at IS NULL
      WHERE mp.ml_status = 'paused'
        AND mp.local_status <> 'pending_activate'
        AND i.stock_qty > 0
        AND COALESCE(mp.ml_item_id, '') <> ''
    `);

    for (const row of toActivate) {
      await triggerAutoActivate(row.product_id, Number(row.stock_qty || 0));
    }

    if (toPause.length || toActivate.length) {
      log.info({
        auto_paused_candidates: toPause.length,
        auto_activated_candidates: toActivate.length,
      }, 'ml_stock_watcher: cycle con cambios');
    }
  } catch (err) {
    log.error({ err: err.message }, 'ml_stock_watcher: error en cycle');
  } finally {
    isRunning = false;
  }
}

function startMlStockWatcher() {
  if (process.env.NODE_ENV === 'test') return;
  if (watcherHandle) return;
  watcherCycle().catch(() => {});
  watcherHandle = setInterval(() => {
    watcherCycle().catch(() => {});
  }, 60_000);
  log.info('ml_stock_watcher: iniciado (cada 60s)');
}

function stopMlStockWatcher() {
  if (watcherHandle) {
    clearInterval(watcherHandle);
    watcherHandle = null;
  }
  log.info('ml_stock_watcher: detenido');
}

module.exports = {
  startMlStockWatcher,
  stopMlStockWatcher,
};
