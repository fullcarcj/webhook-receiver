'use strict';

/**
 * Motor de precios por canal → product_prices (sin tocar unit_price_usd).
 * Porcentajes en decimal (0.25 = 25%). Una lectura de settings + tasas por corrida en runPricingUpdate.
 */

const { pool } = require('../../db');
const pino = require('pino');

const log = pino({ level: process.env.LOG_LEVEL || 'info', name: 'pricing_service' });

const PRICING_ERROR_CODES = Object.freeze({
  NO_RATE_TODAY: 'NO_RATE_TODAY',
  NO_FINANCIAL_SETTINGS: 'NO_FINANCIAL_SETTINGS',
  NO_POLICY_FOUND: 'NO_POLICY_FOUND',
  INVALID_COST: 'INVALID_COST',
});

class PricingError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.code = code;
    this.detail = detail;
    this.name = 'PricingError';
  }
}

function throwPricing(code, message, detail) {
  throw new PricingError(code, message, detail);
}

/**
 * Última fila de tasas con rate_date <= hoy (BCV y Binance obligatorios; ajuste cae a Binance si viene vacío).
 */
async function getTodayRates(companyId, q = pool) {
  const cid = Number(companyId) || 1;
  const { rows } = await q.query(
    `SELECT rate_date,
            bcv_rate,
            binance_rate,
            COALESCE(NULLIF(adjusted_rate, 0), binance_rate) AS adjusted_rate
     FROM daily_exchange_rates
     WHERE company_id = $1
       AND rate_date <= CURRENT_DATE
       AND bcv_rate IS NOT NULL AND bcv_rate > 0
       AND binance_rate IS NOT NULL AND binance_rate > 0
     ORDER BY rate_date DESC
     LIMIT 1`,
    [cid]
  );
  if (!rows[0]) {
    throwPricing(
      PRICING_ERROR_CODES.NO_RATE_TODAY,
      'No hay fila en daily_exchange_rates con bcv_rate y binance_rate > 0 (rate_date <= hoy)',
      { companyId: cid }
    );
  }
  const r = rows[0];
  return {
    rate_date: r.rate_date,
    bcv_rate: Number(r.bcv_rate),
    binance_rate: Number(r.binance_rate),
    adjusted_rate: Number(r.adjusted_rate),
  };
}

async function getFinancialSettings(companyId, q = pool) {
  const cid = Number(companyId) || 1;
  const { rows } = await q.query(`SELECT * FROM financial_settings WHERE company_id = $1 LIMIT 1`, [cid]);
  if (!rows[0]) {
    throwPricing(PRICING_ERROR_CODES.NO_FINANCIAL_SETTINGS, `Sin financial_settings para company_id=${cid}`, {
      companyId: cid,
    });
  }
  return rows[0];
}

/**
 * Herencia: categoría activa → si no, global activa.
 * @returns {Promise<object>} fila de pricing_policies
 */
async function resolvePolicy(companyId, channel, categoryId = null, q = pool) {
  const cid = Number(companyId) || 1;
  const ch = String(channel || '').trim();
  if (!ch) {
    throwPricing(PRICING_ERROR_CODES.NO_POLICY_FOUND, 'channel vacío', { companyId: cid });
  }

  const catNum = categoryId != null && categoryId !== '' ? Number(categoryId) : NaN;
  if (Number.isFinite(catNum) && catNum > 0) {
    const { rows: catRows } = await q.query(
      `SELECT *
       FROM pricing_policies
       WHERE company_id = $1 AND channel = $2 AND level = 'category'
         AND category_id = $3 AND is_active = TRUE
       LIMIT 1`,
      [cid, ch, catNum]
    );
    if (catRows[0]) return catRows[0];
  }

  const { rows: globalRows } = await q.query(
    `SELECT *
     FROM pricing_policies
     WHERE company_id = $1 AND channel = $2 AND level = 'global' AND is_active = TRUE
     LIMIT 1`,
    [cid, ch]
  );
  if (!globalRows[0]) {
    throwPricing(PRICING_ERROR_CODES.NO_POLICY_FOUND, `Sin política global para canal "${ch}"`, {
      companyId: cid,
      channel: ch,
    });
  }
  return globalRows[0];
}

/**
 * Costo operativo = producto de factores sobre landed (4 decimales).
 */
function computeOperationalCost(landedCostUsd, settings) {
  const landed = Number(landedCostUsd);
  if (!Number.isFinite(landed) || landed <= 0) {
    throwPricing(PRICING_ERROR_CODES.INVALID_COST, 'landedCostUsd debe ser > 0', { landedCostUsd });
  }
  const fs = settings || {};
  const flete = Number(fs.flete_nacional_pct || 0);
  const arancel = Number(fs.arancel_pct || 0);
  const admin = Number(fs.gasto_admin_pct || 0);
  const storage = Number(fs.storage_cost_pct || 0);
  const cost =
    landed *
    (1 + flete) *
    (1 + arancel) *
    (1 + admin) *
    (1 + storage);
  return Math.round(cost * 1e4) / 1e4;
}

