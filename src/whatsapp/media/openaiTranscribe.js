"use strict";

const { writeFileSync, unlinkSync, existsSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const pino = require("pino");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "openaiTranscribe" });

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
  if (mimetype.includes("ogg"))  return "ogg";
  if (mimetype.includes("mp4"))  return "mp4";
  if (mimetype.includes("webm")) return "webm";
  if (mimetype.includes("mpeg")) return "mp3";
  if (mimetype.includes("wav"))  return "wav";
  return "ogg";
}

/**
 * Transcribe audio/video con OpenAI gpt-4o-mini-transcribe.
 * Activa automáticamente si OPENAI_API_KEY existe.
 * Si no hay key o el tipo no es soportado, retorna null silenciosamente.
 * @returns {Promise<string|null>}
 */
async function transcribeWithOpenAI({ buffer, mimetype, messageId }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!isTranscribable(mimetype)) return null;

  // Límite de 25MB de OpenAI
  if (buffer.length > 25 * 1024 * 1024) {
    log.warn({ size: buffer.length, messageId }, "Audio supera 25MB — skip transcripción");
    return null;
  }

  const ext     = getExtFromMimetype(mimetype);
  const tmpPath = path.join(tmpdir(), `wa_${messageId}_${Date.now()}.${ext}`);

  try {
    writeFileSync(tmpPath, buffer);

    const formData = new FormData();
    const blob     = new Blob([buffer], { type: mimetype });
    formData.append("file",            blob, `audio.${ext}`);
    formData.append("model",           "gpt-4o-mini");
    formData.append("language",        "es");
    formData.append("response_format", "text");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method:  "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body:    formData,
    });

    if (!res.ok) {
      throw new Error(`OpenAI [${res.status}]: ${await res.text()}`);
    }

    const text = (await res.text()).trim();
    log.info(
      { messageId, chars: text.length, preview: text.substring(0, 60) },
      "Transcripción OpenAI exitosa"
    );
    return text || null;
  } catch (err) {
    log.error({ err: err.message, messageId }, "Error transcripción OpenAI");
    return null;
  } finally {
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    }
  }
}

module.exports = { transcribeWithOpenAI };
