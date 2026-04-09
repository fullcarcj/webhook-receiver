"use strict";

const MEDIA_CONFIG = {
  imageMessage: {
    type:          "image",
    folder:        "wa-images",
    ext:           "jpg",
    transcribable: false,
    sizeLimit:     16 * 1024 * 1024,
  },
  videoMessage: {
    type:          "video",
    folder:        "wa-videos",
    ext:           "mp4",
    transcribable: true,
    sizeLimit:     50 * 1024 * 1024,
  },
  audioMessage: {
    type:          "audio",
    folder:        "wa-audios",
    ext:           "ogg",
    transcribable: true,
    sizeLimit:     16 * 1024 * 1024,
  },
  documentMessage: {
    type:          "document",
    folder:        "wa-documents",
    ext:           "pdf",
    transcribable: false,
    sizeLimit:     100 * 1024 * 1024,
  },
  stickerMessage: {
    type:          "sticker",
    folder:        "wa-stickers",
    ext:           "webp",
    transcribable: false,
    sizeLimit:     5 * 1024 * 1024,
  },
};

/**
 * Detecta si un objeto `message` de Baileys/Wasender contiene media.
 * @param {object|null} messageObj — el campo `message` del payload crudo
 * @returns {{ messageKey: string, config: object, meta: object }|null}
 */
function findMediaNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const key of Object.keys(MEDIA_CONFIG)) {
    if (node[key] && typeof node[key] === "object") {
      return { key, media: node[key] };
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const hit = findMediaNode(value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function detectMedia(messageObj) {
  if (!messageObj || typeof messageObj !== "object") return null;
  const hit = findMediaNode(messageObj, 0);
  if (!hit) return null;
  const { key, media } = hit;
  const config = MEDIA_CONFIG[key];
  return {
    messageKey: key,
    config,
    meta: {
      url:        media.url        ?? null,
      mediaKey:   media.mediaKey   ?? null,
      mimetype:   media.mimetype   ?? "application/octet-stream",
      fileLength: parseInt(media.fileLength ?? 0, 10) || 0,
      caption:    media.caption    ?? null,
      fileName:   media.fileName   ?? null,
      fileSha256: media.fileSha256 ?? null,
      ptt:        media.ptt        ?? false,
      seconds:    media.seconds    ?? 0,
      duration:   media.duration   ?? 0,
      pageCount:  media.pageCount  ?? null,
      title:      media.title      ?? null,
    },
  };
}

/**
 * Extrae el objeto `message` desde el payload normalizado (rawPayload de Baileys/Wasender).
 * @param {object} normalized — normalized del hookRouter
 * @returns {object|null}
 */
function extractRawMessage(normalized) {
  const body = normalized.rawPayload;
  if (!body || typeof body !== "object") return null;
  const dataTop = body.data != null ? body.data : body;
  // array: data.messages[0].message
  if (Array.isArray(dataTop.messages) && dataTop.messages[0]) {
    return dataTop.messages[0].message || null;
  }
  // objeto directo: data.messages.message (Wasender envía messages como objeto, no array)
  if (dataTop.messages && typeof dataTop.messages === "object" && !Array.isArray(dataTop.messages) && dataTop.messages.message) {
    return dataTop.messages.message;
  }
  // fallback: data.message
  if (dataTop.message && typeof dataTop.message === "object") {
    return dataTop.message;
  }
  return null;
}

module.exports = { detectMedia, extractRawMessage, MEDIA_CONFIG };
