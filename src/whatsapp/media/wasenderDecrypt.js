"use strict";

const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "wasenderDecrypt" });

const BASE = "https://www.wasenderapi.com";

/**
 * Descifra y obtiene la URL pública del media (válida 1 hora).
 * @returns {Promise<string>} publicUrl
 */
async function decryptMediaWithWasender(messageId, messageKey, meta) {
  const apiKey = String(process.env.WASENDER_API_KEY || "").trim();
  if (!apiKey) throw new Error("WASENDER_API_KEY no configurada");

  const payload = {
    data: {
      messages: {
        key: { id: messageId },
        message: {
          [messageKey]: {
            url:        meta.url,
            mimetype:   meta.mimetype,
            mediaKey:   meta.mediaKey,
            fileSha256: meta.fileSha256,
            fileLength: String(meta.fileLength),
            fileName:   meta.fileName || null,
          },
        },
      },
    },
  };

  const res = await fetch(`${BASE}/api/decrypt-media`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wasender decrypt [${res.status}]: ${body.slice(0, 300)}`);
  }

  const result = await res.json();
  const publicUrl = result?.publicUrl;
  if (!publicUrl) {
    throw new Error(`Wasender decrypt sin publicUrl: ${JSON.stringify(result).slice(0, 200)}`);
  }

  log.info({ messageId, messageKey }, "Media descifrado OK (URL válida ~1h)");
  return publicUrl;
}

/**
 * Descarga el archivo ya descifrado desde la URL pública de Wasender.
 * @returns {Promise<Buffer>}
 */
async function downloadDecryptedFile(publicUrl) {
  const res = await fetch(publicUrl);
  if (!res.ok) {
    throw new Error(`Download falló [${res.status}]: ${publicUrl}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error("Archivo descargado vacío");
  return buffer;
}

module.exports = { decryptMediaWithWasender, downloadDecryptedFile };
