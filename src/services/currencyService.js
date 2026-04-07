require("../../load-env-local");

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");
const { EventEmitter } = require("events");
const { pool } = require("../../db-postgres");

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
/** BCV devuelve HTML grande (~400KB); 8s suele ser poco desde cloud / redes lentas */
const BCV_FETCH_TIMEOUT_MS_DEFAULT = 28_000;
const FETCH_MAX_RETRIES = 3;
const BINANCE_P2P_URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
/** Página de intervención (misma que suele usarse en FileMaker); override: BCV_URL en env */
const BCV_URL_DEFAULT = "https://www.bcv.org.ve/politica-cambiaria/intervencion-cambiaria";
const BCV_URL_FALLBACK = "https://www.bcv.org.ve/";
const MAX_RATE_SANITY = 10_000_000;
const MIN_RATE_SANITY = 0.000001;

let _cache = {
  data: null,
  cachedAt: null,
  companyId: null,
};

function _cacheIsValid(companyId) {
  return (
    _cache.data !== null &&
    _cache.companyId === companyId &&
    Date.now() - _cache.cachedAt < CACHE_TTL_MS
  );
}

function invalidateTodayRateCache() {
  _cache = { data: null, cachedAt: null, companyId: null };
}

function timingSafeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a ?? ""));
    const bufB = Buffer.from(String(b ?? ""));
    if (bufA.length !== bufB.length) {
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function parseVenezuelanNumber(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;

  let normalized;
  if (str.includes(",") && str.includes(".")) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = str.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = str.replace(/,/g, "");
    }
  } else if (str.includes(",")) {
    normalized = str.replace(",", ".");
  } else {
    normalized = str;
  }

  const value = parseFloat(normalized);
  if (Number.isNaN(value)) return null;
  if (value <= MIN_RATE_SANITY) return null;
  if (value > MAX_RATE_SANITY) return null;
  return value;
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values]
    .filter((v) => typeof v === "number" && v > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function fetchWithRetry(url, options = {}, attempt = 1) {
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : FETCH_TIMEOUT_MS;
  const { timeoutMs: _timeoutDrop, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timer);
    if (res.status >= 400 && res.status < 500) {
      throw Object.assign(new Error(`HTTP ${res.status} - permanent error, no retry`), {
        permanent: true,
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.permanent || attempt >= FETCH_MAX_RETRIES) throw err;
    const backoffMs = 1000 * Math.pow(2, attempt - 1);
    await new Promise((r) => setTimeout(r, backoffMs));
    return fetchWithRetry(url, options, attempt + 1);
  }
}

/**
 * GET HTTPS sin undici/fetch (evita timeouts y TLS distintos en algunos entornos).
 * BCV_TLS_INSECURE=1 → rejectUnauthorized: false (solo si la cadena del sitio falla en el servidor).
 */
function fetchBcvHtmlNative(urlString, timeoutMs, insecureTls) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlString);
    } catch (e) {
      reject(e);
      return;
    }
    if (u.protocol !== "https:") {
      reject(new Error("bcv_url_must_be_https"));
      return;
    }
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        "Accept-Language": "es-VE,es;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      ...(insecureTls ? { rejectUnauthorized: false } : {}),
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 400 && res.statusCode < 500) {
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { permanent: true }));
        return;
      }
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
      });
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("bcv_fetch_timeout"));
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

function bcvPrimaryUrl() {
  const fromEnv = process.env.BCV_URL != null ? String(process.env.BCV_URL).trim() : "";
  return fromEnv || BCV_URL_DEFAULT;
}

