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

  try {
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
      return;
    }

    const { chat_id: chatId, customer_id: customerId } = rows[0];

    // 2. Validar tamaño antes de descargar
    if (meta.fileLength > 0 && meta.fileLength > config.sizeLimit) {
      log.warn({
        fileLength: meta.fileLength,
        limit:      config.sizeLimit,
        type:       config.type,
        messageId:  normalized.messageId,
      }, "media: archivo supera el límite — ignorado");
      return;
    }

    log.info({ fromPhone: normalized.fromPhone, type: config.type, messageId: normalized.messageId }, "media: procesando");

    // 3. Descifrar + descargar
    const publicUrl  = await decryptMediaWithWasender(normalized.messageId, messageKey, meta);
    const fileBuffer = await downloadDecryptedFile(publicUrl);

    // 4. Subir a Firebase Storage (URL permanente)
    const fileName    = buildFileName(normalized.fromPhone, normalized.messageId, config.ext, meta.fileName);
    const firebaseUrl = await uploadToFirebase({
      buffer:   fileBuffer,
      folder:   config.folder,
      fileName,
      mimeType: meta.mimetype,
    });

    // 5. Transcribir si aplica (audio/video)
    const transcription = config.transcribable
      ? await transcribeWithOpenAI({
          buffer:    fileBuffer,
          mimetype:  meta.mimetype,
          messageId: normalized.messageId,
        })
      : null;

    // 6. Guardar en DB
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

  } catch (err) {
    log.error({
      err:       err.message,
      messageId: normalized.messageId,
      phone:     normalized.fromPhone,
      mediaKey:  messageKey,
    }, "media: error procesando media entrante");
  }
}

module.exports = { handle };
