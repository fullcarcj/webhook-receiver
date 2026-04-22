"use strict";

/**
 * Piloto Tipo M: respuesta **siempre** desde plantilla (`AI_RESPONDER_GENERIC_TEMPLATE`) +
 * un solo fragmento contextual generado por IA (`context_line`). La IA **no elige flujo**
 * (needsHuman en false); la revisión **antes de Wasender** la define solo `AI_RESPONDER_FORCE_SEND`
 * (apagado = cola `needs_human_review` con sugerencia, sin POST Wasender hasta approve en el handler).
 * Cola: crm_messages.ai_reply_status — worker (SKIP LOCKED). Ver `MESSAGE_TYPE_M` en ml-message-types.js.
 */

const pino = require("pino");
const { pool } = require("../../db");
const { callChatBasic } = require("./aiGateway");
const { emit } = require("./sseService");
const { MESSAGE_TYPE_M } = require("../../ml-message-types");
const handoffGuard = require("../middleware/handoffGuard");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_responder" });

/** Prefijo en `ai_response_log.provider_used` para filtrar auditoría Tipo M. */
function providerAuditTipoM(gatewayId) {
  return `${MESSAGE_TYPE_M}|${gatewayId != null && String(gatewayId).trim() ? String(gatewayId).trim() : "n/a"}`;
}

/**
 * Callback registrado por el worker para disparar un ciclo inmediato.
 * Evita la dependencia circular aiResponder ↔ aiResponderWorker.
 */
let _immediateTrigger = null;

/** Registrar la función que dispara un ciclo del worker sin esperar el próximo intervalo. */
function setImmediateTrigger(fn) {
  _immediateTrigger = typeof fn === "function" ? fn : null;
}

/** Disparar el worker ahora mismo (si está registrado). Seguro llamarlo varias veces. */
function triggerResponderNow() {
  if (_immediateTrigger) {
    setImmediate(() => {
      _immediateTrigger().catch(() => {});
    });
  }
}

/**
 * Suspende el piloto Tipo M sin borrar AI_RESPONDER_ENABLED=1 (útil en Render: un solo flag).
 * ON: 1, true, yes, on (case-insensitive). OFF: 0, false, no, off, vacío.
 */
function isSuspended() {
  const v = String(process.env.AI_RESPONDER_SUSPENDED ?? "").trim().toLowerCase();
  if (!v) return false;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return ["1", "true", "yes", "on"].includes(v);
}

function isEnabled() {
  if (isSuspended()) return false;
  return String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1";
}

// DEPRECATED 2026-04: AI_RESPONDER_CONFIDENCE_MIN no gobierna el flujo; el gate real es
// AI_RESPONDER_FORCE_SEND (isHumanReviewGateOn). Mantenido solo por compatibilidad si alguna
// env externa lo setea. No consumir en FE.
function confidenceMin() {
  const n = parseInt(String(process.env.AI_RESPONDER_CONFIDENCE_MIN || "85"), 10);
  return Number.isFinite(n) ? n : 85;
}

/**
 * Switch `AI_RESPONDER_FORCE_SEND`: revisión humana **apagada** (auto-envío si hay texto).
 * ON (sin revisión): 1, true, yes, on (case-insensitive).
 * OFF (con revisión): 0, false, no, off, vacío o cualquier otro valor.
 */
function isForceSend() {
  const v = String(process.env.AI_RESPONDER_FORCE_SEND ?? "").trim().toLowerCase();
  if (!v) return false;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return ["1", "true", "yes", "on"].includes(v);
}

/** true = el operador debe aprobar antes de enviar (switch FORCE apagado). */
function isHumanReviewGateOn() {
  return !isForceSend();
}

/** Respuesta fija negocio; placeholders: {{CONTEXTO_IA}}, {{NOMBRE}} (opcional). */
function defaultGenericTemplate() {
  const env = process.env.AI_RESPONDER_GENERIC_TEMPLATE;
  if (env != null && String(env).trim() !== "") return String(env).trim();
  return (
    "Hola{{NOMBRE_SALUDO}}. Recibimos tu mensaje sobre {{CONTEXTO_IA}}. " +
    "Mañana en horario comercial un asesor te atenderá con gusto. Gracias por escribirnos."
  );
}