function extractBcvRateFromHtml(html) {
  const h = String(html || "").replace(/\u00a0/g, " ");
  const patterns = [
    // Bloque USD: columna centrado con el número (más específico que el primer <strong> genérico)
    /<div[^>]*\bid=['"]dolar['"][^>]*>[\s\S]*?<div[^>]*class="[^"]*centrado[^"]*"[^>]*>\s*<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i,
    /<div[^>]*\bid=['"]dolar['"][^>]*>[\s\S]*?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i,
    /<strong[^>]*id=['"]dolar['"][^>]*>([\d.,]+)<\/strong>/i,
    /id\s*=\s*["']dolar["'][^>]*>([\d.,]+)</i,
    /D[oó]lar\s+estadounidense[\s\S]{0,800}?<strong[^>]*>([\d.,]+)<\/strong>/i,
    /USD[\s\S]{0,600}?<strong[^>]*>([\d.,]+)<\/strong>/i,
    /D[oó]lar[\s\S]{0,600}?<strong[^>]*>([\d.,]+)<\/strong>/i,
  ];
  for (const pattern of patterns) {
    const match = h.match(pattern);
    if (match && match[1]) {
      const value = parseVenezuelanNumber(match[1]);
      if (value) return value;
    }
  }
  return null;
}

async function scrapeBCV() {
  const primary = bcvPrimaryUrl();
  const urls = [...new Set([primary, BCV_URL_FALLBACK])];
  let lastSource = primary;
  const timeoutMs = Math.max(
    10_000,
    Number(process.env.BCV_FETCH_TIMEOUT_MS) || BCV_FETCH_TIMEOUT_MS_DEFAULT
  );
  const insecureTls = process.env.BCV_TLS_INSECURE === "1";
  for (const url of urls) {
    lastSource = url;
    let html = "";
    try {
      html = await fetchBcvHtmlNative(url, timeoutMs, insecureTls);
    } catch (e) {
      console.warn("[bcv scrape] GET falló:", url, e && e.message ? e.message : e);
      continue;
    }
    if (!html || html.length < 800) {
      console.warn("[bcv scrape] HTML corto o vacío:", url, "len=", html ? html.length : 0);
      continue;
    }
    if (!/id=['"]dolar['"]/i.test(html)) {
      console.warn("[bcv scrape] sin bloque #dolar en HTML (posible captcha/redirección):", url);
    }
    const rate = extractBcvRateFromHtml(html);
    if (rate) return { rate, sourceUrl: url };
    console.warn("[bcv scrape] no se pudo parsear tasa Bs/USD:", url, "html_len=", html.length);
  }
  return { rate: null, sourceUrl: lastSource };
}

async function fetchBinance() {
  const body = JSON.stringify({
    fiat: "VES",
    asset: "USDT",
    tradeType: "BUY",
    page: 1,
    rows: 10,
    publisherType: null,
  });
  const res = await fetchWithRetry(BINANCE_P2P_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0",
    },
    body,
  });
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw Object.assign(new Error(`Binance parse error: ${e.message || e}`), { permanent: true });
  }
  const prices = (json && Array.isArray(json.data) ? json.data : [])
    .map((ad) => parseVenezuelanNumber(ad && ad.adv ? ad.adv.price : null))
    .filter((p) => p !== null);
  return {
    rate: median(prices),
    sourceUrl: BINANCE_P2P_URL,
  };
}

const currencyEvents = new EventEmitter();
let schemaReadyPromise = null;

async function ensureCurrencySchema() {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    await pool.query(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_type') THEN
    CREATE TYPE rate_type AS ENUM ('BCV', 'BINANCE', 'ADJUSTED');
  END IF;
END $$;`);

    await pool.query(`
CREATE TABLE IF NOT EXISTS daily_exchange_rates (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT 1,
  rate_date DATE NOT NULL,
  bcv_rate NUMERIC(15,6),
  binance_rate NUMERIC(15,6),
  adjusted_rate NUMERIC(15,6),
  active_rate_type rate_type NOT NULL DEFAULT 'BCV',
  active_rate NUMERIC(15,6) GENERATED ALWAYS AS (
    CASE active_rate_type
      WHEN 'BCV' THEN bcv_rate
      WHEN 'BINANCE' THEN binance_rate
      WHEN 'ADJUSTED' THEN adjusted_rate
      ELSE NULL
    END
  ) STORED,
  is_manual_override BOOLEAN NOT NULL DEFAULT FALSE,
  spread_alert_pct NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  spread_current_pct NUMERIC(5,2) GENERATED ALWAYS AS (
    CASE WHEN bcv_rate > 0
      THEN ROUND((((binance_rate - bcv_rate) / bcv_rate) * 100)::numeric, 2)
    END
  ) STORED,
  spread_alert_triggered BOOLEAN GENERATED ALWAYS AS (
    binance_rate IS NOT NULL AND bcv_rate > 0 AND
    ((binance_rate - bcv_rate) / bcv_rate * 100) > spread_alert_pct
  ) STORED,
  bcv_fetched_at TIMESTAMPTZ,
  bcv_source_url TEXT,
  binance_fetched_at TIMESTAMPTZ,
  binance_source_url TEXT,
  overridden_by_user_id INTEGER,
  overridden_at TIMESTAMPTZ,
  override_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_rate_date UNIQUE (company_id, rate_date),
  CONSTRAINT chk_bcv_positive CHECK (bcv_rate IS NULL OR bcv_rate > 0),
  CONSTRAINT chk_binance_positive CHECK (binance_rate IS NULL OR binance_rate > 0),
  CONSTRAINT chk_adjusted_positive CHECK (adjusted_rate IS NULL OR adjusted_rate > 0)
);`);

    await pool.query(`DROP VIEW IF EXISTS v_product_prices_bs`);
    await pool.query(`ALTER TABLE daily_exchange_rates DROP COLUMN IF EXISTS active_rate`);
    await pool.query(`
ALTER TABLE daily_exchange_rates
ADD COLUMN active_rate NUMERIC(15,6) GENERATED ALWAYS AS (
  CASE active_rate_type
    WHEN 'BCV' THEN bcv_rate
    WHEN 'BINANCE' THEN binance_rate
    WHEN 'ADJUSTED' THEN adjusted_rate
    ELSE NULL
  END
) STORED`);

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_der_company_date ON daily_exchange_rates (company_id, rate_date DESC)`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_der_company_date_valid ON daily_exchange_rates (company_id, rate_date DESC) WHERE active_rate IS NOT NULL`
    );

    await pool.query(`
CREATE OR REPLACE FUNCTION set_updated_at_daily_exchange_rates()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;`);
    await pool.query(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_der_updated_at') THEN
    CREATE TRIGGER trg_der_updated_at
    BEFORE UPDATE ON daily_exchange_rates
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at_daily_exchange_rates();
  END IF;
END $$;`);

    await pool.query(`
CREATE TABLE IF NOT EXISTS exchange_rate_audit_log (
  id BIGSERIAL PRIMARY KEY,
  rate_id BIGINT REFERENCES daily_exchange_rates(id),
  action TEXT NOT NULL,
  field_changed TEXT,
  old_value NUMERIC(15,6),
  new_value NUMERIC(15,6),
  performed_by INTEGER,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB
);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eral_rate_id ON exchange_rate_audit_log (rate_id)`);

    try {
      await pool.query(`
CREATE OR REPLACE VIEW v_product_prices_bs AS
SELECT
  p.sku,
  p.descripcion,
  p.precio_usd AS price_usd,
  last_rate.rate_date,
  last_rate.active_rate_type,
  last_rate.active_rate,
  last_rate.spread_alert_triggered,
  ROUND((p.precio_usd * last_rate.active_rate)::numeric, 2) AS price_bs,
  ROUND((p.precio_usd * COALESCE(last_rate.bcv_rate, last_rate.active_rate))::numeric, 2) AS price_bs_bcv,
  ROUND((p.precio_usd * COALESCE(last_rate.binance_rate, last_rate.active_rate))::numeric, 2) AS price_bs_binance,
  ROUND((p.precio_usd * 1.03)::numeric, 4) AS price_usd_igtf
FROM productos p
CROSS JOIN LATERAL (
  SELECT rate_date, active_rate_type, active_rate, bcv_rate, binance_rate, spread_alert_triggered
  FROM daily_exchange_rates
  WHERE company_id = 1
    AND rate_date <= CURRENT_DATE
    AND active_rate IS NOT NULL
  ORDER BY rate_date DESC
  LIMIT 1
) last_rate`);
    } catch (e) {
      console.warn("[currency] v_product_prices_bs omitida:", e.message || e);
    }
  })();
  return schemaReadyPromise;
}

