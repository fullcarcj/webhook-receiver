"use strict";

/**
 * Piloto: respuesta automática vía GROQ_LLAMA (callChatBasic).
 * Cola: crm_messages.ai_reply_status — procesada por aiResponderWorker (SKIP LOCKED).
 * Convención negocio: **Tipo M** — mensajes automáticos CRM bajo prompt interno
 * `prompt_ai_responder_pilot` (SYSTEM_PROMPT en este archivo). Ver `MESSAGE_TYPE_M` en ml-message-types.js.
 */

const pino = require("pino");
const { pool } = require("../../db");
const { callChatBasic } = require("./aiGateway");
const { emit } = require("./sseService");
const { MESSAGE_TYPE_M } = require("../../ml-message-types");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_responder" });

/** Prefijo en `ai_response_log.provider_used` para filtrar auditoría Tipo M. */
function providerAuditTipoM(gatewayId) {
  return `${MESSAGE_TYPE_M}|${gatewayId != null && String(gatewayId).trim() ? String(gatewayId).trim() : "n/a"}`;
}

function isEnabled() {
  return String(process.env.AI_RESPONDER_ENABLED || "").trim() === "1";
}

function confidenceMin() {
  const n = parseInt(String(process.env.AI_RESPONDER_CONFIDENCE_MIN || "85"), 10);
  return Number.isFinite(n) ? n : 85;
}

const SYSTEM_PROMPT = `Eres el asistente de Solomotor3k, empresa venezolana de repuestos automotrices en Valencia.
Tono: directo, amable, profesional. Español latinoamericano neutro (sin voseo).

REGLAS FASE 1:
1. Precios: indica que un asesor confirmará el precio pronto.
2. Compatibilidad técnica: indica que un técnico ayudará.
3. Comprobantes de pago: confirma recepción con los datos exactos dados.
4. NUNCA inventes precios, stock ni fechas de entrega.
5. Saludos simples: responde breve y cordial.
6. Si no estás seguro: needs_human true.

CONTEXTO CLIENTE:
{CUSTOMER_CONTEXT}

COMPROBANTE (si aplica):
{RECEIPT_CONTEXT}

HISTORIAL RECIENTE:
{CHAT_HISTORY}

Responde SOLO JSON válido sin markdown:
{"reply_text":"...","confidence":90,"reasoning":"...","needs_human":false}`;

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

function buildReceiptContext(receiptData) {
  if (!receiptData || typeof receiptData !== "object") return "Sin comprobante en este turno.";
  const r = receiptData;
  return [
    `Banco: ${r.bank_name ?? "—"}`,
    `Monto Bs: ${r.amount_bs ?? r.amount ?? "—"}`,
    `Referencia: ${r.reference_number ?? "—"}`,
    `Fecha: ${r.tx_date ?? "—"}`,
  ].join("\n");
}

async function generateResponse({ messageId, customerId, chatId, inputText, receiptData, status }) {
  const t0 = Date.now();
  const [customerCtx, chatHistory] = await Promise.all([
    buildCustomerContext(customerId),
    buildChatHistory(chatId),
  ]);

  let userMessage = inputText;
  if (status === "pending_receipt_confirm" && receiptData) {
    userMessage =
      "El cliente envió un comprobante de pago. Confirma recepción con estos datos exactos: " +
      JSON.stringify(receiptData);
  }

  const prompt = SYSTEM_PROMPT.replace("{CUSTOMER_CONTEXT}", customerCtx)
    .replace("{RECEIPT_CONTEXT}", buildReceiptContext(receiptData))
    .replace("{CHAT_HISTORY}", chatHistory);

  try {
    const raw = await callChatBasic({ systemPrompt: prompt, userMessage });
    if (!raw) throw new Error("Gateway vacío");

    let jsonText = raw.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) jsonText = fence[1].trim();

    const parsed = JSON.parse(jsonText);
    const confidence = parseInt(String(parsed.confidence ?? 0), 10);
    const minC = confidenceMin();
    const needsHuman =
      parsed.needs_human === true || !Number.isFinite(confidence) || confidence < minC;

    return {
      replyText: String(parsed.reply_text || "").trim() || null,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reasoning: String(parsed.reasoning || "").slice(0, 2000),
      needsHuman,
      provider: "GROQ_LLAMA",
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    log.error({ err: e.message, messageId }, "generateResponse falló");
    return {
      replyText: null,
      confidence: 0,
      reasoning: e.message || String(e),
      needsHuman: true,
      provider: "GROQ_LLAMA",
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Marca texto entrante para la cola IA (misma transacción que INSERT).
 */
async function maybeQueueInboundText(client, crmMessageId) {
  if (!isEnabled() || !crmMessageId) return;
  try {
    await client.query(
      `UPDATE crm_messages
       SET ai_reply_status = 'pending_ai_reply'
       WHERE id = $1
         AND direction = 'inbound'
         AND (ai_reply_status IS NULL)`,
      [crmMessageId]
    );
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
        row.reasoning ? String(row.reasoning).slice(0, 2000) : null,
        row.provider_used || null,
        row.tokens_used || 0,
        row.action_taken,
        row.error_message ? String(row.error_message).slice(0, 2000) : null,
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

async function sendAiReplyToCustomer({ phoneDigits, text, customerId }) {
  const { sendWasenderTextMessage } = require("../../wasender-client");
  const apiKey = process.env.WASENDER_API_KEY;
  const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
  if (!apiKey || !phoneDigits || !text) {
    return { ok: false, err: "missing_config_or_phone" };
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
    ai_reply_status: aiStatus,
  } = message;

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
      provider_used: null,
      tokens_used: 0,
      action_taken: "skipped_empty",
      error_message: null,
    });
    return;
  }

  const { rows: cust } = await pool.query(`SELECT phone FROM customers WHERE id = $1`, [customerId]);
  const phone = cust[0]?.phone;
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
      reasoning: "Sin teléfono en customers",
      provider_used: providerAuditTipoM("sin_gateway"),
      tokens_used: 0,
      action_taken: "skipped_inbound",
      error_message: null,
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

  if (result.needsHuman) {
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
    return;
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

  const errDetail =
    sendRes && sendRes.reason
      ? String(sendRes.reason)
      : sendRes && sendRes.bodyText
        ? String(sendRes.bodyText).slice(0, 500)
        : "send_failed";

  await pool.query(
    `UPDATE crm_messages
     SET ai_reply_status = 'needs_human_review',
         ai_reply_text = $1,
         ai_confidence = $2,
         ai_reasoning = $3,
         ai_provider = $4,
         ai_processed_at = NOW()
     WHERE id = $5`,
    [
      result.replyText,
      result.confidence,
      `Envío falló: ${errDetail}`,
      result.provider,
      messageId,
    ]
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
    reasoning: `Envío bloqueado o falló: ${errDetail}`,
  });
}

module.exports = {
  isEnabled,
  confidenceMin,
  maybeQueueInboundText,
  generateResponse,
  processOneMessage,
  sendAiReplyToCustomer,
  extractInboundText,
  logAiResponse,
  providerAuditTipoM,
};