/** Solo genera una línea breve que resume o reconoce la consulta; no decide envíos ni ramas. */
const PROMPT_CONTEXT_LINE = `Eres un asistente de redacción para Solomotor3k (repuestos automotrices, Valencia).
Tu única tarea: escribir UNA frase corta (máximo 120 caracteres) en español latinoamericano neutro, sin voseo,
que reconozca de forma genérica el tema de la consulta del cliente (sin inventar precios, stock, fechas ni datos bancarios).

No hagas preguntas de seguimiento. No ofrezcas resolver el caso ahora.

CONTEXTO CLIENTE (referencia):
{CUSTOMER_CONTEXT}

HISTORIAL RECIENTE (referencia):
{CHAT_HISTORY}

MENSAJE O TEMA DEL CLIENTE (principal):
---
{USER_MESSAGE}
---

Responde SOLO JSON válido sin markdown:
{"context_line":"..."}`;

function applyTipoMTemplate(template, { contextLine, nombre }) {
  const nom = String(nombre || "").trim().slice(0, 80);
  const cl = String(contextLine || "tu consulta").trim().slice(0, 200);
  let t = String(template || defaultGenericTemplate());
  const nombreSaludo = nom ? `, ${nom.split(/\s+/)[0]}` : "";
  t = t.replace(/\{\{NOMBRE_SALUDO\}\}/g, nombreSaludo);
  t = t.replace(/\{\{NOMBRE\}\}/g, nom || "Cliente");
  t = t.replace(/\{\{CONTEXTO_IA\}\}/g, cl);
  return t.trim().slice(0, 4000);
}

async function getCustomerFirstName(customerId) {
  if (!customerId) return "";
  try {
    const { rows } = await pool.query(
      `SELECT NULLIF(TRIM(SPLIT_PART(COALESCE(full_name, ''), ' ', 1)), '') AS n FROM customers WHERE id = $1`,
      [customerId]
    );
    return rows[0]?.n ? String(rows[0].n) : "";
  } catch (_) {
    return "";
  }
}

