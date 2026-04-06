require("../../load-env-local");

const { EventEmitter } = require("events");
const { pool } = require("../../db-postgres");

const currencyEvents = new EventEmitter();

let schemaReadyPromise = null;

function toPositiveNumberOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetryAndTimeout(taskFn, label) {
  const maxAttempts = 3;
  const timeoutMs = 8000;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error(`${label} timeout`)), timeoutMs);
    try {
      const out = await taskFn({ signal: ctl.signal, attempt });
      clearTimeout(t);
      return out;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(250 * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

async function fetchBcvRate() {
  return withRetryAndTimeout(async ({ signal }) => {
    const url = "https://www.bcv.org.ve";
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) throw new Error(`BCV HTTP ${res.status}`);
    const html = await res.text();

    // BCV suele publicar "dolar" con número en formato local (coma decimal).
    const candidates = [
      /id=["']dolar["'][\s\S]*?<strong[^>]*>([\d.,]+)<\/strong>/i,
      /D[oó]lar[\s\S]{0,250}?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,6}))/i,
      /USD[\s\S]{0,250}?([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,6}))/i,
    ];
    for (const rx of candidates) {
      const m = html.match(rx);
      if (!m || !m[1]) continue;
      const raw = String(m[1]).trim();
      const normalized = raw.replace(/\./g, "").replace(",", ".");
      const rate = Number(normalized);
      if (Number.isFinite(rate) && rate > 0) {
        return { rate, sourceUrl: url, fetchedAt: new Date().toISOString() };
      }
    }
    throw new Error("BCV layout no reconocido");
  }, "BCV");
}

async function fetchBinanceRate() {
  return withRetryAndTimeout(async ({ signal }) => {
    const url = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
    const payload = {
      fiat: "VES",
      asset: "USDT",
      tradeType: "BUY",
      page: 1,
      rows: 5,
    };
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const json = await res.json();
    const arr = Array.isArray(json?.data) ? json.data : [];
    const prices = arr
      .map((x) => Number(x?.adv?.price))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 5);
    if (!prices.length) throw new Error("Binance sin precios");
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { rate: avg, sourceUrl: url, fetchedAt: new Date().toISOString(), samples: prices.length };
  }, "Binance");
}

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
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_der_company_date ON daily_exchange_rates (company_id, rate_date DESC)`
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
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_der_updated_at'
  ) THEN
    CREATE TRIGGER trg_der_updated_at
    BEFORE UPDATE ON daily_exchange_rates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at_daily_exchange_rates();
  END IF;
END $$;`);

    await pool.query(`
CREATE TABLE IF NOT EXISTS exchange_rate_audit_log (
  id BIGSERIAL PRIMARY KEY,
  rate_id BIGINT NOT NULL REFERENCES daily_exchange_rates(id),
  action TEXT NOT NULL,
  field_changed TEXT,
  old_value NUMERIC(15,6),
  new_value NUMERIC(15,6),
  performed_by INTEGER,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB
);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eral_rate_id ON exchange_rate_audit_log (rate_id)`);

    // El repo usa tabla `productos`, se proyecta al contrato solicitado.
    await pool.query(`
CREATE OR REPLACE VIEW v_product_prices_bs AS
SELECT
  p.id,
  p.sku,
  COALESCE(NULLIF(p.descripcion, ''), p.sku) AS name,
  p.precio_usd AS price_usd,
  1::integer AS company_id,
  der.rate_date,
  der.active_rate_type,
  der.active_rate,
  der.spread_alert_triggered,
  ROUND((p.precio_usd * der.active_rate)::numeric, 2) AS price_bs,
  ROUND((p.precio_usd * der.bcv_rate)::numeric, 2) AS price_bs_bcv,
  ROUND((p.precio_usd * COALESCE(der.binance_rate, der.bcv_rate))::numeric, 2) AS price_bs_binance,
  ROUND((p.precio_usd * COALESCE(der.adjusted_rate, der.active_rate))::numeric, 2) AS price_bs_adjusted,
  ROUND((p.precio_usd * 1.03)::numeric, 4) AS price_usd_with_igtf
FROM productos p
JOIN daily_exchange_rates der
  ON der.company_id = 1
 AND der.rate_date = (
   SELECT MAX(d2.rate_date)
   FROM daily_exchange_rates d2
   WHERE d2.company_id = 1 AND d2.rate_date <= CURRENT_DATE
 );`);
  })();
  return schemaReadyPromise;
}

