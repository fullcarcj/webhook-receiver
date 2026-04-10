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

const RECEIPT_TEST_TIMEOUT_MS = 30_000;

/**
 * Ejecuta el pipeline completo de conciliación bancaria sobre una URL de imagen.
 * Etapas: prefiltro sharp → extracción Gemini → (opcional) persistencia + reconciliación.
 */
async function runReceiptTest(req, res) {
  const t0 = Date.now();
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    writeJson(res, 400, { ok: false, error: "json_invalido", detail: e.message });
    return true;
  }

  const imageUrl  = typeof body.url === "string" ? body.url.trim() : null;
  const dryRun    = body.dry_run !== false;
  const customerId = body.customer_id ? Number(body.customer_id) : null;

  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    writeJson(res, 400, { ok: false, error: "url_requerida", detail: "url debe empezar con https://" });
    return true;
  }

  const stages = {
    prefiltro:      { ran: false },
    extraction:     { ran: false },
    persistence:    { ran: false, reason: dryRun ? "dry_run" : null },
    reconciliation: { ran: false, reason: dryRun ? "dry_run" : null },
  };

  try {
    // ── Etapa 1: Descargar imagen y prefiltro sharp ───────────────────────────
    let fileBuffer;
    try {
      const ctrl = new AbortController();
      const to   = setTimeout(() => ctrl.abort(), RECEIPT_TEST_TIMEOUT_MS);
      const imgRes = await fetch(imageUrl, { signal: ctrl.signal });
      clearTimeout(to);
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status} al descargar imagen`);
      fileBuffer = Buffer.from(await imgRes.arrayBuffer());
    } catch (e) {
      writeJson(res, 422, { ok: false, error: "download_failed", detail: e.message, elapsed_ms: Date.now() - t0 });
      return true;
    }

    const { isPaymentReceipt } = require("../whatsapp/media/receiptDetector");
    const prefiltro = await isPaymentReceipt(fileBuffer);
    stages.prefiltro = { ran: true, is_receipt: prefiltro.isReceipt, score: prefiltro.score, reason: prefiltro.reason };

    if (!prefiltro.isReceipt) {
      writeJson(res, 200, {
        ok: true, dry_run: dryRun, url: imageUrl, stages,
        summary: "prefiltro_rechazado",
        elapsed_ms: Date.now() - t0,
      });
      return true;
    }

    // ── Etapa 2: Extracción con Gemini Vision via AI Gateway ─────────────────
    const { extractReceiptData } = require("../whatsapp/media/receiptExtractor");
    let extracted = null;
    let extractionError = null;
    try {
      extracted = await extractReceiptData(imageUrl);
    } catch (e) {
      extractionError = e.message;
    }
    stages.extraction = {
      ran: true,
      result: extracted,
      error: extractionError ?? (extracted ? null : "Gemini devolvió null"),
    };

    if (dryRun) {
      writeJson(res, 200, {
        ok: true, dry_run: true, url: imageUrl, stages,
        summary: extracted ? "extraction_ok_dry_run" : "extraction_failed_dry_run",
        elapsed_ms: Date.now() - t0,
      });
      return true;
    }

    // ── Etapa 3: Persistencia en payment_attempts ─────────────────────────────
    let attemptId = null;
    try {
      const { rows } = await pool.query(
        `INSERT INTO payment_attempts
           (customer_id, chat_id, firebase_url,
            extracted_reference, extracted_amount_bs, extracted_date,
            extracted_bank, extracted_payment_type, extraction_confidence,
            is_receipt, prefiler_score)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)
         RETURNING id`,
        [
          customerId ?? null,
          imageUrl,
          extracted?.reference_number ?? null,
          extracted?.amount_bs        ?? null,
          extracted?.tx_date          ?? null,
          extracted?.bank_name        ?? null,
          extracted?.payment_type     ?? null,
          extracted?.confidence       ?? null,
          prefiltro.score,
        ]
      );
      attemptId = rows[0]?.id ?? null;
      stages.persistence = { ran: true, attempt_id: attemptId };
    } catch (e) {
      stages.persistence = { ran: true, error: e.message };
    }

    // ── Etapa 4: Conciliación ─────────────────────────────────────────────────
    if (attemptId && extracted?.amount_bs != null) {
      try {
        const { reconcileAttempt } = require("../services/reconciliationService");
        const reconResult = await reconcileAttempt(attemptId);
        stages.reconciliation = {
          ran: true,
          status: reconResult?.status ?? "desconocido",
          matched_statement_id: reconResult?.bank_statement_id ?? null,
          detail: reconResult,
        };
      } catch (e) {
        stages.reconciliation = { ran: true, error: e.message };
      }
    } else if (attemptId) {
      stages.reconciliation = { ran: false, reason: "amount_bs_null" };
    }

    writeJson(res, 200, {
      ok: true, dry_run: false, url: imageUrl, stages,
      summary: stages.reconciliation.ran ? `reconciliation_${stages.reconciliation.status}` : "persisted_no_reconciliation",
      elapsed_ms: Date.now() - t0,
    });
    return true;

  } catch (e) {
    log.error({ err: e.message }, "receipt_test");
    writeJson(res, 500, { ok: false, error: e.message, stages, elapsed_ms: Date.now() - t0 });
    return true;
  }
}

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

  if (pathname === "/api/admin/test/receipt" || pathname === "/api/admin/test/receipt/") {
    if (!ensureAdmin(req, res, url)) return true;
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method_not_allowed" });
      return true;
    }
    return runReceiptTest(req, res);
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
