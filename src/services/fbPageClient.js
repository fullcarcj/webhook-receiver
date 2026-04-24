"use strict";

/**
 * Cliente liviano para la Meta Graph API (Messenger / Pages API).
 * Sin dependencias externas: usa `https` nativo de Node.
 *
 * Variables de entorno requeridas:
 *   FB_PAGE_ACCESS_TOKEN  — Page Access Token (long-lived)
 *   FB_APP_SECRET         — para validar firma HMAC de webhooks entrantes
 *   FB_PAGE_ID            — ID de la Fan Page
 *   FB_WEBHOOK_VERIFY_TOKEN — token libre usado en la verificación GET
 *
 * Opcionales:
 *   FB_GRAPH_API_VERSION  — p. ej. "v21.0" (default "v21.0")
 */

const https = require("https");
const crypto = require("crypto");

const GRAPH_VERSION = process.env.FB_GRAPH_API_VERSION || "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * POST JSON a la Graph API.
 * @param {string} path — p. ej. "/me/messages"
 * @param {object} body
 * @returns {Promise<{ ok: boolean, status: number, data: object }>}
 */
function graphPost(path, body) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN || "";
  const url = `${BASE}${path}?access_token=${encodeURIComponent(token)}`;
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (_) {
            /* respuesta no-JSON */
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Envía un mensaje de texto al PSID de un usuario de la página.
 * @param {string} psid
 * @param {string} text
 * @returns {Promise<{ ok: boolean, status: number, data: object }>}
 */
function sendTextMessage(psid, text) {
  return graphPost("/me/messages", {
    recipient: { id: psid },
    message: { text: String(text).slice(0, 2000) },
    messaging_type: "RESPONSE",
  });
}

/**
 * Verifica la firma HMAC-SHA256 del webhook entrante de Meta.
 * @param {Buffer} rawBody
 * @param {string} signatureHeader — cabecera "X-Hub-Signature-256"
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) return false;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  if (!signatureHeader) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(String(signatureHeader), "utf8")
    );
  } catch (_) {
    return false;
  }
}

module.exports = { sendTextMessage, verifyWebhookSignature, graphPost };
