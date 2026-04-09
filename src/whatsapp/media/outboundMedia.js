"use strict";

/**
 * Orquestador de media saliente.
 * Flujo: validar → upload paralelo (Wasender + Firebase) → send → guardar DB.
 */

const pino = require("pino");
const { randomUUID }                      = require("crypto");
const { uploadToWasender, SIZE_LIMITS }   = require("./wasenderUpload");
const { sendMediaToWhatsApp }             = require("./wasenderSend");
const { uploadToFirebase, buildFileName } = require("./firebaseUpload");
const { saveOutboundMedia }               = require("./mediaSaver");
const { pool }                            = require("../../../db");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "outboundMedia" });

/**
 * Envía un archivo media al cliente por WhatsApp.
 *
 * @param {object} params
 * @param {string}  params.toPhone    — teléfono destino (584XXXXXXXXX)
 * @param {string}  params.mediaType  — 'image'|'audio'|'video'|'document'
 * @param {Buffer}  params.buffer     — archivo en Buffer
 * @param {string}  params.mimeType   — mimetype exacto
 * @param {string}  [params.caption]  — texto opcional
 * @param {string}  [params.fileName] — nombre del archivo (documentos)
 * @param {string}  [params.sentBy]   — 'jesus'|'sebastian'|'javier'|'system'|'ai'
 */
async function sendMedia({
  toPhone, mediaType, buffer, mimeType,
  caption, fileName, sentBy = "system",
}) {
  const limit = SIZE_LIMITS[mediaType];
  if (limit && buffer.length > limit) {
    const limitMB = Math.round(limit / 1024 / 1024);
    const err = new Error(`Archivo supera ${limitMB}MB para tipo ${mediaType}`);
    err.code   = "FILE_TOO_LARGE";
    err.status = 422;
    throw err;
  }

  const messageId     = randomUUID();
  const ext           = mimeType.split("/")[1] || "bin";
  const fileNameBuilt = buildFileName(toPhone, messageId, ext, fileName);
  const folder        = `wa-${mediaType}s-sent`;

  // Upload paralelo: Wasender (URL 24h para enviar) + Firebase (URL permanente para DB)
  const [wasenderUrl, firebaseUrl] = await Promise.all([
    uploadToWasender({ buffer, mimeType, mediaType }),
    uploadToFirebase({ buffer, folder, fileName: fileNameBuilt, mimeType }),
  ]);

  const sendResult = await sendMediaToWhatsApp({
    toPhone, mediaType,
    publicUrl: wasenderUrl,
    caption,
    fileName,
  });

  // Buscar chat_id y customer_id para guardar el mensaje saliente
  const digits = String(toPhone).replace(/\D/g, "");
  const { rows } = await pool.query(
    `SELECT id AS chat_id, customer_id
     FROM crm_chats
     WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') = $1
     LIMIT 1`,
    [digits]
  );

  if (!rows.length) {
    log.warn({ toPhone }, "outboundMedia: chat no encontrado — no se guarda en crm_messages");
    return sendResult;
  }

  const msgId = sendResult?.data?.key?.id ?? sendResult?.data?.msgId ?? messageId;

  await saveOutboundMedia({
    chatId:     rows[0].chat_id,
    customerId: rows[0].customer_id,
    messageId:  msgId,
    mediaType,
    mediaUrl:   firebaseUrl,
    mimetype:   mimeType,
    caption,
    sentBy,
    fileName,
  });

  return sendResult;
}

module.exports = { sendMedia };
