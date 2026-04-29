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
const { getSwitches, isTipoMConsoleAndEnvEnabled } = require("../../services/aiConsoleSwitches");
const { normalizePhone, expandPhoneMatchKeys } = require("../../utils/phoneNormalizer");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "media_processor" });

const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

/**
 * Misma idea que el hub de texto (messages.js / inbox): claves 0414…, 58…, etc.
 * Sin esto, el comprobante se inserta con chat_id/customer_id NULL y
 * GET /api/inbox/payment-attempts?customer_id=… no devuelve items.
 */
async function resolveCrmChatForInboundMedia(poolConn, phoneRaw) {
  const norm = normalizePhone(phoneRaw);
  const keys = expandPhoneMatchKeys(norm || String(phoneRaw || "").replace(/\D/g, ""));
  if (!keys.length) return { chat_id: null, customer_id: null };
  const { rows } = await poolConn.query(
    `SELECT c.id AS chat_id, c.customer_id
       FROM crm_chats c
       LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE COALESCE(c.source_type, 'wa_inbound') IN ('wa_inbound', 'wa_ml_linked')
        AND (
          regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = ANY($1::text[])
          OR (
            cu.phone IS NOT NULL
            AND btrim(cu.phone) <> ''
            AND regexp_replace(COALESCE(cu.phone, ''), '[^0-9]', '', 'g') = ANY($1::text[])
          )
          OR (
            NULLIF(TRIM(COALESCE(cu.phone_2, '')), '') IS NOT NULL
            AND regexp_replace(COALESCE(cu.phone_2, ''), '[^0-9]', '', 'g') = ANY($1::text[])
          )
        )
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT 1`,
    [keys]
  );
  return rows[0] || { chat_id: null, customer_id: null };
}

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
    let switchesForMedia = { transcription_groq: true, receipt_gemini_vision: true };
    try {
      switchesForMedia = await getSwitches();
    } catch (_e) {
      /* defaults */
    }
    if (config.transcribable && switchesForMedia.transcription_groq !== false) {
      const tr = await transcribeWithGroq({
        buffer:    fileBuffer,
        mimetype:  meta.mimetype,
        messageId: normalized.messageId,
      });
      transcription = tr.text;
      transcriptionError = tr.error;
    } else if (config.transcribable && switchesForMedia.transcription_groq === false) {
      transcriptionError = "transcripción desactivada en consola IA";
    }

    // 6. Buscar chat existente (opcional — no bloquea el flujo)
    const chatRow = await resolveCrmChatForInboundMedia(pool, normalized.fromPhone);
    const chatRows = chatRow.chat_id != null ? [chatRow] : [];

    let chatId     = null;
    let customerId = null;

    if (chatRows.length) {
      // 7. Guardar en crm_messages solo si el chat ya existe
      ({ chat_id: chatId, customer_id: customerId } = chatRows[0]);
      const saveResult = await saveInboundMedia({
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
      const crmMsgId = saveResult && saveResult.id;
      const tipoMQueue = crmMsgId && transcription && (await isTipoMConsoleAndEnvEnabled());
      if (tipoMQueue) {
        try {
          await pool.query(
            `UPDATE crm_messages SET transcription = $1 WHERE id = $2`,
            [transcription, crmMsgId]
          );
          await pool.query(
            `UPDATE crm_messages
             SET ai_reply_status = 'pending_ai_reply'
             WHERE id = $1 AND ai_reply_status IS NULL`,
            [crmMsgId]
          );
        } catch (e) {
          if (e && e.code !== "42703") {
            log.warn({ err: e.message, crmMsgId }, "media: cola IA transcripción no aplicada");
          }
        }
      }
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
          const { isPaymentReceipt } = require("../media/receiptDetector");
          const {
            extractReceiptData,
            paymentAttemptFieldsFromExtraction,
          } = require("../media/receiptExtractor");

          const prefilter = await isPaymentReceipt(fileBuffer);
          log.info({
            score:     prefilter.score,
            isReceipt: prefilter.isReceipt,
            reason:    prefilter.reason,
            messageId: normalized.messageId,
          }, "media: prefiltro comprobante");

          if (!prefilter.isReceipt) return;

          const resolvedForPa = await resolveCrmChatForInboundMedia(pool, normalized.fromPhone);
          const insChatId =
            resolvedForPa.chat_id != null ? Number(resolvedForPa.chat_id) : chatId != null ? Number(chatId) : null;
          const insCustomerId =
            resolvedForPa.customer_id != null
              ? Number(resolvedForPa.customer_id)
              : customerId != null
                ? Number(customerId)
                : null;

          let swReceipt = { receipt_gemini_vision: true };
          try {
            swReceipt = await getSwitches();
          } catch (_e) {}
          if (swReceipt.receipt_gemini_vision === false) {
            log.info({ messageId: normalized.messageId }, "media: OCR comprobante desactivado en consola IA — skip");
            return;
          }

          // Dedup por firebase_url: Wasender reintenta el webhook varias veces
          const { rows: dupCheck } = await pool.query(
            `SELECT id FROM payment_attempts WHERE firebase_url = $1 LIMIT 1`,
            [firebaseUrl]
          );
          if (dupCheck.length) {
            log.info({ firebaseUrl, existingId: dupCheck[0].id, messageId: normalized.messageId },
              "media: payment_attempt ya existe para esta URL, skip duplicado");
            return;
          }

          const extraction = await extractReceiptData(firebaseUrl);
          const pf = paymentAttemptFieldsFromExtraction(extraction);

          let attemptRows;
          try {
            attemptRows = await pool.query(
              `INSERT INTO payment_attempts
                 (customer_id, chat_id, firebase_url,
                  extracted_reference, extracted_amount_bs, extracted_date,
                  extracted_bank, extracted_payment_type, extraction_confidence,
                  is_receipt, prefiler_score, prefiler_reason,
                  extraction_status, extraction_error, extraction_raw_snippet)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11,$12,$13,$14)
               ON CONFLICT (firebase_url) DO NOTHING
               RETURNING id`,
              [
                insCustomerId,
                insChatId,
                firebaseUrl,
                pf.extracted_reference,
                pf.extracted_amount_bs,
                pf.extracted_date,
                pf.extracted_bank,
                pf.extracted_payment_type,
                pf.extraction_confidence,
                prefilter.score,
                prefilter.reason ?? null,
                pf.extraction_status,
                pf.extraction_error,
                pf.extraction_raw_snippet,
              ]
            );
          } catch (insErr) {
            if (insErr && insErr.code === "42703") {
              log.warn({ err: insErr.message }, "media: payment_attempts sin columnas extraction_* — npm run db:payment-attempts-extraction-audit");
              attemptRows = await pool.query(
                `INSERT INTO payment_attempts
                   (customer_id, chat_id, firebase_url,
                    extracted_reference, extracted_amount_bs, extracted_date,
                    extracted_bank, extracted_payment_type, extraction_confidence,
                    is_receipt, prefiler_score, prefiler_reason)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11)
                 ON CONFLICT (firebase_url) DO NOTHING
                 RETURNING id`,
                [
                  insCustomerId,
                  insChatId,
                  firebaseUrl,
                  pf.extracted_reference,
                  pf.extracted_amount_bs,
                  pf.extracted_date,
                  pf.extracted_bank,
                  pf.extracted_payment_type,
                  pf.extraction_confidence,
                  prefilter.score,
                  prefilter.reason ?? null,
                ]
              );
            } else {
              throw insErr;
            }
          }

          const attemptId = attemptRows.rows[0]?.id ?? null;
          log.info(
            {
              customerId: insCustomerId,
              chatId: insChatId,
              attemptId,
              ref: pf.extracted_reference,
              amount: pf.extracted_amount_bs,
              extraction_status: pf.extraction_status,
            },
            "media: payment_attempt guardado"
          );

          if (
            (await isTipoMConsoleAndEnvEnabled()) &&
            normalized.messageId &&
            extraction.status === "ok" &&
            extraction.data &&
            (extraction.data.amount_bs != null || extraction.data.reference_number)
          ) {
            try {
              await pool.query(
                `UPDATE crm_messages
                 SET receipt_data = $1::jsonb,
                     ai_reply_status = CASE
                       WHEN ai_reply_status IS NULL THEN 'pending_receipt_confirm'
                       ELSE ai_reply_status
                     END
                 WHERE external_message_id = $2
                   AND direction = 'inbound'`,
                [JSON.stringify(extraction.data), normalized.messageId]
              );
            } catch (e) {
              if (e && e.code !== "42703") {
                log.warn({ err: e.message }, "media: receipt_data / cola IA no aplicada");
              }
            }
          }

          // Trigger 2 event-driven: conciliar este comprobante específico sin bloquear el webhook
          if (attemptId && pf.extracted_amount_bs != null) {
            const { reconcileAttempt } = require("../../services/reconciliationService");
            reconcileAttempt(attemptId).catch((err) =>
              log.error({ err: err.message, attemptId }, "media: reconcileAttempt post-vision falló")
            );
          }

          // Notificar frontend en tiempo real
          try {
            const { emitReceiptDetected } = require("../../services/sseService");
            emitReceiptDetected({
              customerId: insCustomerId,
              chatId: insChatId,
              amountBs: pf.extracted_amount_bs ?? null,
              reference: pf.extracted_reference ?? null,
              bank: pf.extracted_bank ?? null,
              confidence: pf.extraction_confidence ?? null,
            });
          } catch (_) {
            /* SSE opcional — no bloquear flujo */
          }
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
