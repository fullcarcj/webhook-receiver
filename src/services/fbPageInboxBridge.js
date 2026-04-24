"use strict";

/**
 * Puente Facebook Messenger → crm_chats / crm_messages.
 * Mismo patrón que mlInboxBridge.js: SELECT + INSERT/UPDATE + omnichannelInboundHook.
 *
 * Teléfono sintético: "fb:<psid>" (sin UNIQUE real en phone para FB; el UNIQUE
 * real está en fb_psid vía uq_crm_chats_fb_psid).
 */

const pino = require("pino");
const { pool } = require("../../db");
const { applyInboundOmnichannelHook } = require("./omnichannelInboundHook");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "fb_inbox_bridge" });

function q(client) {
  return client && typeof client.query === "function" ? client : pool;
}

function parseTs(v) {
  if (v == null || String(v).trim() === "") return new Date();
  const d = new Date(typeof v === "number" ? v * 1000 : String(v));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Ingresa un mensaje entrante de Facebook Messenger al CRM.
 *
 * @param {{
 *   psid: string,           — Page-Scoped User ID (sender.id del webhook)
 *   pageId: string,         — recipient.id del webhook
 *   mid: string,            — message.mid (idempotencia)
 *   text: string,           — message.text (puede ser "")
 *   timestamp: number,      — Unix ms de Meta
 *   attachments?: object[], — message.attachments (opcional)
 * }} entry
 * @param {import('pg').PoolClient|null} [client]
 * @returns {Promise<{ chatId: number|null, isNew: boolean, skipped?: string }>}
 */
async function upsertFbMessageChat(entry, client) {
  const db = q(client);
  const { psid, mid, text = "", timestamp, attachments } = entry;

  if (!psid || !mid) {
    logger.warn({ entry }, "[fb_bridge] entrada inválida: falta psid o mid");
    return { chatId: null, isNew: false, skipped: "invalid_entry" };
  }

  const msgText = String(text || "").trim();
  const lastAt = parseTs(timestamp);
  const phone = `fb:${psid}`;

  // Determinar tipo de mensaje para preview
  let messageType = "text";
  if (!msgText && attachments && attachments.length) {
    const t = String((attachments[0] && attachments[0].type) || "").toLowerCase();
    if (t === "image") messageType = "image";
    else if (t === "audio") messageType = "audio";
    else if (t === "video") messageType = "video";
    else if (t === "file") messageType = "document";
    else if (t === "location") messageType = "location";
    else messageType = "document";
  }

  const previewText = msgText || "";

  // Contenido para crm_messages.content (JSONB)
  const contentObj =
    msgText
      ? { text: msgText }
      : { attachments: (attachments || []).map((a) => ({ type: a.type, url: a.payload?.url || null })) };

  // ── Buscar chat existente por fb_psid ──────────────────────────────────────
  const { rows: existing } = await db.query(
    `SELECT id FROM crm_chats WHERE fb_psid = $1 LIMIT 1`,
    [psid]
  );

  let chatId;
  let isNew = false;

  if (existing.length) {
    chatId = Number(existing[0].id);
    await db.query(
      `UPDATE crm_chats
       SET last_message_text = $2,
           last_message_at   = $3::timestamptz,
           last_message_type = $4,
           unread_count      = unread_count + 1,
           updated_at        = NOW()
       WHERE id = $1`,
      [chatId, msgText.slice(0, 500) || null, lastAt, messageType]
    );
  } else {
    isNew = true;
    const ins = await db.query(
      `INSERT INTO crm_chats (
         customer_id, phone, source_type, fb_psid,
         last_message_text, last_message_at, last_message_type,
         unread_count, identity_status, created_at, updated_at
       ) VALUES (
         NULL, $1, 'fb_page', $2,
         $3, $4::timestamptz, $5,
         1, 'unknown', NOW(), NOW()
       )
       ON CONFLICT (fb_psid) WHERE fb_psid IS NOT NULL
       DO UPDATE SET
         last_message_text = EXCLUDED.last_message_text,
         last_message_at   = EXCLUDED.last_message_at,
         last_message_type = EXCLUDED.last_message_type,
         unread_count      = crm_chats.unread_count + 1,
         updated_at        = NOW()
       RETURNING id`,
      [phone, psid, msgText.slice(0, 500) || null, lastAt, messageType]
    );
    chatId = Number(ins.rows[0].id);
  }

  // ── Insertar mensaje (idempotente por mid) ─────────────────────────────────
  const insMsg = await db.query(
    `INSERT INTO crm_messages (
       chat_id, external_message_id, direction, type, content,
       sent_by, is_read, created_at
     ) VALUES (
       $1, $2, 'inbound', $3, $4::jsonb,
       'buyer', false, $5::timestamptz
     )
     ON CONFLICT (external_message_id) DO NOTHING`,
    [chatId, `fb_${mid}`, messageType, JSON.stringify(contentObj), lastAt]
  );

  // ── SSE + reopen si attendido ──────────────────────────────────────────────
  if (insMsg.rowCount > 0) {
    await applyInboundOmnichannelHook(db, chatId, {
      sourceType: "fb_page",
      previewText,
      messageType,
    });
  }

  return { chatId, isNew };
}

/**
 * Registra un mensaje outbound (enviado por el agente) en crm_messages.
 * No llama a omnichannelInboundHook (es outbound).
 * @param {{ chatId: number, mid: string, text: string, sentBy?: string }} opts
 */
async function insertFbOutboundMessage(opts) {
  const { chatId, mid, text, sentBy = "agent" } = opts;
  try {
    await pool.query(
      `INSERT INTO crm_messages (
         chat_id, external_message_id, direction, type, content,
         sent_by, is_read, created_at
       ) VALUES (
         $1, $2, 'outbound', 'text', $3::jsonb,
         $4, true, NOW()
       )
       ON CONFLICT (external_message_id) DO NOTHING`,
      [chatId, mid ? `fb_out_${mid}` : null, JSON.stringify({ text }), sentBy]
    );
  } catch (e) {
    logger.error({ err: e, chatId }, "[fb_bridge] error al guardar outbound");
  }
}

module.exports = { upsertFbMessageChat, insertFbOutboundMessage };
