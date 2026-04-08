"use strict";

const pino = require("pino");
const { pool, insertMlWhatsappWasenderLog } = require("../../db");
const { sendWasenderTextMessage } = require("../../wasender-client");
const { normalizePhoneToE164 } = require("../../ml-whatsapp-phone");
const { resolveWasenderRuntimeConfig } = require("../../ml-whatsapp-tipo-ef");
const { sanitizeWaPersonName, isLikelyChatNotName } = require("../whatsapp/waNameCandidate");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "crmWaWelcome" });

let _hintLoggedWasenderOff = false;

/** Activo salvo desactivación explícita (0 / false / no / off). */
function isCrmWelcomeFeatureEnabled() {
  const v = String(process.env.CRM_WA_WELCOME_ENABLED ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

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
  if (!isCrmWelcomeFeatureEnabled()) {
    return { ok: false, outcome: "disabled" };
  }
  const cid = Number(chatId);
  const custId = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(custId) || custId <= 0) {
    return { ok: false, outcome: "bad_args" };
  }

  const cfg = await resolveWasenderRuntimeConfig();
  if (!cfg.enabled) {
    if (!_hintLoggedWasenderOff) {
      _hintLoggedWasenderOff = true;
      log.warn(
        "crm_welcome: Wasender no habilitado o sin WASENDER_API_KEY — revisar WASENDER_ENABLED / BD ml_wasender_settings"
      );
    }
    return { ok: false, outcome: "wasender_off" };
  }

  let row;
  try {
    const r = await pool.query(
      `SELECT c.wa_welcome_sent_at, cu.full_name, cu.primary_ml_buyer_id
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

  if (!row) {
    return { ok: false, outcome: "no_chat_row" };
  }

  if (row.wa_welcome_sent_at != null) {
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

  /** Reserva atómica: evita doble envío (webhooks duplicados o carreras). */
  let claim;
  try {
    claim = await pool.query(
      `UPDATE crm_chats SET wa_welcome_sent_at = NOW() WHERE id = $1 AND wa_welcome_sent_at IS NULL RETURNING id`,
      [cid]
    );
  } catch (e) {
    if (e && e.code === "42703") {
      log.warn("crm_welcome: columna wa_welcome_sent_at ausente — ejecutar npm run db:crm-wa-welcome");
      return { ok: false, outcome: "schema" };
    }
    throw e;
  }

  if (!claim.rows.length) {
    return { ok: false, outcome: "already_sent" };
  }

  const buyerId =
    row.primary_ml_buyer_id != null && Number.isFinite(Number(row.primary_ml_buyer_id))
      ? Number(row.primary_ml_buyer_id)
      : null;

  /* Mismo POST que el texto en E/F: wasender-client.sendWasenderTextMessage → { to, text } */
  const res = await sendWasenderTextMessage({
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    to,
    text,
  });

  const msgId =
    res.json && res.json.data && res.json.data.msgId != null ? Number(res.json.data.msgId) : null;
  const preview = text.slice(0, 200);

  if (!res.ok) {
    try {
      await pool.query(`UPDATE crm_chats SET wa_welcome_sent_at = NULL WHERE id = $1`, [cid]);
    } catch (_e) {
      /* ignore */
    }
    try {
      await insertMlWhatsappWasenderLog({
        message_kind: "F",
        ml_user_id: null,
        buyer_id: buyerId,
        order_id: null,
        ml_question_id: null,
        phone_e164: to,
        phone_source: null,
        outcome: "api_error",
        http_status: res.status,
        response_body: res.bodyText ? res.bodyText.slice(0, 8000) : null,
        error_message: `HTTP ${res.status}`,
        text_preview: preview,
        tipo_e_activation_source: "crm_wa_welcome",
      });
    } catch (_e) {
      /* ignore */
    }
    log.warn({ status: res.status, to, body: res.bodyText && String(res.bodyText).slice(0, 500) }, "crm_welcome: Wasender no OK");
    return { ok: false, outcome: "send_failed", httpStatus: res.status };
  }

  try {
    await insertMlWhatsappWasenderLog({
      message_kind: "F",
      ml_user_id: null,
      buyer_id: buyerId,
      order_id: null,
      ml_question_id: null,
      phone_e164: to,
      phone_source: null,
      outcome: "success",
      http_status: res.status,
      wasender_msg_id: Number.isFinite(msgId) ? msgId : null,
      response_body: res.bodyText ? res.bodyText.slice(0, 8000) : null,
      text_preview: preview,
      tipo_e_activation_source: "crm_wa_welcome",
    });
  } catch (_e) {
    /* ignore */
  }

  log.info(
    { chatId: cid, customerId: custId, kind: hasRealNameForGreeting(fullName) ? "greet" : "ask" },
    "crm_welcome: enviado"
  );
  return { ok: true, outcome: "sent" };
}

module.exports = {
  trySendCrmWaWelcome,
  isPlaceholderCustomerName,
  greetingNombreApellido,
  hasRealNameForGreeting,
};
