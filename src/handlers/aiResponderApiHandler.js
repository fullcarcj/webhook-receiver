"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { requireAdminOrPermission, verifyToken } = require("../utils/authMiddleware");
const {
  sendAiReplyToCustomer,
  logAiResponse,
  providerAuditTipoM,
  isForceSend,
  isHumanReviewGateOn,
  isEnabled: aiResponderIsEnabled,
  isSuspended: aiResponderIsSuspended,
} = require("../services/aiResponder");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_responder_api" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Usuario JWT (username) o `admin` si la sesión es secreto / query legacy. */
async function getActorLabel(req) {
  try {
    const p = await verifyToken(req);
    if (p && p.username) return String(p.username).trim().slice(0, 120);
  } catch (_) {}
  return "admin";
}

const LEGACY_ARCHIVED_DETAIL =
  "Este mensaje fue archivado como backlog histórico y no puede ser procesado.";

/**
 * Bloquea approve/override/draft/reject sobre mensajes archivados (backlog pre–6A).
 * Registra `legacy_archived_block_attempt` en ai_response_log; no modifica crm_messages ni Wasender.
 */
async function logAndRespondLegacyArchivedBlocked(req, res, id, row, endpoint) {
  const sentBy = await getActorLabel(req);
  log.warn(
    { messageId: Number(id), endpoint, user_sent_by: sentBy },
    "Intento de operación sobre mensaje legacy_archived · bloqueado"
  );
  const reasoning = JSON.stringify({
    endpoint,
    message_id: Number(id),
    attempted_at: new Date().toISOString(),
    user_sent_by: sentBy,
  });
  try {
    await logAiResponse(pool, {
      crm_message_id: Number(id),
      customer_id: row.customer_id,
      chat_id: row.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: null,
      confidence: null,
      reasoning,
      provider_used: "system",
      tokens_used: 0,
      action_taken: "legacy_archived_block_attempt",
      error_message: null,
    });
  } catch (e) {
    log.warn({ err: e.message, messageId: id }, "legacy_archived_block_attempt log insert falló");
  }
  writeJson(res, 409, {
    ok: false,
    error: "invalid_state",
    code: "legacy_archived_blocked",
    detail: LEGACY_ARCHIVED_DETAIL,
    message_id: Number(id),
  });
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 128 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

/** Cuenta por action_taken desde today_log_by_action (array API) o legacy objeto. */
function logActionCount(logByAction, action) {
  if (!logByAction) return 0;
  if (Array.isArray(logByAction)) {
    const row = logByAction.find((r) => r && r.action_taken === action);
    const n = row && Number(row.n);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(logByAction[action]);
  return Number.isFinite(n) ? n : 0;
}

async function getStats() {
  /* today_messages.needs_review cuenta solo needs_human_review; legacy_archived queda fuera
     (backlog archivado pre–Sprint 6B · ver archive-legacy-ai-queue.js). */
  const today = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE ai_reply_status = 'ai_replied') AS auto_sent,
      COUNT(*) FILTER (WHERE ai_reply_status = 'needs_human_review') AS needs_review,
      COUNT(*) FILTER (WHERE ai_reply_status = 'needs_human_review' AND COALESCE(TRIM(ai_reply_text), '') <> '') AS needs_review_post_wa_fail,
      COUNT(*) FILTER (WHERE ai_reply_status = 'needs_human_review' AND COALESCE(TRIM(ai_reply_text), '') = '') AS needs_review_pre_send,
      COUNT(*) FILTER (WHERE ai_reply_status = 'processing') AS processing,
      COUNT(*) FILTER (WHERE ai_reply_status IN ('pending_ai_reply','pending_receipt_confirm')) AS pending,
      COUNT(*) FILTER (WHERE ai_reply_status = 'skipped') AS skipped
    FROM crm_messages
    WHERE created_at >= CURRENT_DATE
      AND ai_reply_status IS NOT NULL
  `);
  const logc = await pool.query(`
    SELECT action_taken, COUNT(*)::int AS n
    FROM ai_response_log
    WHERE created_at >= CURRENT_DATE
    GROUP BY action_taken
  `);
  const groqKeyOk = !!process.env.GROQ_API_KEY;
  const legacyArchived = await pool.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE ai_reply_status = 'legacy_archived'`
  );
  const totalPending = await pool.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE ai_reply_status = 'needs_human_review'`
  );
  const pendingQueue = await pool.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages
     WHERE ai_reply_status IN ('pending_ai_reply', 'pending_receipt_confirm')`
  );
  const lastAct = await pool.query(`
    SELECT GREATEST(
      (SELECT MAX(created_at) FROM ai_response_log),
      (SELECT MAX(ai_processed_at) FROM crm_messages WHERE ai_processed_at IS NOT NULL)
    ) AS t
  `);
  const tm = today.rows[0] || {};
  const aiResponderEnvOn = String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1";
  const aiResponderSuspended = aiResponderIsSuspended();
  const aiResponderEnabled = aiResponderIsEnabled();
  const lastRaw = lastAct.rows[0]?.t;
  const lastCycleIso = lastRaw ? new Date(lastRaw).toISOString() : null;
  const todayByStatus = {
    ai_replied: Number(tm.auto_sent) || 0,
    needs_human_review: Number(tm.needs_review) || 0,
    skipped: Number(tm.skipped) || 0,
    processing: Number(tm.processing) || 0,
    pending: Number(tm.pending) || 0,
  };

  let quota_alerts = null;
  try {
    const { getQuotaAlertsSnapshot } = require("../services/aiQuotaAlertsService");
    quota_alerts = await getQuotaAlertsSnapshot(pool, { windowDays: 7 });
  } catch (e) {
    quota_alerts = {
      active: false,
      unavailable: true,
      window_days: 7,
      total_usage_log_hits: 0,
      total_payment_attempt_hits: 0,
      by_provider: [],
      recent_errors: [],
      provider_row_hints: [],
      headline: `Diagnóstico de cuota no disponible: ${String(e.message || e)}`,
      action_hint: null,
    };
  }

  // total_pending_count = COUNT(*) WHERE ai_reply_status = 'needs_human_review'. Incluye TODOS los
  // mensajes pendientes de revisión (no solo hoy). Fuente de verdad para el badge del drawer (6B FE).
  // today_messages.needs_review es distinto: solo cuenta mensajes con created_at >= CURRENT_DATE.
  return {
    ok: true,
    ai_responder_enabled: aiResponderEnabled,
    /** true si AI_RESPONDER_ENABLED=1 en env aunque isSuspended() apague el efecto. */
    ai_responder_env_enabled: aiResponderEnvOn,
    /** true si AI_RESPONDER_SUSPENDED=1 (no cola ni worker efectivo). */
    ai_responder_suspended: aiResponderSuspended,
    /** Alias para monitor Next.js (GET /api/ai-responder/stats). */
    enabled: aiResponderEnabled,
    force_send: isForceSend(),
    human_review_gate: isHumanReviewGateOn(),
    tipo_m_mode: "plantilla + context_line (IA no elige flujo)",
    today_messages: tm,
    /** Shape esperado por el frontend Dreams POS (useAiResponderStats). */
    today_by_status: todayByStatus,
    pending_count: pendingQueue.rows[0]?.n ?? 0,
    needs_review_count: Number(tm.needs_review) || 0,
    total_pending_count: totalPending.rows[0]?.n ?? 0,
    today_log_by_action: logc.rows,
    legacy_archived_count: legacyArchived.rows[0]?.n ?? 0,
    provider: { groq_key_ok: groqKeyOk },
    /** Worker puede ciclar (env + GROQ); el monitor ya no asume "caído" solo por falta de last_cycle_at. */
    worker_running: aiResponderEnabled && groqKeyOk,
    last_cycle_at: lastCycleIso,
    quota_alerts,
  };
}