/**
 * Precio USD con markup, comisión plataforma, picking solo ML; tres precios en Bs.
 */
function calculateChannelPrice(costoOpUsd, policy, settings, rates, channel) {
  const cost = Number(costoOpUsd);
  const markup = Number(policy.markup_pct);
  const commission = Number(policy.commission_pct || 0);
  const picking = Number(settings.picking_packing_usd || 0);
  const bcv = Number(rates.bcv_rate);
  const binance = Number(rates.binance_rate);
  const adjusted = Number(rates.adjusted_rate);
  const ch = String(channel || '').toLowerCase();

  if (!Number.isFinite(cost) || cost < 0) {
    throwPricing(PRICING_ERROR_CODES.INVALID_COST, 'costoOpUsd inválido', { costoOpUsd });
  }
  if (!Number.isFinite(markup) || markup < 0) {
    throw new Error('calculateChannelPrice: markup_pct inválido');
  }
  if (!Number.isFinite(commission) || commission < 0 || commission >= 1) {
    throw new Error('calculateChannelPrice: commission_pct debe ser < 1 (decimal)');
  }
  if (!Number.isFinite(bcv) || bcv <= 0) throw new Error('calculateChannelPrice: bcv_rate inválida');
  if (!Number.isFinite(binance) || binance <= 0) {
    throw new Error('calculateChannelPrice: binance_rate inválida');
  }
  if (!Number.isFinite(adjusted) || adjusted <= 0) {
    throw new Error('calculateChannelPrice: adjusted_rate inválida');
  }

  let priceUsd = cost * (1 + markup);
  if (commission > 0) {
    priceUsd = priceUsd / (1 - commission);
  }
  if (ch === 'ml') {
    priceUsd += picking;
  }
  priceUsd = Math.round(priceUsd * 1e6) / 1e6;

  const netToSeller = priceUsd * (1 - commission);
  const marginUsd = Math.round((netToSeller - cost) * 1e4) / 1e4;
  const marginPct = netToSeller > 0 ? Math.round((marginUsd / netToSeller) * 1e6) / 1e6 : 0;

  const priceBsBcv = Math.round(priceUsd * bcv * 100) / 100;
  const priceBsBinance = Math.round(priceUsd * binance * 100) / 100;
  const priceBsAjuste = Math.round(priceUsd * adjusted * 100) / 100;

  return {
    price_usd: priceUsd,
    price_bs_bcv: priceBsBcv,
    price_bs_binance: priceBsBinance,
    price_bs_ajuste: priceBsAjuste,
    margin_usd: marginUsd,
    margin_pct: marginPct,
  };
}

function snapshotPayload(financialSettings, policy, rates, rawPolicyLevel) {
  const fs = { ...financialSettings };
  delete fs.updated_at;
  const pol = { ...policy };
  delete pol.updated_at;
  delete pol.created_at;
  return {
    financial_settings: fs,
    pricing_policies: pol,
    policy_level_used: rawPolicyLevel,
    rates: {
      rate_date: rates.rate_date,
      bcv_rate: rates.bcv_rate,
      binance_rate: rates.binance_rate,
      adjusted_rate: rates.adjusted_rate,
    },
  };
}

/**
 * Recalcula product_prices; carga settings y tasas una sola vez al inicio.
 */