async function fetchAndSaveDailyRates() {
  await ensureCurrencySchema();
  const companyIds = String(process.env.CURRENCY_COMPANY_IDS || "1")
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const companies = companyIds.length ? [...new Set(companyIds)] : [1];

  let bcv = null;
  let binance = null;
  try {
    bcv = await fetchBcvRate();
  } catch (e) {
    console.error("[currency] BCV fetch failed:", e.message || e);
  }
  try {
    binance = await fetchBinanceRate();
  } catch (e) {
    console.error("[currency] Binance fetch failed:", e.message || e);
  }

  const out = [];
  for (const companyId of companies) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const up = await client.query(
        `INSERT INTO daily_exchange_rates (
           company_id, rate_date, bcv_rate, binance_rate,
           bcv_fetched_at, bcv_source_url,
           binance_fetched_at, binance_source_url
         ) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, rate_date) DO UPDATE SET
           bcv_rate = EXCLUDED.bcv_rate,
           binance_rate = EXCLUDED.binance_rate,
           bcv_fetched_at = EXCLUDED.bcv_fetched_at,
           bcv_source_url = EXCLUDED.bcv_source_url,
           binance_fetched_at = EXCLUDED.binance_fetched_at,
           binance_source_url = EXCLUDED.binance_source_url
         WHERE NOT daily_exchange_rates.is_manual_override
         RETURNING *`,
        [
          companyId,
          bcv ? bcv.rate : null,
          binance ? binance.rate : null,
          bcv ? bcv.fetchedAt : null,
          bcv ? bcv.sourceUrl : null,
          binance ? binance.fetchedAt : null,
          binance ? binance.sourceUrl : null,
        ]
      );
      let row = up.rows[0] || null;
      if (!row) {
        const cur = await client.query(
          `SELECT * FROM daily_exchange_rates WHERE company_id = $1 AND rate_date = CURRENT_DATE`,
          [companyId]
        );
        row = cur.rows[0] || null;
      }
      if (!row) {
        await client.query("COMMIT");
        out.push({ companyId, ok: false, error: "no_rate_row" });
        continue;
      }

      await client.query(
        `INSERT INTO exchange_rate_audit_log (
           rate_id, action, field_changed, old_value, new_value, metadata
         ) VALUES ($1, 'AUTO_FETCH', NULL, NULL, NULL, $2::jsonb)`,
        [
          row.id,
          JSON.stringify({
            company_id: companyId,
            rate_date: row.rate_date,
            bcv_rate: bcv ? bcv.rate : null,
            binance_rate: binance ? binance.rate : null,
            is_manual_override: row.is_manual_override,
          }),
        ]
      );

      if (row.spread_alert_triggered === true) {
        await client.query(
          `INSERT INTO exchange_rate_audit_log (
             rate_id, action, field_changed, old_value, new_value, metadata
           ) VALUES ($1, 'ALERT_TRIGGERED', 'spread_current_pct', NULL, $2, $3::jsonb)`,
          [
            row.id,
            row.spread_current_pct,
            JSON.stringify({
              company_id: companyId,
              rate_date: row.rate_date,
              spread_current_pct: row.spread_current_pct,
              spread_alert_pct: row.spread_alert_pct,
            }),
          ]
        );
      }

      await client.query("COMMIT");
      out.push({ companyId, ok: true, row });
      if (row.spread_alert_triggered === true) {
        currencyEvents.emit("exchange:spread_alert", {
          companyId,
          rateDate: row.rate_date,
          spreadCurrentPct: row.spread_current_pct,
          spreadAlertPct: row.spread_alert_pct,
          bcvRate: row.bcv_rate,
          binanceRate: row.binance_rate,
        });
      }
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[currency] fetchAndSaveDailyRates company_id=%s:", companyId, e.message || e);
      out.push({ companyId, ok: false, error: String(e.message || e) });
    } finally {
      client.release();
    }
  }
  return {
    ok: true,
    fetched: {
      bcv_rate: bcv ? bcv.rate : null,
      binance_rate: binance ? binance.rate : null,
    },
    results: out,
  };
}

