/**
 * Cliente HTTP para Wasender API (WhatsApp).
 * @see https://wasenderapi.com/api-docs/messages/send-text-message
 *
 * Env típico:
 *   WASENDER_API_KEY — Bearer token (obligatorio para enviar)
 *   WASENDER_API_BASE_URL — opcional, default https://www.wasenderapi.com
 */

/**
 * @param {object} opts
 * @param {string} opts.apiBaseUrl — sin barra final
 * @param {string} opts.apiKey
 * @param {string} opts.to — E.164, p. ej. +584121234567
 * @param {string} opts.text
 * @returns {Promise<{ ok: boolean, status: number, json: object|null, bodyText: string }>}
 */
async function sendWasenderTextMessage(opts) {
  const apiBaseUrl = (opts.apiBaseUrl || "https://www.wasenderapi.com").replace(/\/$/, "");
  const apiKey = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  const to = opts.to != null ? String(opts.to).trim() : "";
  const text = opts.text != null ? String(opts.text) : "";
  if (!apiKey) {
    return { ok: false, status: 0, json: null, bodyText: "" };
  }
  if (!to || !text) {
    return { ok: false, status: 0, json: null, bodyText: "" };
  }
  const url = `${apiBaseUrl}/api/send-message`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, text }),
  });
  const bodyText = await res.text();
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    json = null;
  }
  const ok = res.ok && json && json.success === true;
  return { ok, status: res.status, json, bodyText };
}

/**
 * Imagen por URL + leyenda opcional (Wasender mismo endpoint).
 * @see https://wasenderapi.com/api-docs/messages/send-image-message
 * @param {object} opts
 * @param {string} opts.imageUrl — URL pública HTTPS (JPEG/PNG, máx. ~5MB)
 * @param {string} [opts.text] — caption
 */
async function sendWasenderImageMessage(opts) {
  const apiBaseUrl = (opts.apiBaseUrl || "https://www.wasenderapi.com").replace(/\/$/, "");
  const apiKey = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  const to = opts.to != null ? String(opts.to).trim() : "";
  const imageUrl = opts.imageUrl != null ? String(opts.imageUrl).trim() : "";
  const text = opts.text != null ? String(opts.text) : "";
  if (!apiKey) {
    return { ok: false, status: 0, json: null, bodyText: "" };
  }
  if (!to || !imageUrl) {
    return { ok: false, status: 0, json: null, bodyText: "" };
  }
  const url = `${apiBaseUrl}/api/send-message`;
  const body = { to, imageUrl };
  if (text) body.text = text;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const bodyText = await res.text();
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    json = null;
  }
  const ok = res.ok && json && json.success === true;
  return { ok, status: res.status, json, bodyText };
}

/**
 * Pin de ubicación (mismo endpoint).
 * @see https://wasenderapi.com/api-docs/messages/send-location
 * @param {object} opts
 * @param {number} opts.latitude
 * @param {number} opts.longitude
 * @param {string} [opts.name]
 * @param {string} [opts.address]
 * @param {string} [opts.text] — leyenda opcional (p. ej. enlace a Maps)
 */
async function sendWasenderLocationMessage(opts) {
  const apiBaseUrl = (opts.apiBaseUrl || "https://www.wasenderapi.com").replace(/\/$/, "");
  const apiKey = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  const to = opts.to != null ? String(opts.to).trim() : "";
  const latitude = Number(opts.latitude);
  const longitude = Number(opts.longitude);
  if (!apiKey) {
    return { ok: false, status: 0, json: null, bodyText: "" };
  }
  if (!to || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, status: 0, json: null, bodyText: "" };
  }
  const location = { latitude, longitude };
  const name = opts.name != null ? String(opts.name).trim() : "";
  const address = opts.address != null ? String(opts.address).trim() : "";
  if (name) location.name = name;
  if (address) location.address = address;
  const body = { to, location };
  const cap = opts.text != null ? String(opts.text) : "";
  if (cap) body.text = cap;
  const url = `${apiBaseUrl}/api/send-message`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const bodyText = await res.text();
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch (_) {
    json = null;
  }
  const ok = res.ok && json && json.success === true;
  return { ok, status: res.status, json, bodyText };
}

module.exports = {
  sendWasenderTextMessage,
  sendWasenderImageMessage,
  sendWasenderLocationMessage,
};
