"use strict";

/**
 * Flujo CRM bienvenida Wasender (messages.received → messages.js):
 *
 * 1) Webhook: se resuelve teléfono → customers + crm_chats (resolveCustomerId + upsertChat).
 * 2) Se guarda el mensaje entrante; el texto puede enriquecer customers.full_name (nombre+apellido vía resolveCustomer).
 * 3) trySendCrmWaWelcome (una vez por chat, salvo fallo de envío):
 *    - Si customers.full_name ya es nombre+apellido válido → saludo con {{nombre}} (dos primeras palabras).
 *    - Si no (placeholder o solo una palabra) → plantilla que pide nombre y apellido; marca wa_welcome_pending_name.
 * 4) Mensajes siguientes: si había pedido pendiente y ahora hay nombre válido en customers → trySendCrmWaWelcomeAfterName
 *    envía el saludo con nombre (y limpia pending).
 *
 * Requiere migración: npm run db:crm-wa-welcome (wa_welcome_sent_at + wa_welcome_pending_name).
 */

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

/** Reserva el slot de bienvenida; pendingAsk=true si solo pedimos nombre (luego trySendCrmWaWelcomeAfterName). */
async function claimWelcomeFirstMessage(chatId, pendingAsk) {
  try {
    const r = await pool.query(
      `UPDATE crm_chats SET wa_welcome_sent_at = NOW(), wa_welcome_pending_name = $2
       WHERE id = $1 AND wa_welcome_sent_at IS NULL RETURNING id`,
      [chatId, pendingAsk]
    );
    return r.rows.length > 0;
  } catch (e) {
    if (e && e.code === "42703") {
      const r = await pool.query(
        `UPDATE crm_chats SET wa_welcome_sent_at = NOW() WHERE id = $1 AND wa_welcome_sent_at IS NULL RETURNING id`,
        [chatId]
      );
      return r.rows.length > 0;
    }
    throw e;
  }
}