/**
 * GET /api/ai-responder/settings — interruptores de consola IA + flags de entorno (solo lectura donde aplique).
 */
async function getAiResponderSettings() {
  const { getSwitches } = require("../services/aiConsoleSwitches");
  const { getQuotaAlertsSnapshot } = require("../services/aiQuotaAlertsService");
  const sw = await getSwitches();
  const groqKeyOk = !!process.env.GROQ_API_KEY;
  const envOn = String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1";
  const suspended = aiResponderIsSuspended();
  const tipo_m_effective = Boolean(sw.tipo_m_enabled && envOn && !suspended && groqKeyOk);
  let quota_alerts = null;
  try {
    quota_alerts = await getQuotaAlertsSnapshot(pool, { windowDays: 7 });
  } catch (e) {
    quota_alerts = {
      active: false,
      unavailable: true,
      window_days: 7,
      total_usage_log_hits: 0,
      total_payment_attempt_hits: 0,
      by_provider: [],
      recent_errors: [],
      provider_row_hints: [],
      headline: `Diagnóstico de cuota no disponible: ${String(e.message || e)}`,
      action_hint: null,
    };
  }
  return {
    ok: true,
    schema_ready: sw.schema_ready !== false,
    schema_error: sw.schema_error != null ? String(sw.schema_error) : null,
    switches: {
      tipo_m: {
        value: sw.tipo_m_enabled,
        env_ai_responder_enabled: envOn,
        suspended,
        groq_key_ok: groqKeyOk,
        effective: tipo_m_effective,
      },
      transcription_groq: { value: sw.transcription_groq, effective: sw.transcription_groq },
      wa_name_groq: { value: sw.wa_name_groq, effective: sw.wa_name_groq },
      receipt_gemini_vision: { value: sw.receipt_gemini_vision, effective: sw.receipt_gemini_vision },
    },
    quota_alerts,
  };
}

function _mapAiUsageOpsRow(r) {
  return {
    id: Number(r.id),
    provider_id: r.provider_id,
    function_called: r.function_called,
    tokens_input: r.tokens_input == null ? null : Number(r.tokens_input),
    tokens_output: r.tokens_output == null ? null : Number(r.tokens_output),
    latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
    success: Boolean(r.success),
    error_message: r.error_message,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : "",
  };
}

function _mapReceiptAttemptOpsRow(r) {
  const d = r.extracted_date;
  let extractedDate = null;
  if (d != null) {
    extractedDate = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  }
  return {
    id: Number(r.id),
    chat_id: r.chat_id != null ? Number(r.chat_id) : null,
    customer_id: r.customer_id != null ? Number(r.customer_id) : null,
    firebase_url: r.firebase_url,
    is_receipt: r.is_receipt,
    prefiler_score: r.prefiler_score,
    prefiler_reason: r.prefiler_reason,
    extracted_reference: r.extracted_reference,
    extracted_amount_bs: r.extracted_amount_bs,
    extracted_date: extractedDate,
    extraction_confidence: r.extraction_confidence,
    extraction_status: r.extraction_status != null ? String(r.extraction_status) : null,
    extraction_error: r.extraction_error != null ? String(r.extraction_error) : null,
    extraction_raw_snippet: r.extraction_raw_snippet != null ? String(r.extraction_raw_snippet) : null,
    reconciliation_status: r.reconciliation_status,
    reconciled_order_id: r.reconciled_order_id != null ? Number(r.reconciled_order_id) : null,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : "",
    pipeline_error_type: r.pipeline_error_type,
  };
}

/**
 * GET /api/ai-responder/ops-logs — logs de validación de nombre (Groq), comprobantes y Gemini Vision.
 */
