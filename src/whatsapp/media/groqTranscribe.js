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

function getExtFromMimetype(mimetype) {
  if (mimetype.includes("ogg")) return "ogg";
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("webm")) return "webm";
  if (mimetype.includes("mpeg")) return "mp3";
  if (mimetype.includes("wav")) return "wav";
  return "ogg";
}

const MAX_ERROR_LEN = 480;

function trimErr(msg) {
  const s = String(msg || "").replace(/\s+/g, " ").trim();
  if (s.length <= MAX_ERROR_LEN) return s;
  return `${s.slice(0, MAX_ERROR_LEN)}…`;
}

/**
 * Transcribe audio/video con Groq Whisper.
 * Requiere GROQ_API_KEY; si no está configurada no rompe el flujo.
 * @returns {Promise<{ text: string|null, error: string|null }>}
 */
async function transcribeWithGroq({ buffer, mimetype, messageId }) {
  if (!process.env.GROQ_API_KEY) {
    return { text: null, error: "GROQ_API_KEY no configurada" };
  }
  if (!isTranscribable(mimetype)) {
    return { text: null, error: `MIME no soportado para transcripción: ${mimetype || "(vacío)"}` };
  }

  if (buffer.length > 25 * 1024 * 1024) {
    log.warn({ size: buffer.length, messageId }, "Audio/video supera 25MB — skip transcripción");
    return { text: null, error: `Archivo supera límite 25MB (${Math.round(buffer.length / 1024 / 1024)}MB)` };
  }

  try {
    const ext = getExtFromMimetype(mimetype);
    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimetype });
    formData.append("file", blob, `media.${ext}`);
    formData.append("model", "whisper-large-v3");
    formData.append("language", "es");
    formData.append("response_format", "json");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      return { text: null, error: trimErr(`Groq HTTP ${res.status}: ${body}`) };
    }

    const data = await res.json();
    const text = String(data?.text || "").trim();
    if (!text) {
      return { text: null, error: "Groq devolvió texto vacío" };
    }

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
