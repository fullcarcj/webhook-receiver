'use strict';

/**
 * currencyUtils.js — Utilidades de tipo ERP para conversión de monedas e impuestos.
 *
 * Complementa currencyService.js (scraper BCV + override manual).
 * Este módulo se enfoca en consultas históricas exactas:
 *   - Tasa vigente en una fecha pasada (reconstrucción de facturas)
 *   - Conversión de montos con precisión integer (sin float nativo)
 *   - Regla fiscal vigente en una fecha (IVA, IGTF, retenciones)
 *
 * REGLA: NUNCA usar Number() para montos — solo BigInt o strings NUMERIC de pg.
 */

const { pool } = require('../../db-postgres');

// ─── getExchangeRate ──────────────────────────────────────────────────────────

/**
 * Devuelve la tasa de cambio más reciente en o antes de `date`.
 * Consulta daily_exchange_rates — fuente única de verdad para tasas.
 *
 * @param {number} companyId
 * @param {string} from  Código ISO 4217 (ej. 'USD')
 * @param {string} to    Código ISO 4217 (ej. 'VES')
 * @param {string|Date} [date]  YYYY-MM-DD; si se omite usa hoy
 * @returns {Promise<{
 *   active_rate: string,
 *   bcv_rate: string|null,
 *   binance_rate: string|null,
 *   active_rate_type: string,
 *   rate_date: Date,
 *   from_currency: string,
 *   to_currency: string
 * }>}
 * @throws {{ code: 'NO_EXCHANGE_RATE' }} si no hay tasa disponible
 */
async function getExchangeRate(companyId, from, to, date) {
  const targetDate = date
    ? (date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10))
    : new Date().toISOString().slice(0, 10);

  // Mismo par — tasa es 1 (exacto, sin consulta)
  if (from === to) {
    return {
      active_rate:      '1.000000',
      bcv_rate:         '1.000000',
      binance_rate:     null,
      active_rate_type: 'MANUAL',
      rate_date:        new Date(targetDate),
      from_currency:    from,
      to_currency:      to,
    };
  }

  // Par inverso: si pedimos VES→USD, buscamos USD→VES y devolvemos 1/rate
  const normalizedFrom = from;
  const normalizedTo   = to;

  const { rows } = await pool.query(
    `SELECT
       active_rate,
       bcv_rate,
       binance_rate,
       active_rate_type,
       rate_date,
       COALESCE(from_currency, 'USD') AS from_currency,
       COALESCE(to_currency,   'VES') AS to_currency
     FROM daily_exchange_rates
     WHERE company_id      = $1
       AND COALESCE(from_currency, 'USD') = $2
       AND COALESCE(to_currency,   'VES') = $3
       AND rate_date       <= $4::date
       AND active_rate     IS NOT NULL
     ORDER BY rate_date DESC
     LIMIT 1`,
    [companyId, normalizedFrom, normalizedTo, targetDate]
  );

  if (!rows.length) {
    throw Object.assign(
      new Error(
        `Sin tasa de cambio ${from}→${to} para empresa ${companyId} en o antes de ${targetDate}. ` +
        `Ejecutar npm run fetch-rates o registrar manualmente en /api/currency/override.`
      ),
      { code: 'NO_EXCHANGE_RATE', companyId, from, to, date: targetDate }
    );
  }

  return rows[0];
}

// ─── convertAmount ────────────────────────────────────────────────────────────

/**
 * Convierte un monto usando aritmética de enteros (BigInt).
 * NUNCA usa operaciones float nativas de JavaScript.
 *
 * Los montos y tasas que vienen de PostgreSQL NUMERIC llegan como strings.
 *
 * @param {string|number} amount  Monto origen (ej. '100.00')
 * @param {string|number} rate    Tasa (ej. '36.450000')
 * @param {number} [decimalPlaces=2]  Decimales del resultado
 * @returns {string}  Resultado como string NUMERIC (ej. '3645.00')
 */
