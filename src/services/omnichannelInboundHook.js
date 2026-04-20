"use strict";

const pino = require("pino");
const sseBroker = require("../realtime/sseBroker");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "omnichannel_inbound",
});

/**
 * Preview para SSE: media por tipo; texto truncado a 80 con "..." si hace falta.
 * @param {string} [messageType]
 * @param {string} [previewText]
 * @returns {string}
 */
function buildPreview(messageType, previewText) {
  const t = String(messageType || "text").toLowerCase();
  if (t === "image") return "[imagen]";
  if (t === "audio" || t === "voice") return "[audio]";
  if (t === "video") return "[video]";
  if (t === "document") return "[documento]";
  if (t === "location" || t === "locations") return "[ubicación]";
  if (t === "sticker") return "[sticker]";
  if (t === "contact" || t === "contacts") return "[contacto]";
  const txt = (previewText != null ? String(previewText) : "").trim();
  if (!txt) return "";
  return txt.length > 80 ? `${txt.slice(0, 77)}...` : txt;
}

/** Cache: ¿existe `crm_chats.channel_id` numérico en esta BD? */
let _crmChatsChannelIdColumnExists;

/**
 * @param {import('pg').Pool|import('pg').PoolClient} dbClient
 * @returns {Promise<boolean>}
 */
async function crmChatsHasNumericChannelIdColumn(dbClient) {
  if (_crmChatsChannelIdColumnExists !== undefined) {
    return _crmChatsChannelIdColumnExists;
  }
  try {
    const { rows } = await dbClient.query(
      `SELECT 1 AS ok
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'crm_chats'
         AND column_name = 'channel_id'
       LIMIT 1`
    );
    _crmChatsChannelIdColumnExists = rows.length > 0;
  } catch (_e) {
    _crmChatsChannelIdColumnExists = false;
  }
  return _crmChatsChannelIdColumnExists;
}

/**
 * @param {{ channelId?: unknown, numericChannelId?: unknown }} opts
 * @returns {number|null}
 */
function coalesceNumericChannelOverride(opts) {
  const raw = opts.channelId != null ? opts.channelId : opts.numericChannelId;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {import('pg').Pool|import('pg').PoolClient} dbClient
 * @param {number} chatId
 * @param {{
 *   sourceType?: string,
 *   channelId?: unknown,
 *   numericChannelId?: unknown,
 * }} opts
 * @returns {Promise<{ source_type: string, channel_id: number|null }>}
 */
async function resolvePayloadChannelMeta(dbClient, chatId, opts) {
  const cid = Number(chatId);
  const overrideSt =
    opts.sourceType != null && String(opts.sourceType).trim() !== ""
      ? String(opts.sourceType).trim()
      : null;

  const numericOverride = coalesceNumericChannelOverride(opts);

  const hasChatCh = await crmChatsHasNumericChannelIdColumn(dbClient);

  const selectChatCols = hasChatCh
    ? `cc.source_type, cc.channel_id AS crm_channel_id`
    : `cc.source_type, NULL::bigint AS crm_channel_id`;

  const { rows } = await dbClient.query(
    `SELECT ${selectChatCols},
            (
              SELECT so.channel_id
              FROM sales_orders so
              WHERE so.conversation_id = cc.id
              ORDER BY so.created_at DESC NULLS LAST
              LIMIT 1
            ) AS order_channel_id
     FROM crm_chats cc
     WHERE cc.id = $1`,
    [cid]
  );

  if (!rows.length) {
    return {
      source_type: overrideSt || "unknown",
      channel_id: numericOverride,
    };
  }

  const r = rows[0];
  const source_type =
    overrideSt ||
    (r.source_type != null ? String(r.source_type) : "unknown");

  let channel_id = numericOverride;
  if (channel_id == null && hasChatCh && r.crm_channel_id != null) {
    const n = Number(r.crm_channel_id);
    channel_id = Number.isFinite(n) ? n : null;
  }
  if (channel_id == null && r.order_channel_id != null) {
    const n = Number(r.order_channel_id);
    channel_id = Number.isFinite(n) ? n : null;
  }

  return { source_type, channel_id };
}

/**
 * @param {import('pg').Pool|import('pg').PoolClient} dbClient
 * @param {number|string} chatId
 * @param {{
 *   previewText?: string|null,
 *   messageType?: string,
 *   sourceType?: string,
 *   channelId?: unknown,
 *   numericChannelId?: unknown,
 * }} opts
 */
async function applyInboundOmnichannelHook(dbClient, chatId, opts) {
  try {
    const cid = Number(chatId);
    if (!Number.isFinite(cid) || cid <= 0) return;

    const preview = buildPreview(opts.messageType, opts.previewText);
    const { source_type, channel_id } = await resolvePayloadChannelMeta(
      dbClient,
      cid,
      {
        sourceType: opts.sourceType,
        channelId: opts.channelId,
        numericChannelId: opts.numericChannelId,
      }
    );

    const { rows } = await dbClient.query(`SELECT status FROM crm_chats WHERE id = $1`, [cid]);
    const status = rows[0] && rows[0].status != null ? String(rows[0].status) : "UNASSIGNED";

    const ssePayload = { chat_id: cid, source_type, channel_id, preview };

    if (status === "ATTENDED") {
      await dbClient.query(
        `UPDATE crm_chats
         SET status = 'RE_OPENED',
             last_inbound_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'ATTENDED'`,
        [cid]
      );
      sseBroker.broadcast("chat_reopened", ssePayload);
      sseBroker.broadcast("new_message", ssePayload);
      return;
    }

    await dbClient.query(
      `UPDATE crm_chats SET last_inbound_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [cid]
    );
    sseBroker.broadcast("new_message", ssePayload);
  } catch (e) {
    logger.error({ err: e }, "[omnichannel] inbound hook error");
  }
}

module.exports = { applyInboundOmnichannelHook };