function extractInboundText(row) {
  const c = row.content;
  let obj = c;
  if (typeof c === "string") {
    try {
      obj = JSON.parse(c);
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== "object") obj = {};
  const fromJson =
    row.transcription ||
    obj.transcription ||
    obj.text ||
    (typeof obj.conversation === "string" ? obj.conversation : null);
  return String(fromJson || "").trim();
}

async function buildCustomerContext(customerId) {
  if (!customerId) return "Cliente no identificado en CRM.";
  try {
    const { rows } = await pool.query(
      `SELECT c.full_name, c.client_segment, c.wa_is_business, c.wa_verified_name
       FROM customers c WHERE c.id = $1 LIMIT 1`,
      [customerId]
    );
    if (!rows.length) return "Cliente no encontrado.";
    const c = rows[0];
    const parts = [`Nombre: ${c.full_name || "—"}`];
    if (c.wa_is_business && c.wa_verified_name) parts.push(`Empresa WA: ${c.wa_verified_name}`);
    if (c.client_segment) parts.push(`Segmento: ${c.client_segment}`);
    return parts.join("\n");
  } catch (e) {
    return `Error contexto: ${e.message}`;
  }
}

async function buildChatHistory(chatId) {
  if (!chatId) return "Sin historial.";
  try {
    const { rows } = await pool.query(
      `SELECT direction,
              COALESCE(transcription, content->>'transcription', content->>'text', '') AS txt,
              type
       FROM crm_messages
       WHERE chat_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 8`,
      [chatId]
    );
    if (!rows.length) return "Primera interacción reciente.";
    return rows
      .reverse()
      .map((m) => {
        const who = m.direction === "inbound" ? "Cliente" : "Local";
        const t = String(m.txt || "").slice(0, 220) || `[${m.type}]`;
        return `${who}: ${t}`;
      })
      .join("\n");
  } catch (e) {
    return `Error historial: ${e.message}`;
  }
}

async function generateResponse({ messageId, customerId, chatId, inputText, receiptData, status }) {
  const t0 = Date.now();
  const [customerCtx, chatHistory, nombre] = await Promise.all([
    buildCustomerContext(customerId),
    buildChatHistory(chatId),
    getCustomerFirstName(customerId),
  ]);

  let userMessage = String(inputText || "").trim();
  if (status === "pending_receipt_confirm" && receiptData && typeof receiptData === "object") {
    userMessage =
      "Comprobante de pago (solo referencia, sin inventar datos): " +
      JSON.stringify({
        reference_number: receiptData.reference_number,
        amount_bs: receiptData.amount_bs,
        tx_date: receiptData.tx_date,
        bank_name: receiptData.bank_name,
      });
  }

  const sys = PROMPT_CONTEXT_LINE.replace("{CUSTOMER_CONTEXT}", customerCtx)
    .replace("{CHAT_HISTORY}", chatHistory)
    .replace("{USER_MESSAGE}", userMessage || "(vacío)");

  let contextLine = "";
  let groqContextError = "";
  try {
    const raw = await callChatBasic({
      systemPrompt: sys,
      userMessage: "Genera solo el JSON con context_line.",
    });
    if (raw) {
      let jsonText = raw.trim();
      const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence && fence[1]) jsonText = fence[1].trim();
      const parsed = JSON.parse(jsonText);
      contextLine = String(parsed.context_line || "").trim();
    }
  } catch (e) {
    groqContextError = String(e && e.message ? e.message : e).slice(0, 400);
    log.warn({ err: groqContextError, messageId }, "tipo_m: context_line falló, usando fallback");
  }

  if (!contextLine) {
    contextLine =
      String(userMessage || "")
        .replace(/^\s*Comprobante de pago[^\n]*\n?/i, "")
        .slice(0, 120)
        .replace(/\s+/g, " ")
        .trim() || "tu consulta";
  }

  const template = defaultGenericTemplate();
  const replyText = applyTipoMTemplate(template, { contextLine, nombre });

  const groqNote = groqContextError
    ? ` [origen=GROQ_LLAMA: context_line no generado — ${groqContextError}]`
    : "";
  return {
    replyText: replyText || null,
    confidence: 100,
    reasoning: `tipo_m_plantilla prompt_ai_responder_pilot ctx=${contextLine.slice(0, 100)}${groqNote}`,
    needsHuman: false,
    provider: "GROQ_LLAMA",
    latencyMs: Date.now() - t0,
  };
}

/**
 * Marca texto entrante para la cola IA (misma transacción que INSERT).
 * Tras marcar el mensaje, dispara el worker inmediatamente para evitar el delay
 * del intervalo de polling (hasta AI_RESPONDER_INTERVAL_MS, default 8 s).
 * El setImmediate garantiza que el COMMIT de la transacción ya se completó
 * antes de que el worker intente reclamar la fila.
 */
async function maybeQueueInboundText(client, crmMessageId) {
  if (!isEnabled() || !crmMessageId) return;
  try {
    const r = await client.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'pending_ai_reply'
       WHERE id = $1
         AND direction = 'inbound'
         AND (ai_reply_status IS NULL)`,
      [crmMessageId]
    );
    if (r.rowCount > 0) {
      triggerResponderNow();
    }
  } catch (e) {
    if (e && e.code === "42703") return;
    log.warn({ err: e.message, crmMessageId }, "maybeQueueInboundText");
  }
}

async function logAiResponse(poolOrClient, row) {
  const c = poolOrClient;
  try {
    await c.query(
      `INSERT INTO ai_response_log
        (crm_message_id, customer_id, chat_id, input_text, receipt_data,
         reply_text, confidence, reasoning, provider_used, tokens_used, action_taken, error_message)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.crm_message_id,
        row.customer_id,
        row.chat_id,
        row.input_text ? String(row.input_text).slice(0, 4000) : null,
        row.receipt_data ? JSON.stringify(row.receipt_data) : null,
        row.reply_text ? String(row.reply_text).slice(0, 8000) : null,
        row.confidence,
        row.reasoning ? String(row.reasoning).slice(0, 12000) : null,
        row.provider_used || null,
        row.tokens_used || 0,
        row.action_taken,
        row.error_message ? String(row.error_message).slice(0, MAX_AI_RESPONSE_ERROR_CHARS) : null,
      ]
    );
  } catch (e) {
    if (e && e.code === "42P01") return;
    log.warn({ err: e.message }, "ai_response_log insert falló");
  }
}