async function resetWelcomeClaim(chatId) {
  try {
    await pool.query(
      `UPDATE crm_chats SET wa_welcome_sent_at = NULL, wa_welcome_pending_name = FALSE WHERE id = $1`,
      [chatId]
    );
  } catch (e) {
    if (e && e.code === "42703") {
      await pool.query(`UPDATE crm_chats SET wa_welcome_sent_at = NULL WHERE id = $1`, [chatId]);
    } else throw e;
  }
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
    log.warn({ chatId: cid }, "crm_welcome: no hay fila crm_chats");
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
    log.warn(
      { phoneRaw, chatId: cid },
      "crm_welcome: teléfono no normalizable a E.164 (revisar dígitos del webhook / default país en ml_wasender_settings)"
    );
    return { ok: false, outcome: "bad_phone" };
  }

  /** Reserva atómica: evita doble envío (webhooks duplicados o carreras). */
  const pendingAsk = !hasRealNameForGreeting(fullName);
  const claimed = await claimWelcomeFirstMessage(cid, pendingAsk);
  if (!claimed) {
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
      await resetWelcomeClaim(cid);
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

/**
 * Tras pedir nombre: cuando ya hay nombre+apellido en customers (mensaje siguiente o mismo ciclo),
 * envía el saludo con {{nombre}} una vez y limpia wa_welcome_pending_name.
 */
async function trySendCrmWaWelcomeAfterName({ chatId, customerId, phoneRaw }) {
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
    return { ok: false, outcome: "wasender_off" };
  }

  let row;
  try {
    const r = await pool.query(
      `SELECT c.wa_welcome_pending_name, c.customer_id, cu.full_name, cu.primary_ml_buyer_id
       FROM crm_chats c
       LEFT JOIN customers cu ON cu.id = c.customer_id
       WHERE c.id = $1`,
      [cid]
    );
    row = r.rows[0];
  } catch (e) {
    if (e && e.code === "42703") {
      return { ok: false, outcome: "schema" };
    }
    throw e;
  }

  if (!row) {
    return { ok: false, outcome: "no_chat_row" };
  }
  if (Number(row.customer_id) !== custId) {
    return { ok: false, outcome: "bad_chat" };
  }

  if (row.wa_welcome_pending_name !== true) {
    return { ok: false, outcome: "not_pending" };
  }

  const fullName = row.full_name != null ? String(row.full_name) : "";
  if (!hasRealNameForGreeting(fullName)) {
    return { ok: false, outcome: "still_no_name" };
  }

  const nombre = greetingNombreApellido(fullName);
  if (!nombre) {
    return { ok: false, outcome: "no_greeting_name" };
  }

  const greetTemplate =
    process.env.CRM_WA_WELCOME_GREETING || "Hola {{nombre}}, ¿en qué podemos ayudarte?";
  const text = String(greetTemplate).replace(/\{\{nombre\}\}/g, nombre);

  const to = normalizePhoneToE164(phoneRaw, cfg.defaultCountryCode);
  if (!to) {
    log.warn({ phoneRaw }, "crm_welcome_followup: teléfono no normalizable a E.164");
    return { ok: false, outcome: "bad_phone" };
  }

  let claimedFollowup;
  try {
    const r = await pool.query(
      `UPDATE crm_chats SET wa_welcome_pending_name = FALSE WHERE id = $1 AND wa_welcome_pending_name = TRUE RETURNING id`,
      [cid]
    );
    claimedFollowup = r.rows.length > 0;
  } catch (e) {
    if (e && e.code === "42703") {
      return { ok: false, outcome: "schema" };
    }
    throw e;
  }

  if (!claimedFollowup) {
    return { ok: false, outcome: "not_pending" };
  }

  const buyerId =
    row.primary_ml_buyer_id != null && Number.isFinite(Number(row.primary_ml_buyer_id))
      ? Number(row.primary_ml_buyer_id)
      : null;

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
      await pool.query(`UPDATE crm_chats SET wa_welcome_pending_name = TRUE WHERE id = $1`, [cid]);
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
        tipo_e_activation_source: "crm_wa_welcome_followup",
      });
    } catch (_e) {
      /* ignore */
    }
    log.warn({ status: res.status, to }, "crm_welcome_followup: Wasender no OK");
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
      tipo_e_activation_source: "crm_wa_welcome_followup",
    });
  } catch (_e) {
    /* ignore */
  }

  log.info({ chatId: cid, customerId: custId }, "crm_welcome_followup: enviado");
  return { ok: true, outcome: "sent" };
}

/**
 * Primer contacto (Caso 3): contacto nuevo, sin cliente en BD.
 * Envía el mensaje de bienvenida + solicitud de nombre.
 * No requiere customerId ni chatId porque el cliente todavía NO está registrado.
 * Env: CRM_WA_WELCOME_ASK_NAME (override del texto).
 */
async function trySendCrmWaAskName({ phoneRaw }) {
  if (!isCrmWelcomeFeatureEnabled()) {
    return { ok: false, outcome: "disabled" };
  }

  const cfg = await resolveWasenderRuntimeConfig();
  if (!cfg.enabled) {
    if (!_hintLoggedWasenderOff) {
      _hintLoggedWasenderOff = true;
      log.warn("crm_wa_ask_name: Wasender no habilitado — revisar WASENDER_ENABLED / BD ml_wasender_settings");
    }
    return { ok: false, outcome: "wasender_off" };
  }

  const to = normalizePhoneToE164(phoneRaw, cfg.defaultCountryCode);
  if (!to) {
    log.warn({ phoneRaw }, "crm_wa_ask_name: teléfono no normalizable a E.164");
    return { ok: false, outcome: "bad_phone" };
  }

  const text =
    process.env.CRM_WA_WELCOME_ASK_NAME ||
    "¡Hola! Bienvenido a Solomotor3k. No tenemos tu nombre registrado en nuestro sistema. Por favor, dinos tu Nombre y Apellido para poder atenderte.";

  const res = await sendWasenderTextMessage({
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    to,
    text,
  });

  const msgId =
    res.json && res.json.data && res.json.data.msgId != null ? Number(res.json.data.msgId) : null;
  const preview = text.slice(0, 200);

  try {
    await insertMlWhatsappWasenderLog({
      message_kind: "F",
      ml_user_id: null,
      buyer_id: null,
      order_id: null,
      ml_question_id: null,
      phone_e164: to,
      phone_source: null,
      outcome: res.ok ? "success" : "api_error",
      http_status: res.status,
      wasender_msg_id: res.ok && Number.isFinite(msgId) ? msgId : null,
      response_body: res.bodyText ? res.bodyText.slice(0, 8000) : null,
      error_message: res.ok ? null : `HTTP ${res.status}`,
      text_preview: preview,
      tipo_e_activation_source: "crm_wa_ask_name",
    });
  } catch (_e) { /* ignore */ }

  if (res.ok) {
    log.info({ to }, "crm_wa_ask_name: enviado");
    return { ok: true, outcome: "sent" };
  }
  log.warn({ status: res.status, to }, "crm_wa_ask_name: Wasender no OK");
  return { ok: false, outcome: "send_failed", httpStatus: res.status };
}

