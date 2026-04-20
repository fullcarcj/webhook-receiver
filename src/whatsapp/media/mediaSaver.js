"use strict";

const pino = require("pino");
const { pool } = require("../../../db");
const { applyInboundOmnichannelHook } = require("../../services/omnichannelInboundHook");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "mediaSaver" });

const PREVIEW_LABEL = {
  image:    "📷 Imagen",
  video:    "📹 Video",
  document: "📄 Documento",
  sticker:  "😀 Sticker",
};

function buildPreview(mediaType, ptt) {
  if (mediaType === "audio") return ptt ? "🎤 Nota de voz" : "🎵 Audio";
  return PREVIEW_LABEL[mediaType] || mediaType;
}

/**
 * Persiste un media entrante en crm_messages y actualiza crm_chats.
 */
async function saveInboundMedia({
  chatId, customerId, messageId,
  mediaType, firebaseUrl, mimetype,
  meta, transcription, transcriptionError,
}) {
  const preview  = buildPreview(mediaType, meta.ptt);
  const lastText = meta.caption?.substring(0, 80)
    ?? transcription?.substring(0, 80)
    ?? (transcriptionError ? `⚠ ${String(transcriptionError).substring(0, 70)}` : preview);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO crm_messages
         (chat_id, customer_id, external_message_id,
          direction, type, content, is_priority, created_at)
       VALUES ($1, $2, $3, 'inbound', $4, $5::jsonb, FALSE, NOW())
       ON CONFLICT (external_message_id) DO NOTHING
       RETURNING id`,
      [
        chatId, customerId, messageId, mediaType,
        JSON.stringify({
          mediaUrl:             firebaseUrl,
          mimeType:             mimetype,
          caption:              meta.caption    ?? null,
          fileSize:             meta.fileLength ?? 0,
          fileName:             meta.fileName   ?? null,
          is_voice_note:        meta.ptt        ?? false,
          duration_sec:         meta.seconds    ?? meta.duration ?? 0,
          page_count:           meta.pageCount  ?? null,
          transcription:        transcription   ?? null,
          transcription_error:  transcriptionError ?? null,
        }),
      ]
    );
    let savedMessageId = ins.rows[0]?.id ?? null;
    if (!savedMessageId) {
      const ex = await client.query(
        `SELECT id FROM crm_messages WHERE external_message_id = $1 LIMIT 1`,
        [messageId]
      );
      savedMessageId = ex.rows[0]?.id ?? null;
    }

    // Si tiene caption, guardar también como mensaje de texto plano
    if (meta.caption?.trim()) {
      await client.query(
        `INSERT INTO crm_messages
           (chat_id, customer_id, direction, type, content, created_at)
         VALUES ($1, $2, 'inbound', 'text', $3::jsonb, NOW())`,
        [chatId, customerId, JSON.stringify({ text: meta.caption })]
      );
    }

    await client.query(
      `UPDATE crm_chats
       SET last_message_text = $1,
           last_message_type = $2,
           last_message_at   = NOW(),
           unread_count      = unread_count + 1,
           updated_at        = NOW()
       WHERE id = $3`,
      [lastText, mediaType, chatId]
    );

    // Bloque 1 · Motor omnicanal — inbound (omnichannelInboundHook); mismo client que esta transacción.
    if (ins.rows.length) {
      await applyInboundOmnichannelHook(client, chatId, {
        sourceType: "wa_inbound",
        previewText: null,
        messageType: mediaType,
      });
    }

    await client.query("COMMIT");
    log.info(
      {
        chatId,
        messageId,
        mediaType,
        crmMessageId: savedMessageId,
        hasTranscription: !!transcription,
        hasTranscriptionError: !!transcriptionError,
      },
      "Media entrante guardado"
    );
    return { id: savedMessageId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Persiste un media saliente en crm_messages.
 */
async function saveOutboundMedia({
  chatId, customerId, messageId,
  mediaType, mediaUrl, mimetype,
  caption, sentBy, fileName,
}) {
  await pool.query(
    `INSERT INTO crm_messages
       (chat_id, customer_id, external_message_id,
        direction, type, content, sent_by, created_at)
     VALUES ($1, $2, $3, 'outbound', $4, $5::jsonb, $6, NOW())
     ON CONFLICT (external_message_id) DO NOTHING`,
    [
      chatId, customerId, messageId, mediaType,
      JSON.stringify({
        mediaUrl,
        mimeType:  mimetype,
        caption:   caption  ?? null,
        fileName:  fileName ?? null,
      }),
      sentBy ?? "system",
    ]
  );
  log.info({ chatId, messageId, mediaType, sentBy }, "Media saliente guardado");
}

module.exports = { saveInboundMedia, saveOutboundMedia };
