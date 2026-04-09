"use strict";

const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "wasenderUpload" });

const SIZE_LIMITS = {
  image:    16 * 1024 * 1024,
  video:    50 * 1024 * 1024,
  audio:    16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker:  5  * 1024 * 1024,
};

const BASE = "https://www.wasenderapi.com";

/**
 * Sube un Buffer a Wasender /api/upload (Raw Binary Upload).
 * La publicUrl devuelta es válida 24 horas — enviar el mensaje inmediatamente.
 * @param {{ buffer: Buffer, mimeType: string, mediaType: string }} opts
 * @returns {Promise<string>} publicUrl
 */
async function uploadToWasender({ buffer, mimeType, mediaType }) {
  const apiKey = String(process.env.WASENDER_API_KEY || "").trim();
  if (!apiKey) throw new Error("WASENDER_API_KEY no configurada");

  const limit = SIZE_LIMITS[mediaType];
  if (limit && buffer.length > limit) {
    const limitMB = Math.round(limit / 1024 / 1024);
    const err = new Error(`El archivo supera el límite de ${limitMB}MB para ${mediaType}`);
    err.code   = "FILE_TOO_LARGE";
    err.status = 422;
    throw err;
  }

  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": mimeType,
    },
    body: buffer,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wasender upload [${res.status}]: ${body.slice(0, 300)}`);
  }

  const result    = await res.json();
  const publicUrl = result?.publicUrl;
  if (!publicUrl) {
    throw new Error(`Wasender upload sin publicUrl: ${JSON.stringify(result).slice(0, 200)}`);
  }

  log.info({ mediaType, sizeKB: Math.round(buffer.length / 1024) }, "Upload a Wasender OK (24h)");
  return publicUrl;
}

module.exports = { uploadToWasender, SIZE_LIMITS };