async function manualOverride({ userId, companyId, rateDate, field, value, reason }) {
  await ensureCurrencySchema();
  const uid = Number(userId);
  const cid = Number(companyId || 1);
  const d = rateDate && String(rateDate).trim() ? String(rateDate).trim() : new Date().toISOString().slice(0, 10);
  const allowed = new Set(["bcv_rate", "binance_rate", "adjusted_rate", "active_rate_type"]);
  if (!allowed.has(field)) throw new Error("field inválido");
  if (!Number.isFinite(cid) || cid <= 0) throw new Error("companyId inválido");

  let preparedValue = value;
  if (field === "active_rate_type") {
    const t = String(value || "").trim().toUpperCase();
    if (!["BCV", "BINANCE", "ADJUSTED"].includes(t)) throw new Error("active_rate_type inválido");
    preparedValue = t;
  } else {
    preparedValue = toPositiveNumberOrNull(value);
    if (preparedValue == null) throw new Error(`${field} debe ser número positivo`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT * FROM daily_exchange_rates WHERE company_id = $1 AND rate_date = $2::date FOR UPDATE`,
      [cid, d]
    );
    if (!cur.rows[0]) {
      await client.query(
        `INSERT INTO daily_exchange_rates (company_id, rate_date) VALUES ($1, $2::date)`,
        [cid, d]
      );
    }
    const before = cur.rows[0] || {};
    const oldValueRaw = before[field];
    const oldValueNum = toPositiveNumberOrNull(oldValueRaw);
    const upd = await client.query(
      `UPDATE daily_exchange_rates
       SET ${field} = $1,
           is_manual_override = TRUE,
           overridden_by_user_id = $2,
           overridden_at = now(),
           override_reason = $3
       WHERE company_id = $4 AND rate_date = $5::date
       RETURNING *`,
      [preparedValue, Number.isFinite(uid) && uid > 0 ? uid : null, reason ? String(reason) : null, cid, d]
    );
    const row = upd.rows[0];
    if (!row) throw new Error("no se pudo actualizar tasa");

    await client.query(
      `INSERT INTO exchange_rate_audit_log (
         rate_id, action, field_changed, old_value, new_value, performed_by, metadata
       ) VALUES ($1, 'MANUAL_OVERRIDE', $2, $3, $4, $5, $6::jsonb)`,
      [
        row.id,
        field,
        oldValueNum,
        field === "active_rate_type" ? null : preparedValue,
        Number.isFinite(uid) && uid > 0 ? uid : null,
        JSON.stringify({
          field,
          old_value_raw: oldValueRaw == null ? null : String(oldValueRaw),
          new_value_raw: preparedValue == null ? null : String(preparedValue),
          reason: reason || null,
        }),
      ]
    );

    await client.query("COMMIT");
    return row;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getTodayRate(companyId) {
  await ensureCurrencySchema();
  const cid = Number(companyId || 1);
  const { rows } = await pool.query(
    `SELECT *
     FROM daily_exchange_rates
     WHERE company_id = $1 AND rate_date <= CURRENT_DATE
     ORDER BY rate_date DESC
     LIMIT 1`,
    [cid]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    rateDate: r.rate_date,
    activeRateType: r.active_rate_type,
    activeRate: r.active_rate,
    bcvRate: r.bcv_rate,
    binanceRate: r.binance_rate,
    adjustedRate: r.adjusted_rate,
    isManualOverride: r.is_manual_override,
    spreadAlertTriggered: r.spread_alert_triggered,
  };
}

async function getRateHistory({ companyId, fromDate, toDate, page, pageSize }) {
  await ensureCurrencySchema();
  const cid = Number(companyId || 1);
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const offset = (p - 1) * ps;
  const from = fromDate && String(fromDate).trim() ? String(fromDate).trim() : "2000-01-01";
  const to = toDate && String(toDate).trim() ? String(toDate).trim() : "2999-12-31";

  const [{ rows: data }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT rate_date, bcv_rate, binance_rate, adjusted_rate,
              active_rate_type, active_rate, spread_current_pct,
              spread_alert_triggered, is_manual_override,
              overridden_by_user_id, override_reason
       FROM daily_exchange_rates
       WHERE company_id = $1 AND rate_date BETWEEN $2::date AND $3::date
       ORDER BY rate_date DESC
       LIMIT $4 OFFSET $5`,
      [cid, from, to, ps, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM daily_exchange_rates
       WHERE company_id = $1 AND rate_date BETWEEN $2::date AND $3::date`,
      [cid, from, to]
    ),
  ]);
  return {
    page: p,
    pageSize: ps,
    total: cnt[0] ? Number(cnt[0].total) : 0,
    rows: data,
  };
}

async function getProductPrices({ companyId, page, limit, search }) {
  await ensureCurrencySchema();
  const cid = Number(companyId || 1);
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));
  const offset = (p - 1) * l;
  const q = search != null && String(search).trim() !== "" ? String(search).trim().toLowerCase() : null;

  const whereSearch = q ? `AND (position($2 in lower(name)) > 0 OR position($2 in lower(sku)) > 0)` : "";
  const paramsData = q ? [cid, q, l, offset] : [cid, l, offset];
  const paramsCnt = q ? [cid, q] : [cid];

  const [{ rows: data }, { rows: cnt }] = await Promise.all([
    pool.query(
      `SELECT sku, name, price_usd, price_bs, price_bs_bcv, price_bs_binance,
              active_rate_type, spread_alert_triggered, rate_date
       FROM v_product_prices_bs
       WHERE company_id = $1
       ${whereSearch}
       ORDER BY name
       LIMIT $${q ? 3 : 2} OFFSET $${q ? 4 : 3}`,
      paramsData
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM v_product_prices_bs
       WHERE company_id = $1
       ${whereSearch}`,
      paramsCnt
    ),
  ]);

  return {
    page: p,
    limit: l,
    total: cnt[0] ? Number(cnt[0].total) : 0,
    rows: data,
  };
}

module.exports = {
  currencyEvents,
  ensureCurrencySchema,
  fetchAndSaveDailyRates,
  manualOverride,
  getTodayRate,
  getRateHistory,
  getProductPrices,
};