async function getOpsLogs(url) {
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") || "7", 10) || 7));
  const nameLimit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("name_limit") || "200", 10) || 200));
  const receiptLimit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("receipt_limit") || "200", 10) || 200));
  const visionLimit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("vision_limit") || "200", 10) || 200));

  const notes = [];
  let name_analysis_logs = [];
  let receipt_vision_logs = [];
  let receipt_attempts = [];

  try {
    const [n, v] = await Promise.all([
      pool.query(
        `SELECT id, provider_id, function_called, tokens_input, tokens_output, latency_ms, success, error_message, created_at
         FROM ai_usage_log
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
           AND function_called IN ('wa_name_validation', 'name_validation_skipped')
         ORDER BY created_at DESC
         LIMIT $2`,
        [days, nameLimit]
      ),
      pool.query(
        `SELECT id, provider_id, function_called, tokens_input, tokens_output, latency_ms, success, error_message, created_at
         FROM ai_usage_log
         WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
           AND function_called = 'callVision'
         ORDER BY created_at DESC
         LIMIT $2`,
        [days, visionLimit]
      ),
    ]);
    name_analysis_logs = n.rows.map(_mapAiUsageOpsRow);
    receipt_vision_logs = v.rows.map(_mapAiUsageOpsRow);
  } catch (e) {
    if (e && e.code === "42P01") {
      notes.push("Tabla ai_usage_log no disponible (migración provider_settings / ai_usage_log).");
    } else {
      throw e;
    }
  }

  const receiptPipelineCaseWithExtraction = `
           CASE
             WHEN COALESCE(pa.is_receipt, FALSE) IS NOT TRUE THEN 'legacy_not_receipt'
             WHEN pa.extraction_status IN (
               'download_failed','vision_error','json_parse','empty_response','invalid_shape','unexpected'
             ) THEN 'extraction_failed'
             WHEN pa.extraction_status = 'parsed_empty' THEN 'extraction_empty'
             WHEN pa.extraction_status IS NULL
                  AND pa.extracted_reference IS NULL AND pa.extracted_amount_bs IS NULL AND pa.extracted_date IS NULL
                  AND pa.extraction_confidence IS NULL THEN 'extraction_empty'
             WHEN pa.reconciliation_status = 'matched' THEN 'reconciled_matched'
             WHEN pa.reconciliation_status = 'no_match' THEN 'reconciled_no_match'
             WHEN pa.reconciliation_status = 'manual_review' THEN 'manual_review'
             WHEN pa.reconciliation_status = 'rejected' THEN 'rejected'
             WHEN pa.reconciliation_status = 'pending' THEN 'reconciliation_pending'
             ELSE COALESCE(pa.reconciliation_status, 'unknown')
           END AS pipeline_error_type`;

  const receiptPipelineCaseLegacyOnly = `
           CASE
             WHEN COALESCE(pa.is_receipt, FALSE) IS NOT TRUE THEN 'legacy_not_receipt'
             WHEN pa.extracted_reference IS NULL AND pa.extracted_amount_bs IS NULL AND pa.extracted_date IS NULL
                  AND pa.extraction_confidence IS NULL THEN 'extraction_empty'
             WHEN pa.reconciliation_status = 'matched' THEN 'reconciled_matched'
             WHEN pa.reconciliation_status = 'no_match' THEN 'reconciled_no_match'
             WHEN pa.reconciliation_status = 'manual_review' THEN 'manual_review'
             WHEN pa.reconciliation_status = 'rejected' THEN 'rejected'
             WHEN pa.reconciliation_status = 'pending' THEN 'reconciliation_pending'
             ELSE COALESCE(pa.reconciliation_status, 'unknown')
           END AS pipeline_error_type`;

  const receiptSqlV2 = `
    SELECT pa.id, pa.chat_id, pa.customer_id, pa.firebase_url, pa.is_receipt, pa.prefiler_score, pa.prefiler_reason,
           pa.extracted_reference, pa.extracted_amount_bs, pa.extracted_date, pa.extraction_confidence,
           pa.extraction_status, pa.extraction_error, pa.extraction_raw_snippet,
           pa.reconciliation_status, pa.reconciled_order_id, pa.created_at,
           ${receiptPipelineCaseWithExtraction}
    FROM payment_attempts pa
    WHERE pa.created_at >= NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY pa.created_at DESC
    LIMIT $2`;

  const receiptSqlV1NoPrefiler = `
    SELECT pa.id, pa.chat_id, pa.customer_id, pa.firebase_url, pa.is_receipt, pa.prefiler_score, NULL::text AS prefiler_reason,
           pa.extracted_reference, pa.extracted_amount_bs, pa.extracted_date, pa.extraction_confidence,
           pa.extraction_status, pa.extraction_error, pa.extraction_raw_snippet,
           pa.reconciliation_status, pa.reconciled_order_id, pa.created_at,
           ${receiptPipelineCaseWithExtraction}
    FROM payment_attempts pa
    WHERE pa.created_at >= NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY pa.created_at DESC
    LIMIT $2`;

  const receiptSqlV0Legacy = `
    SELECT pa.id, pa.chat_id, pa.customer_id, pa.firebase_url, pa.is_receipt, pa.prefiler_score, NULL::text AS prefiler_reason,
           pa.extracted_reference, pa.extracted_amount_bs, pa.extracted_date, pa.extraction_confidence,
           NULL::text AS extraction_status, NULL::text AS extraction_error, NULL::text AS extraction_raw_snippet,
           pa.reconciliation_status, pa.reconciled_order_id, pa.created_at,
           ${receiptPipelineCaseLegacyOnly}
    FROM payment_attempts pa
    WHERE pa.created_at >= NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY pa.created_at DESC
    LIMIT $2`;

  const receiptParams = [days, receiptLimit];
  const receiptTiers = [
    { sql: receiptSqlV2, note: null },
    {
      sql: receiptSqlV1NoPrefiler,
      note: "Listado degradado: falta columna prefiler_reason (sql/20260410_payment_attempts_reason.sql).",
    },
    {
      sql: receiptSqlV0Legacy,
      note: "Listado degradado: faltan columnas extraction_* u otras; npm run db:payment-attempts-extraction-audit.",
    },
  ];
  receipt_attempts = [];
  for (let ti = 0; ti < receiptTiers.length; ti += 1) {
    const tier = receiptTiers[ti];
    try {
      const { rows } = await pool.query(tier.sql, receiptParams);
      receipt_attempts = rows.map(_mapReceiptAttemptOpsRow);
      if (tier.note) notes.push(tier.note);
      break;
    } catch (qErr) {
      if (qErr && qErr.code === "42P01") {
        notes.push("Tabla payment_attempts no disponible.");
        break;
      }
      if (qErr && qErr.code === "42703" && ti < receiptTiers.length - 1) continue;
      throw qErr;
    }
  }

  return {
    ok: true,
    days,
    name_analysis_logs,
    receipt_vision_logs,
    receipt_attempts,
    receipt_schema_note: notes.length ? notes.join(" ") : null,
  };
}

