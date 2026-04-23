"use strict";

/**
 * Interruptores de consola para IA (WhatsApp CRM).
 * Tabla singleton `ai_console_switches` — se crea en el primer GET/PATCH si no existe.
 * Complementan variables de entorno: el efecto final suele ser env AND consola.
 */

const { pool } = require("../../db");

function envAiResponderSuspended() {
  const v = String(process.env.AI_RESPONDER_SUSPENDED ?? "").trim().toLowerCase();
  if (!v) return false;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return ["1", "true", "yes", "on"].includes(v);
}

const DEFAULTS = Object.freeze({
  tipo_m_enabled: true,
  transcription_groq: true,
  wa_name_groq: true,
  receipt_gemini_vision: true,
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_console_switches (
      singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
      tipo_m_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      transcription_groq BOOLEAN NOT NULL DEFAULT TRUE,
      wa_name_groq BOOLEAN NOT NULL DEFAULT TRUE,
      receipt_gemini_vision BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO ai_console_switches (singleton) VALUES (1)
     ON CONFLICT (singleton) DO NOTHING`
  );
}

/**
 * @returns {Promise<{
 *   tipo_m_enabled: boolean;
 *   transcription_groq: boolean;
 *   wa_name_groq: boolean;
 *   receipt_gemini_vision: boolean;
 *   schema_ready: boolean;
 *   schema_error?: string;
 * }>}
 */
async function getSwitches() {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT tipo_m_enabled, transcription_groq, wa_name_groq, receipt_gemini_vision
       FROM ai_console_switches WHERE singleton = 1`
    );
    const r = rows[0] || {};
    return {
      tipo_m_enabled: r.tipo_m_enabled !== false,
      transcription_groq: r.transcription_groq !== false,
      wa_name_groq: r.wa_name_groq !== false,
      receipt_gemini_vision: r.receipt_gemini_vision !== false,
      schema_ready: true,
    };
  } catch (e) {
    const code = e && e.code;
    if (code === "42P01" || code === "42501" || code === "3D000") {
      return { ...DEFAULTS, schema_ready: false, schema_error: String(e.message || e) };
    }
    throw e;
  }
}

/**
 * Tipo M efectivo: consola + env (AI_RESPONDER_ENABLED / SUSPENDED).
 */
async function isTipoMConsoleAndEnvEnabled() {
  const sw = await getSwitches();
  if (!sw.tipo_m_enabled) return false;
  const envOn = String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1";
  if (!envOn || envAiResponderSuspended()) return false;
  return true;
}

/**
 * @param {Partial<{
 *   tipo_m_enabled: boolean;
 *   transcription_groq: boolean;
 *   wa_name_groq: boolean;
 *   receipt_gemini_vision: boolean;
 * }>} partial
 */
async function updateSwitches(partial) {
  await ensureTable();
  const cur = await getSwitches();
  if (!cur.schema_ready) {
    const err = new Error("ai_console_switches no disponible");
    err.code = "AI_CONSOLE_SCHEMA";
    throw err;
  }
  const next = {
    tipo_m_enabled:
      partial.tipo_m_enabled !== undefined ? Boolean(partial.tipo_m_enabled) : cur.tipo_m_enabled,
    transcription_groq:
      partial.transcription_groq !== undefined
        ? Boolean(partial.transcription_groq)
        : cur.transcription_groq,
    wa_name_groq:
      partial.wa_name_groq !== undefined ? Boolean(partial.wa_name_groq) : cur.wa_name_groq,
    receipt_gemini_vision:
      partial.receipt_gemini_vision !== undefined
        ? Boolean(partial.receipt_gemini_vision)
        : cur.receipt_gemini_vision,
  };
  await pool.query(
    `UPDATE ai_console_switches SET
       tipo_m_enabled = $1,
       transcription_groq = $2,
       wa_name_groq = $3,
       receipt_gemini_vision = $4,
       updated_at = NOW()
     WHERE singleton = 1`,
    [
      next.tipo_m_enabled,
      next.transcription_groq,
      next.wa_name_groq,
      next.receipt_gemini_vision,
    ]
  );
  return getSwitches();
}

module.exports = {
  getSwitches,
  updateSwitches,
  isTipoMConsoleAndEnvEnabled,
  DEFAULTS,
};