function convertAmount(amount, rate, decimalPlaces = 2) {
  const [aInt, aDec = ''] = String(amount).split('.');
  const [rInt, rDec = ''] = String(rate).split('.');

  const aDecLen = aDec.length;
  const rDecLen = rDec.length;
  const totalDec = aDecLen + rDecLen;

  const aBig = BigInt(aInt + aDec.padEnd(aDecLen, '0'));
  const rBig = BigInt(rInt + rDec.padEnd(rDecLen, '0'));
  const resultBig = aBig * rBig;

  const resultStr = resultBig.toString();
  const intPart  = resultStr.length > totalDec
    ? resultStr.slice(0, resultStr.length - totalDec)
    : '0';
  const decFull  = resultStr.slice(resultStr.length - totalDec).padStart(totalDec, '0');

  // Redondear a decimalPlaces
  const keep = decFull.slice(0, decimalPlaces);
  const next = parseInt(decFull[decimalPlaces] || '0', 10);
  const decPart = next >= 5
    ? String(BigInt(keep || '0') + 1n).padStart(decimalPlaces, '0')
    : (keep || '').padEnd(decimalPlaces, '0');

  return `${intPart}.${decPart}`;
}

// ─── getTaxForTransaction ─────────────────────────────────────────────────────

/**
 * Devuelve la regla fiscal vigente en `date`.
 * Permite reconstruir facturas históricas correctamente.
 *
 * Fuentes:
 *   - IGTF              → igtf_config (ya maneja historicidad con effective_from)
 *   - IVA, retenciones  → settings_tax (KEY→VALUE con effective_from)
 *
 * @param {number} companyId
 * @param {'IVA'|'IVA_REDUCIDO'|'IVA_RETENIDO'|'ISLR_RETENIDO'|'IGTF'} taxType
 * @param {string|Date} [date]  YYYY-MM-DD; si se omite usa hoy
 * @returns {Promise<{ taxType, rate: string, effectiveFrom: Date, source: string }>}
 * @throws {{ code: 'NO_TAX_CONFIG' }} si no hay regla vigente
 */
async function getTaxForTransaction(companyId, taxType, date) {
  const targetDate = date
    ? (date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10))
    : new Date().toISOString().slice(0, 10);

  if (taxType === 'IGTF') {
    const { rows } = await pool.query(
      `SELECT rate_pct::TEXT AS rate, effective_from
       FROM igtf_config
       WHERE effective_from <= $1::date
       ORDER BY effective_from DESC
       LIMIT 1`,
      [targetDate]
    );
    if (!rows.length) {
      throw Object.assign(
        new Error(`Sin configuración IGTF vigente para la fecha ${targetDate}`),
        { code: 'NO_TAX_CONFIG', taxType, date: targetDate }
      );
    }
    return { taxType, rate: rows[0].rate, effectiveFrom: rows[0].effective_from, source: 'igtf_config' };
  }

  // settings_tax: key→value con effective_from historico
  const keyMap = {
    IVA:           'iva_rate_pct',
    IVA_REDUCIDO:  'iva_reduced_rate_pct',
    IVA_RETENIDO:  'iva_retencion_pct',
    ISLR_RETENIDO: 'islr_honorarios_pct',
  };
  const key = keyMap[taxType];
  if (!key) {
    throw Object.assign(
      new Error(`Tipo de impuesto no reconocido: "${taxType}". Valores válidos: ${Object.keys(keyMap).concat('IGTF').join(', ')}`),
      { code: 'UNKNOWN_TAX_TYPE', taxType }
    );
  }

  const { rows } = await pool.query(
    `SELECT value AS rate, effective_from
     FROM settings_tax
     WHERE company_id    = $1
       AND key           = $2
       AND effective_from <= $3::date
     ORDER BY effective_from DESC
     LIMIT 1`,
    [companyId, key, targetDate]
  );

  if (!rows.length) {
    throw Object.assign(
      new Error(
        `Sin configuración fiscal "${taxType}" (key="${key}") para empresa ${companyId} en ${targetDate}. ` +
        `Verificar settings_tax o ejecutar npm run db:fiscal-periods.`
      ),
      { code: 'NO_TAX_CONFIG', taxType, key, date: targetDate }
    );
  }

  return { taxType, key, rate: rows[0].rate, effectiveFrom: rows[0].effective_from, source: 'settings_tax' };
}

module.exports = { getExchangeRate, convertAmount, getTaxForTransaction };