async function runPricingUpdate(opts = {}) {
  const companyId = Number(opts.companyId) || 1;
  const batchSize = Math.min(Math.max(Number(opts.batchSize) || 200, 1), 500);
  const channelsFilter = Array.isArray(opts.channels) ? opts.channels.map(String) : null;

  const financialSettings = await getFinancialSettings(companyId);
  const rates = await getTodayRates(companyId);

  let channels =
    channelsFilter && channelsFilter.length
      ? channelsFilter
      : (
          await pool.query(
            `SELECT DISTINCT channel
             FROM pricing_policies
             WHERE company_id = $1 AND is_active = TRUE AND level = 'global'
             ORDER BY channel`,
            [companyId]
          )
        ).rows.map((r) => r.channel);

  channels = [...new Set(channels.map((c) => String(c).trim()).filter(Boolean))];
  if (!channels.length) {
    throw new Error('runPricingUpdate: no hay canales en pricing_policies');
  }

  const summary = {
    company_id: companyId,
    rate_date: rates.rate_date,
    channels,
    upserted: 0,
    skipped_no_landed: 0,
    skipped_no_policy: 0,
    errors: [],
  };

  const insertSql = `
    INSERT INTO product_prices (
      product_id, channel,
      price_usd, price_bs_bcv, price_bs_binance, price_bs_ajuste,
      landed_cost_usd, costo_operativo_usd,
      bcv_rate, binance_rate, adjusted_rate, rate_date,
      margin_usd, margin_pct,
      policy_snapshot
    ) VALUES (
      $1, $2,
      $3, $4, $5, $6,
      $7, $8,
      $9, $10, $11, $12::date,
      $13, $14,
      $15::jsonb
    )
    ON CONFLICT (product_id, channel) DO UPDATE SET
      price_usd = EXCLUDED.price_usd,
      price_bs_bcv = EXCLUDED.price_bs_bcv,
      price_bs_binance = EXCLUDED.price_bs_binance,
      price_bs_ajuste = EXCLUDED.price_bs_ajuste,
      landed_cost_usd = EXCLUDED.landed_cost_usd,
      costo_operativo_usd = EXCLUDED.costo_operativo_usd,
      bcv_rate = EXCLUDED.bcv_rate,
      binance_rate = EXCLUDED.binance_rate,
      adjusted_rate = EXCLUDED.adjusted_rate,
      rate_date = EXCLUDED.rate_date,
      margin_usd = EXCLUDED.margin_usd,
      margin_pct = EXCLUDED.margin_pct,
      policy_snapshot = EXCLUDED.policy_snapshot,
      calculated_at = NOW()
  `;

  for (const channel of channels) {
    let offset = 0;
    for (;;) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows: products } = await client.query(
          `SELECT p.id, p.landed_cost_usd, p.category_id
           FROM products p
           WHERE p.is_active = TRUE
           ORDER BY p.id
           LIMIT $1 OFFSET $2`,
          [batchSize, offset]
        );

        if (!products.length) {
          await client.query('COMMIT');
          break;
        }

        for (const p of products) {
          if (p.landed_cost_usd == null) {
            summary.skipped_no_landed += 1;
            log.debug({ productId: p.id }, 'runPricingUpdate: landed_cost_usd NULL, omitido');
            continue;
          }

          const landed = Number(p.landed_cost_usd);
          if (!Number.isFinite(landed) || landed <= 0) {
            summary.skipped_no_landed += 1;
            log.debug({ productId: p.id, landed }, 'runPricingUpdate: landed inválido, omitido');
            continue;
          }

          let policy;
          try {
            policy = await resolvePolicy(companyId, channel, p.category_id, client);
          } catch (e) {
            if (e instanceof PricingError && e.code === PRICING_ERROR_CODES.NO_POLICY_FOUND) {
              summary.skipped_no_policy += 1;
              continue;
            }
            throw e;
          }

          let costoOp;
          try {
            costoOp = computeOperationalCost(landed, financialSettings);
          } catch (e) {
            if (e instanceof PricingError && e.code === PRICING_ERROR_CODES.INVALID_COST) {
              summary.skipped_no_landed += 1;
              log.debug({ productId: p.id }, 'runPricingUpdate: INVALID_COST en landed');
              continue;
            }
            throw e;
          }

          const prices = calculateChannelPrice(costoOp, policy, financialSettings, rates, channel);
          const snapshot = snapshotPayload(financialSettings, policy, rates, policy.level);

          await client.query(insertSql, [
            p.id,
            channel,
            prices.price_usd,
            prices.price_bs_bcv,
            prices.price_bs_binance,
            prices.price_bs_ajuste,
            landed,
            costoOp,
            rates.bcv_rate,
            rates.binance_rate,
            rates.adjusted_rate,
            rates.rate_date,
            prices.margin_usd,
            prices.margin_pct,
            JSON.stringify(snapshot),
          ]);
          summary.upserted += 1;
        }

        await client.query('COMMIT');
        offset += products.length;
        if (products.length < batchSize) break;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          /* ignore */
        }
        log.error({ err: err.message, channel, offset }, 'runPricingUpdate: lote fallido');
        summary.errors.push({ channel, offset, message: err.message });
        break;
      } finally {
        client.release();
      }
    }
  }

  return summary;
}

/** @deprecated usar getTodayRates */
async function getLatestRatesRow(companyId, q = pool) {
  const r = await getTodayRates(companyId, q);
  return {
    rate_date: r.rate_date,
    bcv_rate: r.bcv_rate,
    binance_rate: r.binance_rate,
    adjusted_rate: r.adjusted_rate,
  };
}

module.exports = {
  PRICING_ERROR_CODES,
  PricingError,
  getTodayRates,
  getFinancialSettings,
  resolvePolicy,
  computeOperationalCost,
  calculateChannelPrice,
  runPricingUpdate,
  getLatestRatesRow,
};
