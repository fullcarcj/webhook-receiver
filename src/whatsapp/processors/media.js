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
const { transcribeWithGroq } = require("../media/groqTranscribe");
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

    // 1. Validar tamaño antes de descargar
    if (meta.fileLength > 0 && meta.fileLength > config.sizeLimit) {
      log.warn({ fileLength: meta.fileLength, limit: config.sizeLimit, type: config.type, messageId: normalized.messageId }, "media: archivo supera el límite — ignorado");
      await mark("skipped_size_limit", `size=${meta.fileLength},limit=${config.sizeLimit}`);
      return;
    }

    // 2. Deduplicación: fila creada solo por este pipeline (messages.js no inserta media entrante).
    const { rows: existing } = await pool.query(
      `SELECT id FROM crm_messages WHERE external_message_id = $1 LIMIT 1`,
      [normalized.messageId]
    );
    if (existing.length) {
      log.info({ messageId: normalized.messageId }, "media: ya procesado, skip duplicado");
      await mark("completed", "already_saved_dedup");
      return;
    }

    log.info({ fromPhone: normalized.fromPhone, type: config.type, messageId: normalized.messageId }, "media: procesando");

    // 3. Descifrar + descargar
    const publicUrl  = await decryptMediaWithWasender(normalized.messageId, messageKey, meta);
    const fileBuffer = await downloadDecryptedFile(publicUrl);

    // 4. Subir a Firebase Storage siempre (aunque el cliente no esté registrado aún)
    const fileName    = buildFileName(normalized.fromPhone, normalized.messageId, config.ext, meta.fileName);
    const firebaseUrl = await uploadToFirebase({
      buffer:   fileBuffer,
      folder:   config.folder,
      fileName,
      mimeType: meta.mimetype,
    });

    // 5. Transcribir si aplica (audio/video)
    let transcription = null;
    let transcriptionError = null;
    if (config.transcribable) {
      const tr = await transcribeWithGroq({
        buffer:    fileBuffer,
        mimetype:  meta.mimetype,
        messageId: normalized.messageId,
      });
      transcription = tr.text;
      transcriptionError = tr.error;
    }

    // 6. Buscar chat existente (opcional — no bloquea el flujo)
    const { rows: chatRows } = await pool.query(
      `SELECT c.id AS chat_id, c.customer_id
       FROM crm_chats c
       WHERE REGEXP_REPLACE(c.phone, '\\D', '', 'g') = $1
       LIMIT 1`,
      [String(normalized.fromPhone).replace(/\D/g, "")]
    );

    let chatId     = null;
    let customerId = null;

    if (chatRows.length) {
      // 7. Guardar en crm_messages solo si el chat ya existe
      ({ chat_id: chatId, customer_id: customerId } = chatRows[0]);
      await saveInboundMedia({
        chatId,
        customerId,
        messageId:  normalized.messageId,
        mediaType:  config.type,
        firebaseUrl,
        mimetype:   meta.mimetype,
        meta,
        transcription,
        transcriptionError,
      });
      await mark("completed", "saved_in_crm_messages", firebaseUrl);
    } else {
      // Chat aún no existe (onboarding pendiente): media subida a Firebase, sin guardar en crm_messages
      log.info({ fromPhone: normalized.fromPhone, firebaseUrl }, "media: subido a Firebase, chat pendiente de onboarding");
      await mark("completed", "firebase_only_no_chat", firebaseUrl);
    }

    // 8. Pipeline de comprobantes — solo para imágenes, siempre en setImmediate (no bloquear webhook)
    if (config.type === "image" && fileBuffer) {
      setImmediate(async () => {
        try {
          const { isPaymentReceipt }   = require("../media/receiptDetector");
          const { extractReceiptData } = require("../media/receiptExtractor");

          const prefilter = await isPaymentReceipt(fileBuffer);
          log.info({
            score:     prefilter.score,
            isReceipt: prefilter.isReceipt,
            reason:    prefilter.reason,
            messageId: normalized.messageId,
          }, "media: prefiltro comprobante");

          if (!prefilter.isReceipt) return;

          const extracted = await extractReceiptData(firebaseUrl);

          const { rows: attemptRows } = await pool.query(
            `INSERT INTO payment_attempts
               (customer_id, chat_id, firebase_url,
                extracted_reference, extracted_amount_bs, extracted_date,
                extracted_bank, extracted_payment_type, extraction_confidence,
                is_receipt, prefiler_score)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
             RETURNING id`,
            [
              customerId  ?? null,
              chatId      ?? null,
              firebaseUrl,
              extracted?.reference_number ?? null,
              extracted?.amount_bs        ?? null,
              extracted?.tx_date          ?? null,
              extracted?.bank_name        ?? null,
              extracted?.payment_type     ?? null,
              extracted?.confidence       ?? null,
              prefilter.score,
            ]
          );

          const attemptId = attemptRows[0]?.id ?? null;
          log.info({
            customerId,
            attemptId,
            ref:    extracted?.reference_number,
            amount: extracted?.amount_bs,
          }, "media: payment_attempt guardado");

          // Trigger 2 event-driven: conciliar este comprobante específico sin bloquear el webhook
          if (attemptId && extracted?.amount_bs != null) {
            const { reconcileAttempt } = require("../../services/reconciliationService");
            reconcileAttempt(attemptId).catch((err) =>
              log.error({ err: err.message, attemptId }, "media: reconcileAttempt post-vision falló")
            );
          }

          // Notificar frontend en tiempo real
          try {
            const { emitReceiptDetected } = require("../../services/sseService");
            emitReceiptDetected({
              customerId:  customerId  ?? null,
              chatId:      chatId      ?? null,
              amountBs:    extracted?.amount_bs        ?? null,
              reference:   extracted?.reference_number ?? null,
              bank:        extracted?.bank_name        ?? null,
              confidence:  extracted?.confidence       ?? null,
            });
          } catch (_) { /* SSE opcional — no bloquear flujo */ }
        } catch (receiptErr) {
          log.error({ err: receiptErr.message, messageId: normalized.messageId },
            "media: error procesando comprobante");
        }
      });
    }

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
