"use strict";

const { pool } = require("../../db");
const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "price_engine" });

let settingsCache = {};
let ratesCache = { BCV: 0, BINANCE: 0 };
let lastRefresh = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function loadRates() {
  // DECISIÓN: en este repo la tabla real es daily_exchange_rates; fallback a exchange_rates.
  const q1 = await pool.query(
    `SELECT bcv_rate, binance_rate, active_rate, active_rate_type, rate_date
     FROM daily_exchange_rates
     WHERE active_rate IS NOT NULL
     ORDER BY rate_date DESC, id DESC
     LIMIT 1`
  ).catch(() => ({ rows: [] }));
  if (q1.rows.length) {
    const r = q1.rows[0];
    return {
      BCV: Number(r.bcv_rate || r.active_rate || 0),
      BINANCE: Number(r.binance_rate || r.active_rate || 0),
    };
  }
  const q2 = await pool.query(
    `SELECT bcv_rate, binance_rate, adjusted_rate
     FROM exchange_rates
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).catch(() => ({ rows: [] }));
  if (q2.rows.length) {
    const r = q2.rows[0];
    return {
      BCV: Number(r.bcv_rate || r.adjusted_rate || 0),
      BINANCE: Number(r.binance_rate || r.adjusted_rate || 0),
    };
  }
  return { BCV: 0, BINANCE: 0 };
}

async function refreshSettings() {
  const { rows } = await pool.query(
    `SELECT setting_key, setting_value FROM dynamic_prices_settings`
  );
  settingsCache = Object.fromEntries(rows.map((r) => [String(r.setting_key), Number(r.setting_value)]));
  ratesCache = await loadRates();
  lastRefresh = Date.now();
  log.info({ settings: Object.keys(settingsCache).length, rates: ratesCache }, "price_engine: cache refreshed");
  return { settings: settingsCache, rates: ratesCache };
}

async function ensureFreshCache() {
  if (!lastRefresh || Date.now() - lastRefresh > CACHE_TTL_MS) {
    await refreshSettings();
  }
}

async function getClientType(customerId) {
  if (!customerId) return "C";
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS purchases_this_month
     FROM sales_orders
     WHERE customer_id = $1
       AND status IN ('paid','shipped','completed')
       AND created_at >= NOW() - INTERVAL '30 days'`,
    [customerId]
  );
  const count = Number(rows[0]?.purchases_this_month || 0);
  const a = Number(settingsCache.THRESHOLD_TYPE_A ?? 10);
  const bMin = Number(settingsCache.THRESHOLD_TYPE_B_MIN ?? 3);
  const bMax = Number(settingsCache.THRESHOLD_TYPE_B_MAX ?? 9);
  if (count >= a) return "A";
  if (count >= bMin && count <= bMax) return "B";
  return "C";
}

async function calculatePrice({ baseUsd, channel, customerId = null }) {
  await ensureFreshCache();
  const base = Number(baseUsd);
  if (!Number.isFinite(base) || base <= 0) {
    const e = new Error("INVALID_BASE_PRICE");
    e.code = "INVALID_BASE_PRICE";
    throw e;
  }
  const channelMap = {
    mostrador: "MARKUP_MOSTRADOR",
    mercadolibre: "MARKUP_ML",
    ecommerce: "MARKUP_ECOMMERCE",
    social_media: "MARKUP_SOCIAL",
  };
  const markupKey = channelMap[String(channel || "").trim().toLowerCase()];
  if (!markupKey) {
    const e = new Error("INVALID_CHANNEL");
    e.code = "INVALID_CHANNEL";
    throw e;
  }
  const markup = Number(settingsCache[markupKey] ?? 0.25);
  const opex = Number(settingsCache.OPEX_RISK_FACTOR ?? 0.02);
  const mlComm = Number(settingsCache.ML_COMMISSION ?? 0.13);
  const clientType = await getClientType(customerId);
  const discount = Number(settingsCache[`DISCOUNT_TYPE_${clientType}`] ?? 0);

  const tasaBCV = Number(ratesCache.BCV || 0);
  const tasaBinance = Number(ratesCache.BINANCE || 0);

  let prices;
  if (String(channel).toLowerCase() === "mercadolibre") {
    const mlBase = base * (1 + markup + opex + mlComm);
    prices = {
      price_usd: round2(mlBase * (1 - discount)),
      price_bs_bcv: null,
      price_bs_binance: round2(mlBase * Math.max(tasaBinance || 1, 1) * (1 - discount)),
      tasa_used: "BINANCE",
      commission_applied: mlComm,
    };
  } else {
    const x = base * (1 + markup + opex);
    prices = {
      price_usd: round2(x * (1 - discount)),
      price_bs_bcv: round2(x * Math.max(tasaBCV || 1, 1) * (1 - discount)),
      price_bs_binance: round2(x * Math.max(tasaBinance || 1, 1) * (1 - discount)),
      tasa_used: "BOTH",
      commission_applied: 0,
    };
  }

  return {
    base_usd: base,
    channel,
    client_type: clientType,
    discount_pct: round2(discount * 100),
    markup_pct: round2(markup * 100),
    opex_risk_pct: round2(opex * 100),
    tasa_bcv: tasaBCV,
    tasa_binance: tasaBinance,
    prices,
    calculated_at: new Date().toISOString(),
  };
}

async function listSettings() {
  const { rows } = await pool.query(
    `SELECT id, setting_key, setting_value, description, category, updated_by, updated_at, created_at
     FROM dynamic_prices_settings
     ORDER BY category, setting_key`
  );
  return rows;
}

async function listSettingsHistory({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT id, setting_key, old_value, new_value, changed_by, reason, changed_at
     FROM dynamic_prices_settings_history
     ORDER BY changed_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [lim, off]
  );
  return rows;
}

async function updateSetting({ key, newValue, changedBy, reason }) {
  const { rows: prev } = await pool.query(
    `SELECT setting_value FROM dynamic_prices_settings WHERE setting_key = $1`,
    [key]
  );
  if (!prev.length) {
    const e = new Error("SETTING_NOT_FOUND");
    e.code = "SETTING_NOT_FOUND";
    throw e;
  }
  const oldValue = Number(prev[0].setting_value);
  await pool.query(
    `UPDATE dynamic_prices_settings
     SET setting_value = $1, updated_by = $2, updated_at = NOW()
     WHERE setting_key = $3`,
    [newValue, changedBy, key]
  );
  await pool.query(
    `INSERT INTO dynamic_prices_settings_history
      (setting_key, old_value, new_value, changed_by, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [key, oldValue, newValue, changedBy, reason || null]
  );
  lastRefresh = 0;
  return { key, old_value: oldValue, new_value: Number(newValue), changed_by: changedBy };
}

function getCache() {
  return { settings: settingsCache, rates: ratesCache, last_refresh: lastRefresh || null };
}

module.exports = {
  calculatePrice,
  refreshSettings,
  ensureFreshCache,
  updateSetting,
  listSettings,
  listSettingsHistory,
  getClientType,
  getCache,
};