/**
 * Confirmación de registro: se envía tras recibir el nombre real en el flujo AWAITING_NAME.
 * Mensaje: "Gracias [NOMBRE], ya te hemos registrado. ¿En qué podemos ayudarte?"
 */
async function trySendCrmWaWelcomeNameConfirmation({ chatId, customerId, phoneRaw, confirmedName }) {
  if (!isCrmWelcomeFeatureEnabled()) {
    return { ok: false, outcome: "disabled" };
  }
  const cid = Number(chatId);
  const custId = Number(customerId);
  if (!Number.isFinite(cid) || cid <= 0 || !Number.isFinite(custId) || custId <= 0) {
    return { ok: false, outcome: "bad_args" };
  }
  if (!confirmedName || !String(confirmedName).trim()) {
    return { ok: false, outcome: "no_name" };
  }

  const cfg = await resolveWasenderRuntimeConfig();
  if (!cfg.enabled) {
    return { ok: false, outcome: "wasender_off" };
  }

  const to = normalizePhoneToE164(phoneRaw, cfg.defaultCountryCode);
  if (!to) {
    log.warn({ phoneRaw, chatId: cid }, "crm_welcome_confirm: teléfono no normalizable a E.164");
    return { ok: false, outcome: "bad_phone" };
  }

  const confirmTemplate =
    process.env.CRM_WA_WELCOME_NAME_CONFIRMED ||
    "Gracias {{nombre}}, ya te hemos registrado. ¿En qué podemos ayudarte?";
  const text = String(confirmTemplate).replace(/\{\{nombre\}\}/g, String(confirmedName).trim());

  const res = await sendWasenderTextMessage({
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    to,
    text,
  });

  const msgId =
    res.json && res.json.data && res.json.data.msgId != null ? Number(res.json.data.msgId) : null;
  const preview = text.slice(0, 200);

  let buyerId = null;
  try {
    const r = await pool.query(
      `SELECT primary_ml_buyer_id FROM customers WHERE id = $1`, [custId]
    );
    const v = r.rows[0]?.primary_ml_buyer_id;
    if (v != null && Number.isFinite(Number(v))) buyerId = Number(v);
  } catch (_e) { /* ignore */ }

  if (!res.ok) {
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
        tipo_e_activation_source: "crm_wa_welcome_confirm",
      });
    } catch (_e) { /* ignore */ }
    log.warn({ status: res.status, to }, "crm_welcome_confirm: Wasender no OK");
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
      tipo_e_activation_source: "crm_wa_welcome_confirm",
    });
  } catch (_e) { /* ignore */ }

  log.info({ chatId: cid, customerId: custId, confirmedName }, "crm_welcome_confirm: enviado");
  return { ok: true, outcome: "sent" };
}

module.exports = {
  trySendCrmWaWelcome,
  trySendCrmWaWelcomeAfterName,
  trySendCrmWaWelcomeNameConfirmation,
  trySendCrmWaAskName,
  isPlaceholderCustomerName,
  greetingNombreApellido,
  hasRealNameForGreeting,
};