function notifyHumanReview(payload) {
  try {
    emit("ai_needs_human_review", payload);
  } catch (_) {}
}

/** Tamaño máximo guardado en `ai_response_log.error_message` (TEXT en Postgres). */
const MAX_AI_RESPONSE_ERROR_CHARS = 11000;

/**
 * Texto multilínea para auditoría: indica si el fallo fue antes del POST (app), en Wasender (HTTP/API) o config.
 * @param {object|null} sendRes — retorno de `sendWasenderTextMessage` o objeto corto de `sendAiReplyToCustomer`
 */
function formatTipoMOutboundError(sendRes) {
  if (!sendRes || typeof sendRes !== "object") {
    return "[origen=DESCONOCIDO]\nSin objeto de respuesta tras intento de envío.";
  }
  if (sendRes.err === "missing_wasender_api_key") {
    return "[origen=APP_CONFIG]\nWASENDER_API_KEY no definida — no se llamó a la API Wasender.";
  }
  if (sendRes.err === "missing_phone_digits") {
    return "[origen=APP_DATOS]\nSin teléfono destino (crm_chats.phone vacío o inválido) — no se llamó a Wasender.";
  }
  if (sendRes.err === "missing_reply_text") {
    return "[origen=APP_LOGIC]\nTexto de respuesta vacío — no se llamó a Wasender.";
  }
  const lines = ["[origen=WASENDER_API]"];
  if (sendRes.quiet_hours === true) {
    lines.push("bloqueo_previo=ventana_silenciosa (waQuietHours; sin POST a Wasender)");
  } else if (sendRes.throttled === true) {
    lines.push(
      `bloqueo_previo=tope_diario_envios count=${sendRes.throttle_count ?? "?"} cap=${sendRes.throttle_cap ?? "?"}`
    );
  } else if (sendRes.status === "blocked" || sendRes.reason) {
    lines.push(
      `bloqueo_previo=politica_antispam_interna reason=${String(sendRes.reason || sendRes.status || "?")} (previo al POST)`
    );
  }
  lines.push(`http_status=${sendRes.status != null ? sendRes.status : "?"}`);
  const j = sendRes.json;
  if (j && typeof j === "object") {
    if (j.success != null) lines.push(`json.success=${j.success}`);
    if (j.message != null) lines.push(`json.message=${String(j.message)}`);
    if (j.retry_after != null) lines.push(`json.retry_after=${j.retry_after}`);
    if (j.help != null) lines.push(`json.help=${String(j.help)}`);
    if (j.error != null) {
      lines.push(`json.error=${typeof j.error === "string" ? j.error : JSON.stringify(j.error)}`);
    }
    try {
      const full = JSON.stringify(j);
      if (full.length < 8000) lines.push(`json.completo=${full}`);
    } catch (_) {
      /* ignore */
    }
  }
  const raw = sendRes.bodyText != null ? String(sendRes.bodyText).trim() : "";
  if (raw) lines.push(`body_raw=${raw.slice(0, 7000)}`);
  if (
    lines.length === 1 &&
    !raw &&
    sendRes.quiet_hours !== true &&
    sendRes.throttled !== true &&
    sendRes.status !== "blocked"
  ) {
    lines.push("nota=sin body_raw útil; revisar http_status y logs del proceso.");
  }
  return lines.join("\n").slice(0, MAX_AI_RESPONSE_ERROR_CHARS);
}

