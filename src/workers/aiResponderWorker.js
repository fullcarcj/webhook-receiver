"use strict";

/**
 * Worker: toma mensajes inbound en cola IA con UPDATE … FOR UPDATE SKIP LOCKED.
 * Desactivado por defecto — activar AI_RESPONDER_ENABLED=1.
 */

const pino = require("pino");
const { pool } = require("../../db");
const { processOneMessage, isEnabled, setImmediateTrigger } = require("../services/aiResponder");
const { isTipoMConsoleAndEnvEnabled } = require("../services/aiConsoleSwitches");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_responder_worker" });

/** Estados elegibles para la cola automática Tipo M (excluye legacy_archived y needs_human_review). */
const INBOUND_AI_QUEUE_STATUSES = Object.freeze(["pending_ai_reply", "pending_receipt_confirm"]);

let isRunning = false;
let workerHandle = null;
let stuckHandle = null;

async function cleanStuckProcessing() {
  try {
    const r = await pool.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'needs_human_review',
           ai_reasoning = COALESCE(ai_reasoning, '') ||
             ' [recuperado: processing colgado >10 min]'
       WHERE ai_reply_status = 'processing'
         AND ai_processed_at IS NOT NULL
         AND ai_processed_at < NOW() - INTERVAL '10 minutes'`
    );
    if (r.rowCount > 0) {
      log.warn({ count: r.rowCount }, "ai_responder: mensajes processing liberados");
    }
  } catch (e) {
    if (e && e.code === "42703") return;
    log.error({ err: e.message }, "cleanStuckProcessing");
  }
}

async function responderCycle() {
  if (!isEnabled()) return;
  if (!(await isTipoMConsoleAndEnvEnabled())) return;
  if (isRunning) return;
  isRunning = true;

  try {
    // GROQ_API_KEY en env es suficiente para operar — provider_settings es referencial.
    const provOk = !!process.env.GROQ_API_KEY;
    if (!provOk) {
      log.warn("ai_responder: GROQ_API_KEY no definida — skip ciclo");
      return;
    }

    const statusIn = INBOUND_AI_QUEUE_STATUSES.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(", ");
    const { rows: claimed } = await pool.query(`
      UPDATE crm_messages AS m
      SET ai_reply_status = 'processing',
          ai_processed_at = NOW()
      WHERE m.id = (
        SELECT id FROM crm_messages
        WHERE ai_reply_status IN (${statusIn})
          AND direction = 'inbound'
          AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING m.id, m.customer_id, m.chat_id, m.content, m.transcription,
                m.receipt_data, m.ai_reply_status, m.direction
    `);

    if (!claimed.length) return;

    const message = claimed[0];
    try {
      await processOneMessage(message);
    } catch (err) {
      log.error({ err: err.message, messageId: message.id }, "processOneMessage");
      await pool
        .query(
          `UPDATE crm_messages
           SET ai_reply_status = 'needs_human_review',
               ai_reasoning = $1
           WHERE id = $2`,
          [`Error: ${String(err.message || err).slice(0, 500)}`, message.id]
        )
        .catch(() => {});
    }
  } catch (e) {
    if (e && e.code === "42703") {
      log.debug("ai_responder: columnas IA no migradas — npm run db:ai-responder");
      return;
    }
    log.error({ err: e.message }, "responderCycle");
  } finally {
    isRunning = false;
  }
}

function startAiResponderWorker() {
  if (!isEnabled()) {
    log.info("ai_responder worker: AI_RESPONDER_ENABLED != 1 — sin iniciar");
    return;
  }
  const CYCLE_MS = parseInt(process.env.AI_RESPONDER_INTERVAL_MS || "8000", 10);
  const STUCK_MS = 5 * 60 * 1000;
  workerHandle = setInterval(responderCycle, CYCLE_MS);
  stuckHandle = setInterval(cleanStuckProcessing, STUCK_MS);
  // Registrar callback para disparar ciclos inmediatos desde maybeQueueInboundText
  // y eliminar el delay de hasta CYCLE_MS entre que llega un mensaje y se procesa.
  setImmediateTrigger(responderCycle);
  log.info({ intervalMs: CYCLE_MS }, "ai_responder worker iniciado");
}

function stopAiResponderWorker() {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
  if (stuckHandle) {
    clearInterval(stuckHandle);
    stuckHandle = null;
  }
  log.info("ai_responder worker detenido");
}

module.exports = {
  startAiResponderWorker,
  stopAiResponderWorker,
  responderCycle,
  cleanStuckProcessing,
  INBOUND_AI_QUEUE_STATUSES,
};
