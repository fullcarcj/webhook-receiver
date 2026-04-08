"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { sendWasenderTextMessage } = require("../../wasender-client");
const { normalizePhoneToE164 } = require("../../ml-whatsapp-phone");
const { resolveWasenderRuntimeConfig } = require("../../ml-whatsapp-tipo-ef");
const { sanitizeWaPersonName, isLikelyChatNotName } = require("../whatsapp/waNameCandidate");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "crmWaWelcome" });

function isPlaceholderCustomerName(fullName) {
  const s = fullName != null ? String(fullName).trim() : "";
  if (!s) return true;
  if (s === "Cliente WhatsApp" || s === "Cliente") return true;
  if (/^WA-\d+$/i.test(s)) return true;
  if (isLikelyChatNotName(s)) return true;
  return false;
}

/** Nombre + apellido para saludo (dos primeras palabras del nombre saneado). */
function greetingNombreApellido(fullName) {
  const sanitized = sanitizeWaPersonName(String(fullName || ""));
  if (!sanitized) return null;
  const parts = sanitized.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[1]}`;
  return parts[0] || null;
}

function hasRealNameForGreeting(fullName) {
  if (isPlaceholderCustomerName(fullName)) return false;
  return Boolean(sanitizeWaPersonName(String(fullName)));
}

/**
 * Tras el primer mensaje inbound guardado: si el cliente ya tiene nombre/apellido válido en CRM → saludo;
 * si no → pedir nombre y apellido. Una sola vez por chat (wa_welcome_sent_at).
 * Requiere CRM_WA_WELCOME_ENABLED=1 y Wasender configurado (misma lógica que tipo E/F).
 */
async function trySendCrmWaWelcome({ chatId, customerId, phoneRaw }) {
  if (String(process.env.CRM_WA_WELCOME_ENABLED || "").trim() !== "1") {
    return { ok: false, outcome: "disabled" };
  }
  const cid = Number(chatId);
  const custId = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(custId) || custId <= 0) {
    return { ok: false, outcome: "bad_args" };
  }

  const cfg = await resolveWasenderRuntimeConfig();
  if (!cfg.enabled) {
    return { ok: false, outcome: "wasender_off" };
  }

  let row;
  try {
    const r = await pool.query(
      `SELECT c.wa_welcome_sent_at, cu.full_name
       FROM crm_chats c
       LEFT JOIN customers cu ON cu.id = c.customer_id
       WHERE c.id = $1`,
      [cid]
    );
    row = r.rows[0];
  } catch (e) {
    if (e && e.code === "42703") {
      log.warn("crm_welcome: columna wa_welcome_sent_at ausente — ejecutar npm run db:crm-wa-welcome");
      return { ok: false, outcome: "schema" };
    }
    throw e;
  }

  if (!row || row.wa_welcome_sent_at != null) {
    return { ok: false, outcome: "already_sent" };
  }

  const fullName = row.full_name != null ? String(row.full_name) : "";
  const askTemplate =
    process.env.CRM_WA_WELCOME_ASK_NAME ||
    "Hola! Bienvenido a Solomotor3k ¿Cuál es su nombre y apellido?";
  const greetTemplate =
    process.env.CRM_WA_WELCOME_GREETING ||
    "Hola {{nombre}}, ¿en qué podemos ayudarte?";

  let text;
  if (hasRealNameForGreeting(fullName)) {
    const nombre = greetingNombreApellido(fullName);
    if (!nombre) {
      return { ok: false, outcome: "no_greeting_name" };
    }
    text = String(greetTemplate).replace(/\{\{nombre\}\}/g, nombre);
  } else {
    text = askTemplate;
  }

  const to = normalizePhoneToE164(phoneRaw, cfg.defaultCountryCode);
  if (!to) {
    log.warn({ phoneRaw }, "crm_welcome: teléfono no normalizable a E.164");
    return { ok: false, outcome: "bad_phone" };
  }

  const res = await sendWasenderTextMessage({
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    to,
    text,
  });

  if (!res.ok) {
    log.warn({ status: res.status, to }, "crm_welcome: Wasender no OK");
    return { ok: false, outcome: "send_failed", httpStatus: res.status };
  }

  try {
    await pool.query(`UPDATE crm_chats SET wa_welcome_sent_at = NOW() WHERE id = $1 AND wa_welcome_sent_at IS NULL`, [
      cid,
    ]);
  } catch (e) {
    if (e && e.code === "42703") {
      log.warn("crm_welcome: no se pudo marcar wa_welcome_sent_at (migración pendiente)");
    } else {
      throw e;
    }
  }

  log.info({ chatId: cid, customerId: custId, kind: hasRealNameForGreeting(fullName) ? "greet" : "ask" }, "crm_welcome: enviado");
  return { ok: true, outcome: "sent" };
}

module.exports = {
  trySendCrmWaWelcome,
  isPlaceholderCustomerName,
  greetingNombreApellido,
  hasRealNameForGreeting,
};
