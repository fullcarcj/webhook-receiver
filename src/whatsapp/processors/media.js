"use strict";

/**
 * Orquestador de media entrante (Wasender/Baileys).
 * Flujo: detectar → decrypt → download → Firebase → (transcribir) → guardar DB.
 * Se llama desde hookRouter.js para eventos messages.received con tipo media.
 */

const pino = require("pino");
const { detectMedia, extractRawMessage } = require("../media/mediaDetector");
const { decryptMediaWithWasender, downloadDecryptedFile } = require("../media/wasenderDecrypt");
const { uploadToFirebase, buildFileName } = require("../media/firebaseUpload");
const { transcribeWithOpenAI } = require("../media/openaiTranscribe");
const { saveInboundMedia } = require("../media/mediaSaver");
const { pool } = require("../../../db");
const { updateWasenderWebhookMediaStatus } = require("../../../db");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "media_processor" });

const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

/**
 * @param {object} normalized — normalized de hookRouter (ya con eventType, fromPhone, etc.)
 */
async function handle(normalized) {
  if (!normalized.fromPhone || !normalized.messageId) return;
  if (!MEDIA_TYPES.has(normalized.type)) return;

  const rawMessage = extractRawMessage(normalized);
  const detected   = detectMedia(rawMessage);
  if (!detected) return;

  const { messageKey, config, meta } = detected;
  const webhookEventId = normalized?.rawPayload?.__wasender_webhook_event_id || null;
  const mark = async (status, detail, firebaseUrl) => {
    try {
      await updateWasenderWebhookMediaStatus({
        id: webhookEventId || null,
        inbound_message_id: normalized.messageId || null,
        media_pipeline_status: status,
        media_pipeline_detail: detail || null,
        media_firebase_url: firebaseUrl || null,
        media_type: config.type,
      });
    } catch (_e) {
      /* no romper flujo por fallo de tracking */
    }
  };

  try {
    await mark("processing", "media_processor_started");
    // 1. Buscar chat + customer: solo procesar si ya están registrados
    const { rows } = await pool.query(
      `SELECT c.id AS chat_id, c.customer_id
       FROM crm_chats c
       WHERE REGEXP_REPLACE(c.phone, '\\D', '', 'g') = $1
       LIMIT 1`,
      [String(normalized.fromPhone).replace(/\D/g, "")]
    );

    if (!rows.length) {
      log.info({ fromPhone: normalized.fromPhone }, "media: chat no existe, skip (onboarding pendiente)");
      await mark("skipped_no_chat", "chat_not_found_or_onboarding_pending");
      return;
    }

    const { chat_id: chatId, customer_id: customerId } = rows[0];

    // 2. Deduplicación: si ya existe en crm_messages, marcar completed y salir
    const { rows: existing } = await pool.query(
      `SELECT id FROM crm_messages WHERE external_message_id = $1 LIMIT 1`,
      [normalized.messageId]
    );
    if (existing.length) {
      log.info({ messageId: normalized.messageId }, "media: ya procesado, skip duplicado");
      await mark("completed", "already_saved_dedup");
      return;
    }

    // 3. Validar tamaño antes de descargar
    if (meta.fileLength > 0 && meta.fileLength > config.sizeLimit) {
      log.warn({
        fileLength: meta.fileLength,
        limit:      config.sizeLimit,
        type:       config.type,
        messageId:  normalized.messageId,
      }, "media: archivo supera el límite — ignorado");
      await mark("skipped_size_limit", `size=${meta.fileLength},limit=${config.sizeLimit}`);
      return;
    }

    log.info({ fromPhone: normalized.fromPhone, type: config.type, messageId: normalized.messageId }, "media: procesando");

    // 4. Descifrar + descargar
    const publicUrl  = await decryptMediaWithWasender(normalized.messageId, messageKey, meta);
    const fileBuffer = await downloadDecryptedFile(publicUrl);

    // 5. Subir a Firebase Storage (URL permanente)
    const fileName    = buildFileName(normalized.fromPhone, normalized.messageId, config.ext, meta.fileName);
    const firebaseUrl = await uploadToFirebase({
      buffer:   fileBuffer,
      folder:   config.folder,
      fileName,
      mimeType: meta.mimetype,
    });

    // 6. Transcribir si aplica (audio/video)
    const transcription = config.transcribable
      ? await transcribeWithOpenAI({
          buffer:    fileBuffer,
          mimetype:  meta.mimetype,
          messageId: normalized.messageId,
        })
      : null;

    // 7. Guardar en DB
    await saveInboundMedia({
      chatId,
      customerId,
      messageId:  normalized.messageId,
      mediaType:  config.type,
      firebaseUrl,
      mimetype:   meta.mimetype,
      meta,
      transcription,
    });
    await mark("completed", "saved_in_crm_messages", firebaseUrl);

  } catch (err) {
    await mark("failed", String(err && err.message ? err.message : err).slice(0, 1800));
    log.error({
      err:       err.message,
      messageId: normalized.messageId,
      phone:     normalized.fromPhone,
      mediaKey:  messageKey,
    }, "media: error procesando media entrante");
  }
}

module.exports = { handle };
