"use strict";

/**
 * Envío de texto CRM → Wasender + persistencia en crm_messages (outbound).
 * Wasender se ejecuta FUERA de cualquier transacción del caller; aquí se usan
 * queries auto-commit para INSERT/UPDATE tras un envío OK.
 */

const crypto = require("crypto");
const { pool } = require("../../db");
const { sendWasenderTextMessage } = require("../../wasender-client");
const { normalizePhoneToE164 } = require("../../ml-whatsapp-phone");
const { applyOutboundOmnichannelHook } = require("./omnichannelOutboundHook");

function resolveWasenderConfig() {
  const apiKey =
    process.env.WASENDER_API_KEY != null ? String(process.env.WASENDER_API_KEY).trim() : "";
  const apiBaseUrl = (
    process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com"
  ).replace(/\/$/, "");
  return { apiKey, apiBaseUrl };
}

function extractWasenderMsgId(res) {
  if (!res || !res.json || !res.json.data) return null;
  const d = res.json.data;
  if (d.msgId != null) return String(d.msgId);
  if (d.message_id != null) return String(d.message_id);
  if (d.id != null) return String(d.id);
  return null;
}

/**
 * @param {number|string} chatId
 * @param {string} text
 * @param {string|null|undefined} sentBy — texto libre (usuario / sistema)
 * @returns {Promise<{ messageId: string, ok: boolean }>}
 */
async function sendChatMessage(chatId, text, sentBy) {
  const cid = Number(chatId);
  if (!Number.isFinite(cid) || cid <= 0) {
    const e = new Error("invalid_chat_id");
    e.code = "BAD_REQUEST";
    throw e;
  }
  const body = text != null ? String(text) : "";
  if (!body.trim()) {
    const e = new Error("text_required");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { rows } = await pool.query(
    `SELECT phone, customer_id FROM crm_chats WHERE id = $1`,
    [cid]
  );
  if (!rows.length) {
    const e = new Error("chat_not_found");
    e.code = "NOT_FOUND";
    throw e;
  }
  const phoneRaw = rows[0].phone;
  const customerId =
    rows[0].customer_id != null && Number.isFinite(Number(rows[0].customer_id))
      ? Number(rows[0].customer_id)
      : undefined;

  const to = normalizePhoneToE164(phoneRaw);
  if (!to) {
    const e = new Error("invalid_phone");
    e.code = "BAD_REQUEST";
    throw e;
  }

  const { apiKey, apiBaseUrl } = resolveWasenderConfig();
  if (!apiKey) {
    const e = new Error("wasender_not_configured");
    e.code = "SERVICE_UNAVAILABLE";
    throw e;
  }

  const res = await sendWasenderTextMessage({
    apiBaseUrl,
    apiKey,
    to,
    text: body,
    messageType: "CHAT",
    customerId,
  });

  if (!res.ok) {
    const e = new Error(
      res.reason ? `wasender_blocked:${res.reason}` : `wasender_failed:${res.status}`
    );
    e.code = "WASENDER_ERROR";
    e.httpStatus = typeof res.status === "number" ? res.status : 502;
    throw e;
  }

  const extId =
    extractWasenderMsgId(res) || `out-${crypto.randomUUID()}`;
  const sentByStr =
    sentBy != null && String(sentBy).trim() !== "" ? String(sentBy).trim() : "api";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO crm_messages (
         chat_id, customer_id, direction, type,
         content, sent_by, external_message_id, is_read, ai_reply_status
       ) VALUES (
         $1,
         $2,
         'outbound',
         'text',
         $3::jsonb,
         $4,
         $5,
         TRUE,
         NULL
       )
       ON CONFLICT (external_message_id) DO NOTHING`,
      [
        cid,
        customerId != null ? customerId : null,
        JSON.stringify({ text: body }),
        sentByStr,
        extId,
      ]
    );

    await client.query(
      `UPDATE crm_chats SET
         last_message_text = $1,
         last_message_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`,
      [body.slice(0, 5000), cid]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await applyOutboundOmnichannelHook(pool, cid);

  return { messageId: extId, ok: true };
}

module.exports = { sendChatMessage };
