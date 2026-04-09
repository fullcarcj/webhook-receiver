"use strict";

const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "wasenderSend" });

// DECISIÓN: Wasender usa /api/send-message con campos diferentes por tipo
// (imageUrl, audioUrl, videoUrl, documentUrl) — igual que sendWasenderImageMessage
// en wasender-client.js. No requiere sessionId; solo Bearer apiKey.
const BASE = "https://www.wasenderapi.com";

function getApiKey() {
  return String(process.env.WASENDER_API_KEY || "").trim();
}

function getApiBaseUrl() {
  return String(process.env.WASENDER_API_BASE_URL || BASE).replace(/\/$/, "");
}

/**
 * Formatea el número a JID de WhatsApp.
 * Acepta: "584XXXXXXXXX" o "584XXXXXXXXX@s.whatsapp.net"
 */
function toJid(phone) {
  const p = String(phone || "").trim();
  return p.includes("@") ? p : `${p}@s.whatsapp.net`;
}

async function doPost(endpoint, body) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("WASENDER_API_KEY no configurada");

  const url = `${getApiBaseUrl()}${endpoint}`;
  const res  = await fetch(url, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const bodyText = await res.text();
  let json = null;
  try { json = bodyText ? JSON.parse(bodyText) : null; } catch (_) { /* ignore */ }

  if (!res.ok) {
    throw new Error(`Wasender send [${res.status}]: ${bodyText.slice(0, 300)}`);
  }

  return json;
}

/**
 * Envía media al cliente usando la publicUrl devuelta por /api/upload.
 * @param {{ toPhone, mediaType, publicUrl, caption?, fileName? }} opts
 */
async function sendMediaToWhatsApp({ toPhone, mediaType, publicUrl, caption, fileName }) {
  const to = toJid(toPhone);

  let endpoint;
  let body;

  switch (mediaType) {
    case "image":
      endpoint = "/api/send-message";
      body = { to, imageUrl: publicUrl };
      if (caption) body.text = caption;
      break;

    case "audio":
      endpoint = "/api/send-message";
      body = { to, audioUrl: publicUrl };
      break;

    case "video":
      endpoint = "/api/send-message";
      body = { to, videoUrl: publicUrl };
      if (caption) body.text = caption;
      break;

    case "document":
      endpoint = "/api/send-message";
      body = { to, documentUrl: publicUrl, fileName: fileName || "documento.pdf" };
      if (caption) body.text = caption;
      break;

    default:
      throw new Error(`Tipo de media no soportado para envío: ${mediaType}`);
  }

  const result = await doPost(endpoint, body);
  log.info({ toPhone, mediaType }, "Media enviado via Wasender");
  return result;
}

module.exports = { sendMediaToWhatsApp };
