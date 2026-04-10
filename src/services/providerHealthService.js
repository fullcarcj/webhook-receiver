"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { getProvider, resolveApiKey } = require("./aiGateway");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "provider_health" });

const TIMEOUT_MS = 8000;

/**
 * @param {string} providerId
 * @returns {Promise<{ provider_id: string, ok: boolean, status_code?: number, latency_ms: number, detail?: string }>}
 */
async function checkProviderHealth(providerId) {
  const t0 = Date.now();
  const lat = () => Date.now() - t0;

  let provider;
  try {
    provider = await getProvider(pool, providerId);
  } catch (e) {
    return { provider_id: providerId, ok: false, latency_ms: lat(), detail: e.message || String(e) };
  }

  if (!provider) {
    return { provider_id: providerId, ok: false, latency_ms: lat(), detail: "proveedor no encontrado" };
  }

  const key = resolveApiKey(provider);
  if (!key) {
    return { provider_id: providerId, ok: false, latency_ms: lat(), detail: "sin_api_key" };
  }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    if (provider.provider_type === "gemini") {
      const u = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`;
      const res = await fetch(u, { method: "GET", signal: ctrl.signal });
      clearTimeout(to);
      return {
        provider_id: providerId,
        ok: res.ok,
        status_code: res.status,
        latency_ms: lat(),
        detail: res.ok ? undefined : await res.text().then((t) => t.slice(0, 300)),
      };
    }

    if (provider.provider_type === "groq") {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      return {
        provider_id: providerId,
        ok: res.ok,
        status_code: res.status,
        latency_ms: lat(),
        detail: res.ok ? undefined : await res.text().then((t) => t.slice(0, 300)),
      };
    }

    if (provider.provider_type === "openai") {
      const res = await fetch("https://api.openai.com/v1/models?limit=1", {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      return {
        provider_id: providerId,
        ok: res.ok,
        status_code: res.status,
        latency_ms: lat(),
        detail: res.ok ? undefined : await res.text().then((t) => t.slice(0, 300)),
      };
    }

    clearTimeout(to);
    return { provider_id: providerId, ok: false, latency_ms: lat(), detail: "tipo no soportado" };
  } catch (e) {
    clearTimeout(to);
    const msg = e.name === "AbortError" ? "timeout" : e.message || String(e);
    return { provider_id: providerId, ok: false, latency_ms: lat(), detail: msg };
  }
}

/**
 * Persistir resultado en provider_settings (no lanza).
 */
async function persistHealthCheck(providerId, result) {
  try {
    await pool.query(
      `UPDATE provider_settings SET
         last_health_check_at = NOW(),
         health_status = $2,
         last_error = CASE WHEN $3 THEN NULL ELSE LEFT($4, 500) END
       WHERE provider_id = $1`,
      [providerId, result.ok ? "healthy" : "unreachable", result.ok, result.detail || null]
    );
  } catch (e) {
    log.warn({ err: e.message, providerId }, "persistHealthCheck falló");
  }
}

async function checkAllProviders() {
  let rows;
  try {
    rows = (await pool.query(`SELECT provider_id FROM provider_settings ORDER BY provider_id`)).rows;
  } catch (e) {
    log.warn({ err: e.message }, "checkAllProviders: sin tabla o error");
    return [];
  }
  const out = [];
  for (const r of rows) {
    const res = await checkProviderHealth(r.provider_id);
    await persistHealthCheck(r.provider_id, res);
    out.push(res);
  }
  return out;
}

module.exports = {
  checkProviderHealth,
  checkAllProviders,
  persistHealthCheck,
};
