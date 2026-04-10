"use strict";

const { z } = require("zod");
const pino = require("pino");
const { pool } = require("../../db");
const { ensureAdmin } = require("../middleware/adminAuth");
const { safeParse } = require("../middleware/validateCrm");
const { encryptApiKey } = require("../services/cryptoService");
const { checkProviderHealth, checkAllProviders, persistHealthCheck } = require("../services/providerHealthService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "provider_api" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 256 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function stripKey(row) {
  if (!row) return row;
  const o = { ...row };
  if (o.api_key_encrypted != null) {
    o.has_stored_key = Boolean(String(o.api_key_encrypted).trim());
    delete o.api_key_encrypted;
  }
  return o;
}

async function schemaReady(res) {
  try {
    await pool.query(`SELECT 1 FROM provider_settings LIMIT 1`);
    return true;
  } catch (e) {
    writeJson(res, 503, {
      error: "provider_schema_missing",
      message: "Ejecutá npm run db:provider-settings",
    });
    return false;
  }
}

const toggleSchema = z.object({
  enabled: z.boolean(),
  updated_by: z.string().min(1).max(100),
});

const keySchema = z.object({
  api_key: z.string().min(1).max(4000),
  updated_by: z.string().min(1).max(100),
});

const limitsSchema = z.object({
  updated_by: z.string().min(1).max(100),
  daily_token_limit: z.number().int().positive().optional(),
  daily_request_limit: z.number().int().positive().optional(),
  circuit_breaker_threshold: z.number().int().min(1).max(1000).optional(),
});

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleProviderApiRequest(req, res, url) {
  const pathname = url.pathname || "";

  if (pathname === "/api/admin/ai-log" || pathname === "/api/admin/ai-log/") {
    if (!ensureAdmin(req, res, url)) return true;
    if (!(await schemaReady(res))) return true;
    if (req.method !== "GET") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    try {
      const r = await pool.query(
        `SELECT id, provider_id, function_called, tokens_input, tokens_output, latency_ms, success, error_message, created_at
         FROM ai_usage_log
         ORDER BY id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      writeJson(res, 200, { ok: true, rows: r.rows, limit, offset });
    } catch (e) {
      log.error({ err: e.message }, "ai-log");
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  if (!pathname.startsWith("/api/admin/providers")) {
    return false;
  }

  if (!ensureAdmin(req, res, url)) return true;
  if (!(await schemaReady(res))) return true;

  try {
    if (req.method === "POST" && (pathname === "/api/admin/providers/health-all" || pathname === "/api/admin/providers/health-all/")) {
      const results = await checkAllProviders();
      writeJson(res, 200, { ok: true, results });
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/admin/providers/usage/today" || pathname === "/api/admin/providers/usage/today/")) {
      const r = await pool.query(
        `SELECT provider_id, display_name, category, current_daily_usage, current_daily_requests, error_count_today,
                daily_token_limit, daily_request_limit, consecutive_failures, circuit_breaker_until, health_status
         FROM provider_settings
         ORDER BY category, provider_id`
      );
      writeJson(res, 200, { ok: true, rows: r.rows });
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/admin/providers" || pathname === "/api/admin/providers/")) {
      const r = await pool.query(`SELECT * FROM provider_settings ORDER BY category, provider_id`);
      writeJson(res, 200, { ok: true, providers: r.rows.map(stripKey) });
      return true;
    }

    const idMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)$/);
    if (idMatch && req.method === "GET") {
      const id = idMatch[1];
      const r = await pool.query(`SELECT * FROM provider_settings WHERE provider_id = $1`, [id]);
      if (!r.rows[0]) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, provider: stripKey(r.rows[0]) });
      return true;
    }

    const toggleMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)\/toggle$/);
    if (toggleMatch && req.method === "PATCH") {
      const id = toggleMatch[1];
      const body = await parseJsonBody(req);
      const parsed = safeParse(toggleSchema, body);
      if (!parsed.ok) {
        writeJson(res, 400, { error: "validation", details: parsed.error.flatten() });
        return true;
      }
      const r = await pool.query(
        `UPDATE provider_settings SET enabled = $2, updated_by = $3 WHERE provider_id = $1 RETURNING *`,
        [id, parsed.data.enabled, parsed.data.updated_by]
      );
      if (!r.rows[0]) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, provider: stripKey(r.rows[0]) });
      return true;
    }

    const keyMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)\/key$/);
    if (keyMatch && req.method === "PATCH") {
      const id = keyMatch[1];
      const body = await parseJsonBody(req);
      const parsed = safeParse(keySchema, body);
      if (!parsed.ok) {
        writeJson(res, 400, { error: "validation", details: parsed.error.flatten() });
        return true;
      }
      let enc;
      try {
        enc = encryptApiKey(parsed.data.api_key);
      } catch (e) {
        writeJson(res, 500, { error: "encrypt_failed", message: e.message });
        return true;
      }
      const r = await pool.query(
        `UPDATE provider_settings SET api_key_encrypted = $2, updated_by = $3 WHERE provider_id = $1 RETURNING *`,
        [id, enc, parsed.data.updated_by]
      );
      if (!r.rows[0]) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, provider: stripKey(r.rows[0]) });
      return true;
    }

    const limitsMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)\/limits$/);
    if (limitsMatch && req.method === "PATCH") {
      const id = limitsMatch[1];
      const body = await parseJsonBody(req);
      const parsed = safeParse(limitsSchema, body);
      if (!parsed.ok) {
        writeJson(res, 400, { error: "validation", details: parsed.error.flatten() });
        return true;
      }
      const d = parsed.data;
      const r = await pool.query(
        `UPDATE provider_settings SET
           daily_token_limit = COALESCE($2, daily_token_limit),
           daily_request_limit = COALESCE($3, daily_request_limit),
           circuit_breaker_threshold = COALESCE($4, circuit_breaker_threshold),
           updated_by = $5
         WHERE provider_id = $1
         RETURNING *`,
        [id, d.daily_token_limit ?? null, d.daily_request_limit ?? null, d.circuit_breaker_threshold ?? null, d.updated_by]
      );
      if (!r.rows[0]) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, provider: stripKey(r.rows[0]) });
      return true;
    }

    const healthMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)\/health$/);
    if (healthMatch && req.method === "POST") {
      const id = healthMatch[1];
      const result = await checkProviderHealth(id);
      await persistHealthCheck(id, result);
      writeJson(res, 200, { ok: true, result });
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    if (e.message === "body_too_large") {
      writeJson(res, 413, { error: "body_too_large" });
      return true;
    }
    log.error({ err: e.message }, "provider_api");
    writeJson(res, 500, { ok: false, error: e.message });
    return true;
  }
}

module.exports = { handleProviderApiRequest };
