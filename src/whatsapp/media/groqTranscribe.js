"use strict";

const pino = require("pino");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "groqTranscribe" });

const SUPPORTED_MIMETYPES = [
  "audio/ogg",
  "audio/ogg; codecs=opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/mpeg",
];

function isTranscribable(mimetype) {
  if (!mimetype) return false;
  const base = mimetype.toLowerCase().split(";")[0].trim();
  return SUPPORTED_MIMETYPES.some((m) => m.split(";")[0].trim() === base);
}

const MAX_ERROR_LEN = 480;

function trimErr(msg) {
  const s = String(msg || "").replace(/\s+/g, " ").trim();
  if (s.length <= MAX_ERROR_LEN) return s;
  return `${s.slice(0, MAX_ERROR_LEN)}…`;
}

/**
 * Transcribe audio/video con Groq Whisper.
 * Usa el AI Gateway (BD `provider_settings` o `GROQ_API_KEY`); errores devuelven `error` sin lanzar.
 * @returns {Promise<{ text: string|null, error: string|null }>}
 */
async function transcribeWithGroq({ buffer, mimetype, messageId }) {
  if (!isTranscribable(mimetype)) {
    return { text: null, error: `MIME no soportado para transcripción: ${mimetype || "(vacío)"}` };
  }

  if (buffer.length > 25 * 1024 * 1024) {
    log.warn({ size: buffer.length, messageId }, "Audio/video supera 25MB — skip transcripción");
    return { text: null, error: `Archivo supera límite 25MB (${Math.round(buffer.length / 1024 / 1024)}MB)` };
  }

  try {
    const { callAudio } = require("../../services/aiGateway");
    const text = await callAudio({ buffer, mimetype, messageId });
    log.info(
      { messageId, chars: text.length, preview: text.substring(0, 60) },
      "Transcripción Groq exitosa"
    );
    return { text, error: null };
  } catch (err) {
    log.error({ err: err.message, messageId }, "Error transcripción Groq");
    return { text: null, error: trimErr(err.message || "Error desconocido en transcripción") };
  }
}

module.exports = { transcribeWithGroq };
