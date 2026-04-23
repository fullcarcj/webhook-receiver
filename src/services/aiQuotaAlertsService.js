"use strict";

/**
 * Detecta en logs errores típicos de cuota / rate limit (Groq, Gemini, límites propios del gateway).
 * Usado por GET /api/ai-responder/stats y /api/ai-responder/settings para el dashboard.
 */

const DEFAULT_WINDOW_DAYS = 7;

/** Condición SQL: mensaje de error sugiere cuota o throttling. */
function quotaLikeSqlCondition(column) {
  const c = column || "error_message";
  return `(
    ${c} ILIKE '%429%'
    OR ${c} ILIKE '%quota%'
    OR ${c} ILIKE '%rate_limit%'
    OR ${c} ILIKE '%rate limit%'
    OR ${c} ILIKE '%ResourceExhausted%'
    OR ${c} ILIKE '%RESOURCE_EXHAUSTED%'
    OR ${c} ILIKE '%Too Many%'
    OR ${c} ILIKE '%too many requests%'
    OR ${c} ILIKE '%limite_requests_diario%'
    OR ${c} ILIKE '%limite_tokens_diario%'
    OR ${c} ILIKE '%limite_excedido%'
    OR ${c} ILIKE '%limit exceeded%'
    OR ${c} ILIKE '%TPD%'
    OR ${c} ILIKE '%tokens per day%'
    OR ${c} ILIKE '%RPM%'
    OR ${c} ILIKE '%throttl%'
    OR ${c} ILIKE '%overloaded%'
    OR ${c} ILIKE '%capacity%'
  )`;
}

/**
 * @param {import("pg").Pool} pool
 * @param {{ windowDays?: number }} [opts]
 */
async function getQuotaAlertsSnapshot(pool, opts = {}) {
  const windowDays = Math.min(90, Math.max(1, Number(opts.windowDays) || DEFAULT_WINDOW_DAYS));
  const empty = {
    active: false,
    window_days: windowDays,
    total_usage_log_hits: 0,
    total_payment_attempt_hits: 0,
    by_provider: [],
    recent_errors: [],
    provider_row_hints: [],
    unavailable: false,
    headline: null,
    action_hint:
      "Revisar plan/cuota en Groq y Google AI Studio; si usás límites en provider_settings, subir daily_request_limit o daily_token_limit; esperar ventana TPD o cambiar modelo (GROQ_CHAT_MODEL).",
  };

  try {
    const usageQ = `
      SELECT provider_id, function_called, COUNT(*)::int AS n, MAX(created_at) AS last_at
      FROM ai_usage_log
      WHERE success = false
        AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND ${quotaLikeSqlCondition("error_message")}
      GROUP BY provider_id, function_called
      ORDER BY n DESC, last_at DESC
      LIMIT 24`;
    const { rows: byProv } = await pool.query(usageQ, [windowDays]);

    const samplesQ = `
      SELECT provider_id, function_called, LEFT(error_message, 420) AS error_message, created_at
      FROM ai_usage_log
      WHERE success = false
        AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND ${quotaLikeSqlCondition("error_message")}
      ORDER BY created_at DESC
      LIMIT 15`;
    const { rows: samples } = await pool.query(samplesQ, [windowDays]);

    let paN = 0;
    try {
      const pa = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_attempts
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
           AND extraction_error IS NOT NULL
           AND ${quotaLikeSqlCondition("extraction_error")}`,
        [windowDays]
      );
      paN = Number(pa.rows[0]?.n) || 0;
    } catch (e) {
      if (e && e.code !== "42P01" && e.code !== "42703") throw e;
    }

    let hints = [];
    try {
      const { rows } = await pool.query(
        `SELECT provider_id,
                last_error,
                circuit_breaker_until,
                (circuit_breaker_until IS NOT NULL AND circuit_breaker_until > NOW()) AS circuit_open
         FROM provider_settings
         WHERE provider_id IN ('GROQ_LLAMA','GROQ_WHISPER','GEMINI_FLASH')
           AND (
             (last_error IS NOT NULL AND ${quotaLikeSqlCondition("last_error")})
             OR (circuit_breaker_until IS NOT NULL AND circuit_breaker_until > NOW())
           )`
      );
      hints = rows.map((r) => ({
        provider_id: r.provider_id,
        last_error: r.last_error != null ? String(r.last_error).slice(0, 500) : null,
        circuit_open: Boolean(r.circuit_open),
        circuit_breaker_until: r.circuit_breaker_until
          ? new Date(r.circuit_breaker_until).toISOString()
          : null,
      }));
    } catch (e) {
      if (e && e.code !== "42P01" && e.code !== "42703") throw e;
    }

    const totalUsage = byProv.reduce((s, r) => s + (Number(r.n) || 0), 0);
    const by_provider = byProv.map((r) => ({
      provider_id: r.provider_id,
      function_called: r.function_called,
      n: Number(r.n) || 0,
      last_at: r.last_at ? new Date(r.last_at).toISOString() : null,
    }));
    const recent_errors = samples.map((r) => ({
      provider_id: r.provider_id,
      function_called: r.function_called,
      error_message: r.error_message,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));

    const active = totalUsage > 0 || paN > 0 || hints.length > 0;
    let headline = null;
    if (active) {
      const parts = [];
      if (totalUsage) parts.push(`${totalUsage} fallo(s) en ai_usage_log (últimos ${windowDays} días)`);
      if (paN) parts.push(`${paN} comprobante(s) con error de extracción compatible con cuota/límite`);
      if (hints.length) parts.push(`${hints.length} fila(s) en provider_settings (circuito o last_error)`);
      headline = `Posible límite de cuota o rate limit: ${parts.join(" · ")}.`;
    }

    return {
      ...empty,
      active,
      total_usage_log_hits: totalUsage,
      total_payment_attempt_hits: paN,
      by_provider,
      recent_errors,
      provider_row_hints: hints,
      headline,
    };
  } catch (e) {
    if (e && e.code === "42P01") {
      return {
        ...empty,
        unavailable: true,
        headline: "Sin tabla ai_usage_log: no se puede diagnosticar cuota desde el historial.",
      };
    }
    throw e;
  }
}

module.exports = { getQuotaAlertsSnapshot, quotaLikeSqlCondition };