async function handleReject(req, res, id, body) {
  const actor = await getActorLabel(req);
  let reason = body && body.reason != null ? String(body.reason).trim() : "";
  if (reason.length > 500) reason = reason.slice(0, 500);
  const reasonOrNull = reason === "" ? null : reason;

  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_status, m.customer_id, m.chat_id,
            COALESCE(NULLIF(TRIM(ch.phone), ''), '') AS chat_phone
     FROM crm_messages m
     LEFT JOIN crm_chats ch ON ch.id = m.chat_id
     WHERE m.id = $1`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  const m = rows[0];
  if (m.ai_reply_status === "legacy_archived") {
    await logAndRespondLegacyArchivedBlocked(req, res, id, m, "reject");
    return;
  }
  if (m.ai_reply_status !== "needs_human_review") {
    writeJson(res, 409, { ok: false, error: "invalid_state" });
    return;
  }

  const reasoningPayload = JSON.stringify({
    reason: reasonOrNull,
    sent_by: actor,
    chat_phone: m.chat_phone || null,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'human_rejected', ai_reply_updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    await logAiResponse(client, {
      crm_message_id: Number(id),
      customer_id: m.customer_id,
      chat_id: m.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: null,
      confidence: null,
      reasoning: reasoningPayload,
      provider_used: "human",
      tokens_used: 0,
      action_taken: "rejected",
      error_message: null,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  writeJson(res, 200, { ok: true, id: Number(id), status: "human_rejected" });
}

async function handleDraft(req, res, id, body) {
  const actor = await getActorLabel(req);
  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_status, m.customer_id, m.chat_id, m.ai_reply_text,
            COALESCE(NULLIF(TRIM(ch.phone), ''), '') AS chat_phone
     FROM crm_messages m
     LEFT JOIN crm_chats ch ON ch.id = m.chat_id
     WHERE m.id = $1`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  const m = rows[0];
  if (m.ai_reply_status === "legacy_archived") {
    await logAndRespondLegacyArchivedBlocked(req, res, id, m, "draft");
    return;
  }
  if (m.ai_reply_status !== "needs_human_review") {
    writeJson(res, 409, { ok: false, error: "invalid_state" });
    return;
  }

  const replyText = body && body.reply_text != null ? String(body.reply_text).trim() : "";
  if (!replyText || replyText.length > 4000) {
    writeJson(res, 400, { ok: false, error: "invalid_reply_text" });
    return;
  }

  const originalAi = m.ai_reply_text != null ? String(m.ai_reply_text) : "";
  const reasoningPayload = JSON.stringify({
    original_ai_text: originalAi,
    new_draft_text: replyText,
    sent_by: actor,
    chat_phone: m.chat_phone || null,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_text = $1, ai_reply_updated_at = NOW()
       WHERE id = $2`,
      [replyText, id]
    );
    await logAiResponse(client, {
      crm_message_id: Number(id),
      customer_id: m.customer_id,
      chat_id: m.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: replyText,
      confidence: null,
      reasoning: reasoningPayload,
      provider_used: "human",
      tokens_used: 0,
      action_taken: "draft_saved",
      error_message: null,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  writeJson(res, 200, {
    ok: true,
    id: Number(id),
    status: "needs_human_review",
    ai_reply_text: replyText,
  });
}

async function handleApprove(req, res, id) {
  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_status, m.ai_reply_text, m.customer_id, m.chat_id
     FROM crm_messages m
     WHERE m.id = $1`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const m = rows[0];
  if (m.ai_reply_status === "legacy_archived") {
    await logAndRespondLegacyArchivedBlocked(req, res, id, m, "approve");
    return;
  }
  if (m.ai_reply_status !== "needs_human_review") {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const text = m.ai_reply_text;
  if (!text || !String(text).trim()) {
    writeJson(res, 400, { ok: false, error: "no_ai_reply_text" });
    return;
  }
  const { rows: cu } = await pool.query(`SELECT phone FROM customers WHERE id = $1`, [m.customer_id]);
  const phone = cu[0]?.phone;
  if (!phone) {
    writeJson(res, 400, { ok: false, error: "no_phone" });
    return;
  }
  const sendRes = await sendAiReplyToCustomer({
    phoneDigits: phone,
    text: String(text),
    customerId: m.customer_id,
  });
  if (!sendRes || !sendRes.ok) {
    writeJson(res, 502, { ok: false, error: "send_failed", detail: sendRes });
    return;
  }
  await pool.query(
    `UPDATE crm_messages SET ai_reply_status = 'ai_replied', ai_processed_at = NOW() WHERE id = $1`,
    [id]
  );
  await logAiResponse(pool, {
    crm_message_id: id,
    customer_id: m.customer_id,
    chat_id: m.chat_id,
    input_text: null,
    receipt_data: null,
    reply_text: text,
    confidence: null,
    reasoning: "approved_by_human",
    provider_used: providerAuditTipoM("manual_approve"),
    tokens_used: 0,
    action_taken: "approved_by_human",
    error_message: null,
  });
  writeJson(res, 200, { ok: true, id: Number(id) });
}

async function handleOverride(req, res, id, body) {
  const replyText = body && body.reply_text != null ? String(body.reply_text).trim() : "";
  if (!replyText) {
    writeJson(res, 400, { ok: false, error: "reply_text_required" });
    return;
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.ai_reply_status, m.customer_id, m.chat_id, m.ai_reply_text,
            COALESCE(NULLIF(TRIM(ch.phone), ''), '') AS chat_phone
     FROM crm_messages m
     LEFT JOIN crm_chats ch ON ch.id = m.chat_id
     WHERE m.id = $1`,
    [id]
  );
  if (!rows.length) {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const m = rows[0];
  if (m.ai_reply_status === "legacy_archived") {
    await logAndRespondLegacyArchivedBlocked(req, res, id, m, "override");
    return;
  }
  if (m.ai_reply_status !== "needs_human_review") {
    writeJson(res, 404, { ok: false, error: "not_found_or_not_review" });
    return;
  }
  const originalAi = m.ai_reply_text != null ? String(m.ai_reply_text) : "";
  const actor = await getActorLabel(req);
  const sentBy =
    body.sent_by != null && String(body.sent_by).trim() !== ""
      ? String(body.sent_by).trim().slice(0, 200)
      : actor;

  const { rows: cu } = await pool.query(`SELECT phone FROM customers WHERE id = $1`, [m.customer_id]);
  const phone = cu[0]?.phone;
  if (!phone) {
    writeJson(res, 400, { ok: false, error: "no_phone" });
    return;
  }
  const sendRes = await sendAiReplyToCustomer({
    phoneDigits: phone,
    text: replyText,
    customerId: m.customer_id,
  });
  if (!sendRes || !sendRes.ok) {
    writeJson(res, 502, { ok: false, error: "send_failed", detail: sendRes });
    return;
  }

  const reasoningPayload = JSON.stringify({
    original_ai_text: originalAi,
    override_text: replyText,
    sent_by: sentBy,
    chat_phone: m.chat_phone || null,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'human_replied',
           ai_reply_text = $1,
           ai_processed_at = NOW()
       WHERE id = $2`,
      [replyText, id]
    );
    await logAiResponse(client, {
      crm_message_id: Number(id),
      customer_id: m.customer_id,
      chat_id: m.chat_id,
      input_text: null,
      receipt_data: null,
      reply_text: replyText,
      confidence: null,
      reasoning: reasoningPayload,
      provider_used: providerAuditTipoM("human_override"),
      tokens_used: 0,
      action_taken: "overridden",
      error_message: null,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
  writeJson(res, 200, { ok: true, id: Number(id) });
}

/**
 * @returns {Promise<boolean>}
 */
async function handleAiResponderRequest(req, res, url) {
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (path === "/ai-responder" || path === "/ai-responder/index") {
    if (req.method !== "GET") return false;
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=\"utf-8\"><p>Define ADMIN_SECRET.</p>");
      return true;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=\"utf-8\"><p>Usa <code>/ai-responder?k=…</code></p>");
      return true;
    }
    let stats;
    let pending;
    let queuedPending;
    let recentLog;
    try {
      stats = await getStats();
      const p = await pool.query(
        `SELECT id, chat_id, customer_id, ai_reply_status, ai_confidence,
                LEFT(COALESCE(ai_reply_text, content::text), 100) AS preview,
                LEFT(COALESCE(ai_reasoning, ''), 220) AS evidencia_proceso,
                COALESCE(ai_provider, '') AS modelo_gateway,
                created_at
         FROM crm_messages
         WHERE ai_reply_status = 'needs_human_review'
         ORDER BY created_at DESC
         LIMIT 30`
      );
      pending = p.rows;
      const qp = await pool.query(
        `SELECT id, chat_id, customer_id, ai_reply_status,
                LEFT(COALESCE(content::text, ''), 140) AS contenido,
                created_at
         FROM crm_messages
         WHERE ai_reply_status IN ('pending_ai_reply', 'pending_receipt_confirm', 'processing')
         ORDER BY created_at DESC
         LIMIT 30`
      );
      queuedPending = qp.rows;
      const lg = await pool.query(
        `SELECT l.id, l.crm_message_id, l.action_taken, l.confidence,
                COALESCE(l.provider_used, '') AS provider_used,
                LEFT(COALESCE(l.reasoning, ''), 400) AS evidencia_razon,
                COALESCE(NULLIF(TRIM(l.error_message), ''), '') AS evidencia_error,
                LEFT(COALESCE(l.input_text, ''), 100) AS input_prev,
                LEFT(COALESCE(l.reply_text, ''), 120) AS reply_preview,
                l.created_at,
                COALESCE(ch_log.phone, ch_msg.phone) AS chat_phone
         FROM ai_response_log l
         LEFT JOIN crm_chats ch_log ON ch_log.id = l.chat_id
         LEFT JOIN crm_messages cm ON cm.id = l.crm_message_id
         LEFT JOIN crm_chats ch_msg ON ch_msg.id = cm.chat_id
         ORDER BY l.created_at DESC
         LIMIT 80`
      );
      recentLog = lg.rows;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return true;
    }
    const base = `/ai-responder?k=${encodeURIComponent(k)}`;
    const kEnc = encodeURIComponent(k);
    const monitoresHtml = [
      ["/monitor", "Monitor tiempo real (SSE)"],
      ["/hooks", "Webhook events (ML + mixto)"],
      ["/wasender-webhooks", "Eventos Wasender crudos"],
      ["/envios-whatsapp-tipo-e", "Log envíos WA Mercado (E/F)"],
      ["/envios-tipos-abc", "Log tipos A/B/C (ML)"],
      ["/media-logs", "Media CRM / transcripciones"],
      ["/payment-attempts", "Comprobantes de pago"],
      ["/preguntas-ia-auto-log", "IA auto preguntas ML (tipo D)"],
      ["/banesco", "Banesco estado / movimientos"],
      ["/statements", "Extractos banco"],
    ]
      .map(
        ([path, label]) =>
          `<li><a href="${path}?k=${kEnc}">${escapeHtml(label)}</a> <span class="muted"><code>${path}?k=…</code></span></li>`
      )
      .join("\n");
    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>AI Responder — Tipo M (piloto)</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1419;color:#e7e9ea;margin:2rem;max-width:1300px}
h1,h2{font-size:1rem}h2{margin-top:1.6rem}a{color:#1d9bf0}
.card{background:#15202b;border:1px solid #38444d;border-radius:8px;padding:1rem;margin:1rem 0}
.muted{color:#71767b;font-size:.82rem} table{border-collapse:collapse;width:100%;font-size:.72rem}
th,td{border:1px solid #38444d;padding:.3rem .4rem;text-align:left;vertical-align:top}
th{background:#1e2732;white-space:nowrap}
.badge{padding:.1rem .35rem;border-radius:4px;font-size:.72rem}
.badge.on{background:#003920;color:#00d395}.badge.off{background:#3b1219;color:#f4212e}
.badge.m{background:#1a237e;color:#c5cae9}
.badge.sent{background:#003920;color:#00d395;font-weight:700}
.badge.error{background:#3b1219;color:#f4212e;font-weight:700}
.badge.skip{background:#2d2200;color:#f0b429}
.badge.review{background:#1a237e;color:#c5cae9}
.badge.pend{background:#1e2732;color:#71767b}
tr.row-fail{background:#2a1515}
tr.row-ok{background:#061a0e}
td.evid{font-size:.66rem;max-width:18rem;word-break:break-word}
td.errdetail{font-size:.62rem;max-width:42rem;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;line-height:1.35}
td.msg{max-width:22rem;word-break:break-word}
td.phone{font-family:ui-monospace,Consolas,monospace;font-size:.68rem;white-space:nowrap}
.pill{display:inline-block;padding:.05rem .3rem;border-radius:3px;font-size:.65rem}
</style></head><body>
<h1>🤖 AI Responder — <span class="badge m">Tipo M</span></h1>
<p>
  <span class="badge ${stats.ai_responder_enabled ? "on" : "off"}">${stats.ai_responder_suspended ? "SUSPENDIDO — AI_RESPONDER_SUSPENDED=1" : stats.ai_responder_enabled ? "WORKER ON" : "WORKER OFF — falta AI_RESPONDER_ENABLED=1"}</span>
  <span class="badge ${stats.provider && stats.provider.groq_key_ok ? "on" : "off"}">GROQ_API_KEY: ${stats.provider && stats.provider.groq_key_ok ? "OK" : "❌ FALTA"}</span>
  <span class="badge ${stats.human_review_gate ? "on" : "off"}" title="AI_RESPONDER_FORCE_SEND = switch revisión humana">${stats.human_review_gate ? "Revisión humana ON" : "Revisión humana OFF (FORCE)"}</span>
</p>

<div class="card">
  <table style="width:auto;font-size:.8rem;border:none">
    <tr>
      <td style="border:none;padding:.15rem .6rem .15rem 0;color:#71767b">Enviados hoy</td>
      <td style="border:none;font-weight:700;color:#00d395">${stats.today_messages.auto_sent ?? 0}</td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b">Pendientes cola</td>
      <td style="border:none;font-weight:700;color:#c5cae9">${stats.today_messages.pending ?? 0}</td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b" title="needs_human_review: cola previa envío (sin FORCE) o post-fallo Wasender">Rev. humana</td>
      <td style="border:none;font-weight:700;color:#c5cae9">${stats.today_messages.needs_review ?? 0}
        <span class="muted" style="font-weight:400;font-size:.72rem"><br/>↳ post-WA: ${stats.today_messages.needs_review_post_wa_fail ?? 0} · pre-envío: ${stats.today_messages.needs_review_pre_send ?? 0}</span>
      </td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b">Error / fallo WA</td>
      <td style="border:none;font-weight:700;color:#f4212e">${logActionCount(stats.today_log_by_action, "error")}</td>
      <td style="border:none;padding:.15rem .6rem .15rem 1rem;color:#71767b">Saltados</td>
      <td style="border:none;color:#71767b">${stats.today_messages.skipped ?? 0}</td>
    </tr>
  </table>
  <p class="muted" style="margin-top:.5rem">
    Plantilla: <code>AI_RESPONDER_GENERIC_TEMPLATE</code> · placeholders <code>{{CONTEXTO_IA}}</code> <code>{{NOMBRE}}</code> <code>{{NOMBRE_SALUDO}}</code>
    · <a href="/api/ai-responder/stats?k=${kEnc}">stats JSON</a>
    · <a href="/api/ai-responder/log?k=${kEnc}">log JSON</a>
    · <a href="/api/ai-responder/ops-logs?k=${kEnc}">ops-logs JSON</a>
    · <a href="/api/ai-responder/pending?k=${kEnc}">pending JSON</a>
  </p>
  ${queuedPending.length > 0 ? `
  <p style="margin:.6rem 0 .3rem"><strong>⏳ En cola / procesando ahora</strong> <span class="muted">(${queuedPending.length})</span></p>
  <table>
    <thead><tr><th>#msg</th><th>chat</th><th>cliente</th><th>estado</th><th class="msg">contenido recibido</th><th>recibido</th></tr></thead>
    <tbody>
    ${queuedPending.map((r) => {
      const est = String(r.ai_reply_status || "");
      const estBadge = est === "processing"
        ? `<span class="badge" style="background:#1a237e;color:#c5cae9">⚙ procesando</span>`
        : est === "pending_receipt_confirm"
        ? `<span class="badge pend">comprobante</span>`
        : `<span class="badge pend">⏳ pendiente</span>`;
      return `<tr>
        <td>${r.id}</td>
        <td>${escapeHtml(String(r.chat_id || "—"))}</td>
        <td>${escapeHtml(String(r.customer_id || "—"))}</td>
        <td>${estBadge}</td>
        <td class="msg">${escapeHtml(r.contenido || "—")}</td>
        <td>${escapeHtml(String(r.created_at))}</td>
      </tr>`;
    }).join("")}
    </tbody>
  </table>` : `<p class="muted" style="margin:.4rem 0 0">Sin mensajes en cola ahora.</p>`}
</div>

<h2>📋 Log completo de mensajes automáticos (últimos 80)</h2>
<p class="muted">
  <span class="pill" style="background:#003920;color:#00d395">✔ sent</span> = enviado OK a Wasender ·
  <span class="pill" style="background:#3b1219;color:#f4212e">✖ error</span> = fallo al enviar (Wasender rechazó o sin respuesta) ·
  <span class="pill" style="background:#1a237e;color:#c5cae9">⏳ queued_review</span> = en cola revisión humana ·
  <span class="pill" style="background:#2d2200;color:#f0b429">skip</span> = saltado (sin texto, sin teléfono, etc.)
</p>
<p class="muted" style="margin-top:.25rem;line-height:1.45">
  Columna <strong>error / detalle</strong>: primera línea <code>[origen=…]</code> — <code>WASENDER_API</code> = respuesta HTTP/API de envío;
  <code>APP_CONFIG</code> / <code>APP_DATOS</code> / <code>APP_LOGIC</code> = no se llegó a llamar a Wasender;
  fallos del modelo para <code>context_line</code> van en <strong>razón / contexto IA</strong> como <code>[origen=GROQ_LLAMA: …]</code> (la plantilla igual se arma con fallback).
</p>
<table>
  <thead><tr>
    <th>#log</th><th>#msg</th>
    <th>teléfono (chat)</th>
    <th>resultado</th>
    <th>conf</th>
    <th class="msg">mensaje del cliente</th>
    <th class="msg">respuesta enviada / sugerida</th>
    <th class="evid">razón / contexto IA</th>
    <th class="errdetail">error / detalle (origen + API)</th>
    <th>hora</th>
  </tr></thead>
  <tbody>
${recentLog
  .map((r) => {
    const act = String(r.action_taken || "");
    const isSent = act === "sent";
    const isError = act === "error" || (r.evidencia_error && String(r.evidencia_error).trim() !== "");
    const isReview = act === "queued_review" || act === "approved_by_human" || act === "overridden";
    const isSkip = act.startsWith("skipped");
    const rowClass = isSent ? "row-ok" : isError ? "row-fail" : "";
    const badgeCls = isSent ? "sent" : isError ? "error" : isReview ? "review" : isSkip ? "skip" : "pend";
    const badgeTxt = isSent ? "✔ enviado" : isError ? "✖ error WA" : isReview ? "⏳ rev. humana" : isSkip ? "⬜ skip" : escapeHtml(act);
    return `<tr class="${rowClass}">
  <td>${r.id}</td>
  <td>${r.crm_message_id ?? "—"}</td>
  <td class="phone">${escapeHtml(r.chat_phone && String(r.chat_phone).trim() ? String(r.chat_phone).trim() : "—")}</td>
  <td><span class="badge ${badgeCls}">${badgeTxt}</span></td>
  <td>${r.confidence ?? "—"}</td>
  <td class="msg">${escapeHtml(r.input_prev || "—")}</td>
  <td class="msg">${escapeHtml(r.reply_preview || "—")}</td>
  <td class="evid">${escapeHtml(r.evidencia_razon || "—")}</td>
  <td class="errdetail">${escapeHtml(r.evidencia_error || "—")}</td>
  <td>${escapeHtml(String(r.created_at))}</td>
</tr>`;
  })
  .join("")}
  </tbody>
</table>

<h2>🔍 Revisión humana pendiente</h2>
${pending.length === 0
  ? `<p class="muted">Sin mensajes en revisión humana actualmente.</p>`
  : `<table><thead><tr><th>id</th><th>chat</th><th>conf</th><th class="msg">vista</th><th class="evid">motivo / evidencia</th><th>creado</th><th>aprobar</th></tr></thead><tbody>
${pending.map((r) => `<tr>
  <td>${r.id}</td>
  <td>${escapeHtml(String(r.chat_id))}</td>
  <td>${r.ai_confidence ?? "—"}</td>
  <td class="msg">${escapeHtml(r.preview || "")}</td>
  <td class="evid">${escapeHtml(r.evidencia_proceso || "—")}</td>
  <td>${escapeHtml(String(r.created_at))}</td>
  <td><button type="button" onclick="approve(${r.id})">Enviar sugerencia IA</button></td>
</tr>`).join("")}
</tbody></table>`}

<div class="card" style="margin-top:1.5rem">
  <strong>Otros monitores HTML</strong> (misma clave <code>?k=</code>)
  <ul class="muted" style="margin:.4rem 0 0 1rem;line-height:1.6">${monitoresHtml}</ul>
</div>
<script>
const _k = ${JSON.stringify(k)};
async function approve(mid) {
  if (!confirm('¿Enviar la sugerencia IA al cliente?')) return;
  const r = await fetch('/api/ai-responder/' + mid + '/approve?k=' + encodeURIComponent(_k), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const j = await r.json();
  alert(j.ok ? 'Enviado' : JSON.stringify(j));
  if (j.ok) location.reload();
}
</script>
<p class="muted"><a href="${base}">Recargar</a> · <a href="/monitor?k=${kEnc}">/monitor</a> (SSE)</p>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (!path.startsWith("/api/ai-responder")) return false;
  if (!await requireAdminOrPermission(req, res, 'crm')) return true;

  if (req.method === "GET" && path === "/api/ai-responder/stats") {
    try {
      const s = await getStats();
      writeJson(res, 200, s);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/ai-responder/settings") {
    try {
      const body = await getAiResponderSettings();
      writeJson(res, 200, body);
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  if (req.method === "PATCH" && path === "/api/ai-responder/settings") {
    let body = {};
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      writeJson(res, 400, { ok: false, error: "json_invalid" });
      return true;
    }
    try {
      const { updateSwitches } = require("../services/aiConsoleSwitches");
      const partial = {};
      if (body.tipo_m_enabled !== undefined) partial.tipo_m_enabled = body.tipo_m_enabled;
      if (body.transcription_groq !== undefined) partial.transcription_groq = body.transcription_groq;
      if (body.wa_name_groq !== undefined) partial.wa_name_groq = body.wa_name_groq;
      if (body.receipt_gemini_vision !== undefined) partial.receipt_gemini_vision = body.receipt_gemini_vision;
      const updated = await updateSwitches(partial);
      const snapshot = await getAiResponderSettings();
      writeJson(res, 200, { ok: true, updated, ...snapshot });
    } catch (e) {
      if (e && e.code === "AI_CONSOLE_SCHEMA") {
        writeJson(res, 503, { ok: false, error: "schema_unavailable", detail: e.message });
      } else {
        writeJson(res, 500, { ok: false, error: e.message });
      }
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/ai-responder/ops-logs") {
    try {
      const body = await getOpsLogs(url);
      writeJson(res, 200, body);
    } catch (e) {
      log.warn({ err: e.message }, "ai_responder ops-logs");
      writeJson(res, 500, {
        ok: false,
        error: e.message,
        days: 7,
        name_analysis_logs: [],
        receipt_vision_logs: [],
        receipt_attempts: [],
      });
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/ai-responder/pending") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    try {
      // El drawer de revisión humana (Sprint 6B FE) consume este endpoint. Los mensajes en estado
      // 'legacy_archived' quedan excluidos por diseño (backlog pre-Sprint 6A archivado).
      // channel_id: viene de sales_orders.conversation_id = chat (orden más reciente); sin orden → NULL.
      // source_type: fallback para ChannelBadge del drawer de revisión humana (Sprint 6B FE). Cuando
      // channel_id viene NULL (chat sin orden vinculada), el FE cae a source_type para el canal visual.
      // channel_id sigue siendo preferido cuando está disponible (info más precisa · ADR-007). Valores
      // típicos en BD: wa_inbound, ml_question, ml_message, wa_ml_linked (chk_crm_chats_source_type).
      const { rows } = await pool.query(
        `SELECT m.id, m.chat_id, m.customer_id, m.ai_reply_status, m.ai_confidence, m.ai_reply_text,
                m.ai_reasoning, m.content, m.created_at, m.transcription,
                NULLIF(TRIM(ch.phone), '') AS chat_phone,
                ch.source_type AS source_type,
                NULLIF(TRIM(cu.full_name), '') AS customer_full_name,
                cu.client_segment AS customer_segment,
                so_ch.channel_id,
                NULLIF(
                  LEFT(
                    TRIM(
                      COALESCE(
                        NULLIF(m.transcription, ''),
                        NULLIF(m.content->>'transcription', ''),
                        NULLIF(m.content->>'text', ''),
                        ''
                      )
                    ),
                    200
                  ),
                  ''
                ) AS message_text_preview
         FROM crm_messages m
         LEFT JOIN crm_chats ch ON ch.id = m.chat_id
         LEFT JOIN customers cu ON cu.id = COALESCE(m.customer_id, ch.customer_id)
         LEFT JOIN LATERAL (
           SELECT so.channel_id
           FROM sales_orders so
           WHERE so.conversation_id = m.chat_id
           ORDER BY so.created_at DESC NULLS LAST
           LIMIT 1
         ) so_ch ON TRUE
         WHERE m.ai_reply_status = 'needs_human_review'
         ORDER BY m.created_at DESC
         LIMIT $1`,
        [limit]
      );
      writeJson(res, 200, { ok: true, rows });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/api/ai-responder/log") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "80", 10) || 80, 500);
    try {
      const { rows } = await pool.query(
        `SELECT l.*, COALESCE(ch_log.phone, ch_msg.phone) AS chat_phone
         FROM ai_response_log l
         LEFT JOIN crm_chats ch_log ON ch_log.id = l.chat_id
         LEFT JOIN crm_messages cm ON cm.id = l.crm_message_id
         LEFT JOIN crm_chats ch_msg ON ch_msg.id = cm.chat_id
         ORDER BY l.created_at DESC
         LIMIT $1`,
        [limit]
      );
      writeJson(res, 200, { ok: true, rows });
    } catch (e) {
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  const postMatch = path.match(/^\/api\/ai-responder\/(\d+)\/(approve|override|reject|draft)$/);
  if (postMatch && req.method === "POST") {
    const id = postMatch[1];
    const action = postMatch[2];
    let body = {};
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      writeJson(res, 400, { ok: false, error: "json_invalid" });
      return true;
    }
    try {
      if (action === "approve") await handleApprove(req, res, id);
      else if (action === "override") await handleOverride(req, res, id, body);
      else if (action === "reject") await handleReject(req, res, id, body);
      else await handleDraft(req, res, id, body);
    } catch (e) {
      log.error({ err: e.message }, "ai_responder approve/override/reject/draft");
      writeJson(res, 500, { ok: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleAiResponderRequest, getStats, getOpsLogs, getAiResponderSettings };