async function sendAiReplyToCustomer({ phoneDigits, text, customerId }) {
  const { sendWasenderTextMessage } = require("../../wasender-client");
  const apiKey = process.env.WASENDER_API_KEY;
  const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
  if (!apiKey) {
    return { ok: false, status: 0, json: null, bodyText: "", err: "missing_wasender_api_key" };
  }
  if (!phoneDigits) {
    return { ok: false, status: 0, json: null, bodyText: "", err: "missing_phone_digits" };
  }
  if (!text) {
    return { ok: false, status: 0, json: null, bodyText: "", err: "missing_reply_text" };
  }
  const to = String(phoneDigits).startsWith("+") ? String(phoneDigits) : `+${String(phoneDigits).replace(/\D/g, "")}`;
  return sendWasenderTextMessage({
    apiKey,
    apiBaseUrl,
    to,
    text: String(text).slice(0, 4000),
    messageType: "CHAT",
    customerId: customerId != null ? Number(customerId) : undefined,
  });
}

async function processOneMessage(message) {
  const {
    id: messageId,
    customer_id: customerId,
    chat_id: chatId,
    content,
    transcription,
    receipt_data: receiptDataRaw,
  } = message;

  // Guard: si un vendedor tomó el control del chat, no responder automáticamente.
  // bot_actions registra 'handoff_triggered' con contexto completo (fire-and-forget).
  const skipByHandoff = await handoffGuard.shouldSkipBotReply({
    chatId,
    correlationId: String(messageId),
  });
  if (skipByHandoff) {
    await pool.query(
      `UPDATE crm_messages SET ai_reply_status = 'skipped', ai_processed_at = NOW() WHERE id = $1`,
      [messageId]
    );
    return;
  }

  const rowContent = content;
  let inputText = extractInboundText({ content: rowContent, transcription });

  let rdParsed = receiptDataRaw;
  if (rdParsed && typeof rdParsed === "string") {
    try {
      rdParsed = JSON.parse(rdParsed);
    } catch {
      rdParsed = null;
    }
  }
  const isReceiptQueue =
    rdParsed &&
    typeof rdParsed === "object" &&
    (rdParsed.amount_bs != null || rdParsed.reference_number != null);
  const statusForGen = isReceiptQueue ? "pending_receipt_confirm" : "pending_ai_reply";

  if (statusForGen === "pending_receipt_confirm") {
    if (rdParsed && typeof rdParsed === "object") {
      inputText =
        "Comprobante recibido. Datos: " +
        JSON.stringify({
          reference_number: rdParsed.reference_number,
          amount_bs: rdParsed.amount_bs,
          tx_date: rdParsed.tx_date,
          bank_name: rdParsed.bank_name,
          payment_type: rdParsed.payment_type,
        });
    }
  }

  if (!inputText) {
    await pool.query(
      `UPDATE crm_messages SET ai_reply_status = 'skipped', ai_processed_at = NOW() WHERE id = $1`,
      [messageId]
    );
    await logAiResponse(pool, {
      crm_message_id: messageId,
      customer_id: customerId,
      chat_id: chatId,
      input_text: null,
      receipt_data: receiptDataRaw,
      reply_text: null,
      confidence: null,
      reasoning: "Sin texto ni transcripción",
      provider_used: providerAuditTipoM("sin_gateway"),
      tokens_used: 0,
      action_taken: "skipped_empty",
      error_message: null,
    });
    return;
  }

  // Tipo M: el teléfono viene del chat, no de customers. crm_chats.phone es la fuente canónica.
  const { rows: chatRow } = await pool.query(`SELECT phone FROM crm_chats WHERE id = $1`, [chatId]);
  const phone = chatRow[0]?.phone || null;
  if (!phone) {
    await pool.query(
      `UPDATE crm_messages SET ai_reply_status = 'skipped', ai_processed_at = NOW() WHERE id = $1`,
      [messageId]
    );
    await logAiResponse(pool, {
      crm_message_id: messageId,
      customer_id: customerId,
      chat_id: chatId,
      input_text: inputText,
      receipt_data: receiptDataRaw,
      reply_text: null,
      confidence: null,
      reasoning: "Sin teléfono en crm_chats (no se intentó Wasender ni GROQ de envío)",
      provider_used: providerAuditTipoM("sin_gateway"),
      tokens_used: 0,
      action_taken: "skipped_inbound",
      error_message: formatTipoMOutboundError({
        ok: false,
        status: 0,
        json: null,
        bodyText: "",
        err: "missing_phone_digits",
      }),
    });
    return;
  }

  const result = await generateResponse({
    messageId,
    customerId,
    chatId,
    inputText,
    receiptData: rdParsed,
    status: statusForGen,
  });

  const rdForLog =
    receiptDataRaw && typeof receiptDataRaw === "object"
      ? receiptDataRaw
      : typeof receiptDataRaw === "string"
        ? (() => {
            try {
              return JSON.parse(receiptDataRaw);
            } catch {
              return null;
            }
          })()
        : null;

  if (!result.replyText) {
    if (!isForceSend()) {
      await pool.query(
        `UPDATE crm_messages
         SET ai_reply_status = 'needs_human_review',
             ai_reasoning = $1,
             ai_confidence = $2,
             ai_processed_at = NOW()
         WHERE id = $3`,
        [result.reasoning, result.confidence, messageId]
      );
      await logAiResponse(pool, {
        crm_message_id: messageId,
        customer_id: customerId,
        chat_id: chatId,
        input_text: inputText,
        receipt_data: rdForLog,
        reply_text: null,
        confidence: result.confidence,
        reasoning: result.reasoning,
        provider_used: providerAuditTipoM(result.provider),
        tokens_used: 0,
        action_taken: "queued_review",
        error_message: null,
      });
      notifyHumanReview({
        message_id: messageId,
        customer_id: customerId,
        chat_id: chatId,
        input_preview: inputText.slice(0, 160),
        suggested_reply: null,
        confidence: result.confidence,
        reasoning: result.reasoning,
      });
      return;
    }
    log.warn({ messageId }, "ai_responder: AI_RESPONDER_FORCE_SEND=1 — sin reply_text, omite needs_human_review");
    await pool.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'skipped',
           ai_reasoning = $1,
           ai_confidence = $2,
           ai_processed_at = NOW()
       WHERE id = $3`,
      [
        `${String(result.reasoning || "").slice(0, 400)} [FORCE_SEND: sin texto para enviar]`,
        result.confidence,
        messageId,
      ]
    );
    await logAiResponse(pool, {
      crm_message_id: messageId,
      customer_id: customerId,
      chat_id: chatId,
      input_text: inputText,
      receipt_data: rdForLog,
      reply_text: null,
      confidence: result.confidence,
      reasoning: result.reasoning,
      provider_used: providerAuditTipoM(result.provider),
      tokens_used: 0,
      action_taken: "skipped_empty",
      error_message: "ai_responder_force_send_no_reply_text",
    });
    return;
  }

  // Tipo M: `needsHuman` suele ir en false; la cola previa a Wasender la gobierna **solo** `AI_RESPONDER_FORCE_SEND`.
  if (isHumanReviewGateOn()) {
    await pool.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'needs_human_review',
           ai_reply_text = $1,
           ai_confidence = $2,
           ai_reasoning = $3,
           ai_provider = $4,
           ai_processed_at = NOW()
       WHERE id = $5`,
      [result.replyText, result.confidence, result.reasoning, result.provider, messageId]
    );
    await logAiResponse(pool, {
      crm_message_id: messageId,
      customer_id: customerId,
      chat_id: chatId,
      input_text: inputText,
      receipt_data: rdForLog,
      reply_text: result.replyText,
      confidence: result.confidence,
      reasoning: result.reasoning,
      provider_used: providerAuditTipoM(result.provider),
      tokens_used: 0,
      action_taken: "queued_review",
      error_message: null,
    });
    notifyHumanReview({
      message_id: messageId,
      customer_id: customerId,
      chat_id: chatId,
      input_preview: inputText.slice(0, 160),
      suggested_reply: result.replyText,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
    log.info(
      { messageId },
      "ai_responder: revisión humana ON (FORCE apagado) — sugerencia guardada, sin envío Wasender hasta approve"
    );
    return;
  }

  if (result.needsHuman && isForceSend()) {
    log.warn(
      { messageId, confidence: result.confidence },
      "ai_responder: FORCE_SEND switch ON — omite cola revisión humana (needsHuman), envío directo"
    );
  }

  const { rows: alreadySent } = await pool.query(
    `SELECT id FROM crm_messages WHERE id = $1 AND ai_reply_status = 'ai_replied'`,
    [messageId]
  );
  if (alreadySent.length) {
    log.warn({ messageId }, "ai_responder: mensaje ya enviado — skip anti-spam");
    return;
  }

  const sendRes = await sendAiReplyToCustomer({
    phoneDigits: phone,
    text: result.replyText,
    customerId,
  });

  if (sendRes && sendRes.ok) {
    await pool.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'ai_replied',
           ai_reply_text = $1,
           ai_confidence = $2,
           ai_reasoning = $3,
           ai_provider = $4,
           ai_processed_at = NOW()
       WHERE id = $5`,
      [result.replyText, result.confidence, result.reasoning, result.provider, messageId]
    );
    await logAiResponse(pool, {
      crm_message_id: messageId,
      customer_id: customerId,
      chat_id: chatId,
      input_text: inputText,
      receipt_data: rdForLog,
      reply_text: result.replyText,
      confidence: result.confidence,
      reasoning: result.reasoning,
      provider_used: providerAuditTipoM(result.provider),
      tokens_used: 0,
      action_taken: "sent",
      error_message: null,
    });
    log.info(
      { messageId, confidence: result.confidence, message_kind: "M", prompt: "prompt_ai_responder_pilot" },
      "ai_responder: mensaje procesado tipo M"
    );
    return;
  }

  // AI_RESPONDER_FORCE_SEND solo omite la cola *antes* de enviar (needsHuman / sin reply_text).
  // Si Wasender rechaza o falla el POST, igual marcamos needs_human_review para reintento manual
  // y queda action_taken=error en ai_response_log (no es "revisión" previa a la IA).
  const errDetail = formatTipoMOutboundError(sendRes);
  const reasoningShort = `Envío falló (ver error_message en log). ${String(errDetail).split("\n")[0]}`.slice(0, 500);

  await pool.query(
    `UPDATE crm_messages
     SET ai_reply_status = 'needs_human_review',
         ai_reply_text = $1,
         ai_confidence = $2,
         ai_reasoning = $3,
         ai_provider = $4,
         ai_processed_at = NOW()
     WHERE id = $5`,
    [result.replyText, result.confidence, reasoningShort, result.provider, messageId]
  );
  await logAiResponse(pool, {
    crm_message_id: messageId,
    customer_id: customerId,
    chat_id: chatId,
    input_text: inputText,
    receipt_data: rdForLog,
    reply_text: result.replyText,
    confidence: result.confidence,
    reasoning: result.reasoning,
    provider_used: providerAuditTipoM(result.provider),
    tokens_used: 0,
    action_taken: "error",
    error_message: errDetail,
  });
  notifyHumanReview({
    message_id: messageId,
    customer_id: customerId,
    chat_id: chatId,
    input_preview: inputText.slice(0, 160),
    suggested_reply: result.replyText,
    confidence: result.confidence,
    reasoning: `Envío bloqueado o falló. ${reasoningShort}`,
  });
}

module.exports = {
  isEnabled,
  isSuspended,
  confidenceMin,
  isForceSend,
  isHumanReviewGateOn,
  setImmediateTrigger,
  triggerResponderNow,
  maybeQueueInboundText,
  generateResponse,
  processOneMessage,
  sendAiReplyToCustomer,
  extractInboundText,
  logAiResponse,
  providerAuditTipoM,
};