async function insertAuditLog(client, { rateId, action, fieldChanged, oldValue, newValue, userId, metadata }) {
  await client.query(
    `INSERT INTO exchange_rate_audit_log
       (rate_id, action, field_changed, old_value, new_value, performed_by, metadata)
     VALUES ($1::bigint, $2::text, $3::text, $4::numeric, $5::numeric, $6::integer, $7::jsonb)`,
    [
      rateId ?? null,
      action,
      fieldChanged ?? null,
      oldValue ?? null,
      newValue ?? null,
      userId ?? null,
      metadata != null ? metadata : null,
    ]
  );
}

async function fetchAndSaveDailyRates(companyId = 1) {
  await ensureCurrencySchema();
  const today = new Date().toISOString().split("T")[0];
  const [bcvResult, binanceResult] = await Promise.allSettled([
    scrapeBCV().catch((err) => ({ rate: null, sourceUrl: bcvPrimaryUrl(), error: err.message })),
    fetchBinance().catch((err) => ({ rate: null, sourceUrl: BINANCE_P2P_URL, error: err.message })),
  ]);
  const bcv = bcvResult.value || { rate: null, sourceUrl: bcvPrimaryUrl() };
  const binance = binanceResult.value || { rate: null, sourceUrl: BINANCE_P2P_URL };
  const bothFailed = bcv.rate === null && binance.rate === null;
  const action = bothFailed ? "FETCH_FAILED" : "AUTO_FETCH";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO daily_exchange_rates
         (company_id, rate_date, bcv_rate, binance_rate, active_rate_type,
          bcv_fetched_at, bcv_source_url, binance_fetched_at, binance_source_url)
       VALUES ($1::integer, $2::date, $3::numeric, $4::numeric,
         CASE
           WHEN $3 IS NOT NULL THEN 'BCV'::rate_type
           WHEN $4 IS NOT NULL THEN 'BINANCE'::rate_type
           ELSE 'BCV'::rate_type
         END,
         $5::timestamptz, $6::text, $7::timestamptz, $8::text)
       ON CONFLICT (company_id, rate_date) DO UPDATE SET
         bcv_rate = EXCLUDED.bcv_rate,
         binance_rate = EXCLUDED.binance_rate,
         bcv_fetched_at = EXCLUDED.bcv_fetched_at,
         bcv_source_url = EXCLUDED.bcv_source_url,
         binance_fetched_at = EXCLUDED.binance_fetched_at,
         binance_source_url = EXCLUDED.binance_source_url,
         active_rate_type = EXCLUDED.active_rate_type,
         updated_at = now()
       WHERE NOT daily_exchange_rates.is_manual_override
       RETURNING id, spread_alert_triggered, spread_current_pct`,
      [
        Number(companyId) || 1,
        today,
        bcv.rate ?? null,
        binance.rate ?? null,
        bcv.rate != null ? new Date() : null,
        bcv.sourceUrl ?? null,
        binance.rate != null ? new Date() : null,
        binance.sourceUrl ?? null,
      ]
    );
    const rateId = rows[0] ? rows[0].id : null;
    const spreadTriggered = rows[0] ? rows[0].spread_alert_triggered : false;

    await insertAuditLog(client, {
      rateId,
      action,
      metadata: {
        bcv_rate: bcv.rate,
        binance_rate: binance.rate,
        bcv_error: bcv.error || null,
        binance_error: binance.error || null,
        both_failed: bothFailed,
      },
    });
    if (spreadTriggered) {
      await insertAuditLog(client, {
        rateId,
        action: "ALERT_TRIGGERED",
        metadata: { spread_pct: rows[0].spread_current_pct },
      });
      currencyEvents.emit("exchange:spread_alert", {
        companyId: Number(companyId) || 1,
        rateDate: today,
        spreadCurrentPct: rows[0].spread_current_pct,
      });
    }
    await client.query("COMMIT");
    invalidateTodayRateCache();
    return { success: true, action, rateId, bothFailed, spreadTriggered };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function manualOverride({ userId, companyId = 1, rateDate, field, value, reason }) {
  await ensureCurrencySchema();
  const VALID_FIELDS = ["bcv_rate", "binance_rate", "adjusted_rate", "active_rate_type"];
  if (!VALID_FIELDS.includes(field)) {
    throw new Error(`Campo inválido: ${field}. Permitidos: ${VALID_FIELDS.join(", ")}`);
  }
  const parsedValue = field === "active_rate_type" ? String(value || "").trim().toUpperCase() : parseVenezuelanNumber(value);
  if (field === "active_rate_type" && !["BCV", "BINANCE", "ADJUSTED"].includes(parsedValue)) {
    throw new Error(`Valor inválido para ${field}: "${value}"`);
  }
  if (field !== "active_rate_type" && parsedValue === null) {
    throw new Error(`Valor inválido para ${field}: "${value}"`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const prev = await client.query(
      `SELECT id, ${field} AS old_val FROM daily_exchange_rates WHERE company_id = $1 AND rate_date = $2::date`,
      [Number(companyId) || 1, rateDate]
    );
    const { rows } = await client.query(
      `INSERT INTO daily_exchange_rates
         (company_id, rate_date, ${field}, is_manual_override, overridden_by_user_id, overridden_at, override_reason)
       VALUES ($1,$2::date,$3,TRUE,$4,now(),$5)
       ON CONFLICT (company_id, rate_date) DO UPDATE SET
         ${field} = EXCLUDED.${field},
         is_manual_override = TRUE,
         overridden_by_user_id = EXCLUDED.overridden_by_user_id,
         overridden_at = EXCLUDED.overridden_at,
         override_reason = EXCLUDED.override_reason,
         updated_at = now()
       RETURNING id`,
      [Number(companyId) || 1, rateDate, parsedValue, Number(userId) || null, reason ?? null]
    );
    await insertAuditLog(client, {
      rateId: rows[0].id,
      action: "MANUAL_OVERRIDE",
      fieldChanged: field,
      oldValue: prev.rows[0] ? prev.rows[0].old_val : null,
      newValue: parsedValue,
      userId: Number(userId) || null,
      metadata: { reason, rateDate },
    });
    await client.query("COMMIT");
    invalidateTodayRateCache();
    return { success: true, rateId: rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function _fetchTodayRateFromDB(companyId) {
  const { rows } = await pool.query(
    `SELECT rate_date, active_rate_type, active_rate,
            bcv_rate, binance_rate, adjusted_rate,
            is_manual_override, spread_alert_triggered, spread_current_pct
     FROM daily_exchange_rates
     WHERE company_id = $1
       AND rate_date <= CURRENT_DATE
       AND active_rate IS NOT NULL
     ORDER BY rate_date DESC
     LIMIT 1`,
    [companyId]
  );
  return rows[0] || null;
}

async function getTodayRate(companyId = 1) {
  const cid = Number(companyId) || 1;
  if (_cacheIsValid(cid)) return _cache.data;
  await ensureCurrencySchema();
  const data = await _fetchTodayRateFromDB(cid);
  _cache = { data, cachedAt: Date.now(), companyId: cid };
  return data;
}

async function getRateHistory({ companyId = 1, fromDate, toDate, page = 1, pageSize = 30 }) {
  await ensureCurrencySchema();
  const limit = Math.min(parseInt(pageSize, 10) || 30, 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  const { rows } = await pool.query(
    `SELECT rate_date, bcv_rate, binance_rate, adjusted_rate,
            active_rate_type, active_rate,
            is_manual_override, spread_current_pct, spread_alert_triggered,
            overridden_by_user_id, override_reason, created_at
     FROM daily_exchange_rates
     WHERE company_id = $1
       AND rate_date BETWEEN $2::date AND $3::date
     ORDER BY rate_date DESC
     LIMIT $4 OFFSET $5`,
    [Number(companyId) || 1, fromDate, toDate, limit, offset]
  );
  return rows;
}

async function getProductPrices({ companyId = 1, search = null, page = 1, limit = 50 }) {
  await ensureCurrencySchema();
  const safeLimit = Math.min(parseInt(limit, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * safeLimit;
  const { rows } = await pool.query(
    `SELECT
       p.sku,
       p.descripcion,
       p.precio_usd AS price_usd,
       der.rate_date,
       der.active_rate_type,
       der.active_rate,
       der.spread_alert_triggered,
       ROUND((p.precio_usd * der.active_rate)::numeric, 2) AS price_bs,
       ROUND((p.precio_usd * 1.03)::numeric, 4) AS price_usd_igtf
     FROM productos p
     CROSS JOIN LATERAL (
       SELECT rate_date, active_rate_type, active_rate, spread_alert_triggered
       FROM daily_exchange_rates
       WHERE company_id = $1
         AND rate_date <= CURRENT_DATE
         AND active_rate IS NOT NULL
       ORDER BY rate_date DESC
       LIMIT 1
     ) der
     WHERE ($2::text IS NULL
        OR p.sku ILIKE '%' || $2 || '%'
        OR p.descripcion ILIKE '%' || $2 || '%')
     ORDER BY p.descripcion
     LIMIT $3 OFFSET $4`,
    [Number(companyId) || 1, search || null, safeLimit, offset]
  );
  return rows;
}

module.exports = {
  CACHE_TTL_MS,
  currencyEvents,
  ensureCurrencySchema,
  timingSafeCompare,
  parseVenezuelanNumber,
  invalidateTodayRateCache,
  fetchAndSaveDailyRates,
  scrapeBCV,
  manualOverride,
  getTodayRate,
  getRateHistory,
  getProductPrices,
};

