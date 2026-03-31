/**
 * Verificación de cabecera `X-Webhook-Signature` de Wasender API (panel de sesión → Webhook Secret).
 *
 * Variables de entorno (la primera no vacía gana; mismo valor que pegás en Wasender):
 *   WASENDER_WEBHOOK_SECRET      — nombre recomendado en docs Wasender
 *   WASENDER_X_WEBHOOK_SIGNATURE — alias explícito (coincide con el nombre de la cabecera)
 *
 * Si ninguna está definida, no se exige firma (solo desarrollo / pruebas sin secreto).
 *
 * @see https://wasenderapi.com/api-docs/webhooks/webhook-setup
 */

const crypto = require("crypto");

/**
 * @returns {string|null} secreto configurado o null si no hay verificación
 */
function getWasenderWebhookSecret() {
  const keys = ["WASENDER_WEBHOOK_SECRET", "WASENDER_X_WEBHOOK_SIGNATURE"];
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

function timingSafeEqualStrings(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Lee cabecera `X-Webhook-Signature` (Node normaliza a minúsculas).
 * @param {import("http").IncomingMessage} req
 * @returns {{ ok: boolean, skipped: boolean, signatureHeader: string|null }}
 */
function wasenderWebhookSignatureOk(req) {
  const secret = getWasenderWebhookSecret();
  if (secret == null) {
    return { ok: true, skipped: true, signatureHeader: null };
  }
  const sig =
    req.headers["x-webhook-signature"] != null
      ? String(req.headers["x-webhook-signature"]).trim()
      : "";
  const ok = sig !== "" && timingSafeEqualStrings(sig, secret);
  return {
    ok,
    skipped: false,
    signatureHeader: sig !== "" ? sig.slice(0, 500) : null,
  };
}

module.exports = {
  getWasenderWebhookSecret,
  wasenderWebhookSignatureOk,
};
