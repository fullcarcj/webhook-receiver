/**
 * Cliente HTTP para Wasender API (WhatsApp).
 * @see https://wasenderapi.com/api-docs/messages/send-text-message
 *
 * Env típico:
 *   WASENDER_API_KEY      — Bearer token (obligatorio para enviar)
 *   WASENDER_API_BASE_URL — opcional, default https://www.wasenderapi.com
 *   WA_DAILY_CAP          — límite de mensajes por número por día, default 5
 *   WA_QUIET_HOURS_*      — ventana configurable (default 00:00–05:00 America/Caracas); solo bloquea si WA_QUIET_HOURS_BLOCK_SEND=1 (ver load-env-local.js, src/services/waQuietHours.js)
 *   WA_PREVENT_DUPLICATES, WA_MAX_REMINDERS_PER_DAY — anti-spam (src/services/waAntiSpam.js)
 *
 * Opciones de envío:
 *   messageType — 'CHAT' | 'REMINDER' | 'MARKETING' | 'CRITICAL' (default CHAT: no anti-spam; automatizaciones deben usar otro tipo)
 *   customerId  — opcional, para auditoría en wa_sent_messages_log
 *
 * Todos los sends pasan por anti-spam (si aplica), checkWaSendCap() y luego la API.
 * Para bypass puntual pasar opts.skipThrottle = true (omite quiet hours, throttle y anti-spam).
 *
 * Bloqueo por política: { ok: false, status: 'blocked', reason: 'DUPLICATE_24H' | 'REMINDER_DAILY_CAP', ... } (no es error HTTP).
 */

/** Lazy-load del pool para evitar circular dependencies. */
function getPool() {
  try { return require("./db").pool; } catch (_) { return null; }
}

/** Lazy-load del throttle service. */
function getThrottle() {
  try { return require("./src/services/waThrottle"); } catch (_) { return null; }
}

/** Lazy-load quiet hours (opcional bloqueo por ventana horaria). */
function getQuietHours() {
  try { return require("./src/services/waQuietHours"); } catch (_) { return null; }
}

/** Lazy-load anti-spam. */
function getAntiSpam() {
  try { return require("./src/services/waAntiSpam"); } catch (_) { return null; }
}

/** Si WA_QUIET_HOURS_BLOCK_SEND=1 y hora en ventana, devuelve config para log; si no aplica, null. Respeta skipThrottle. */
function getWaQuietBlockReason(opts) {
  if (opts && opts.skipThrottle) return null;
  const qh = getQuietHours();
  if (!qh) return null;
  const cfg = qh.getWaQuietHoursConfig();
  if (!cfg.blockSend) return null;
  if (!qh.isWaQuietHoursNow()) return null;
  return cfg;
}

function normalizePhoneE164(to) {
  let s = String(to || "").trim().replace(/\s/g, "");
  if (!s) return "";
  if (!s.startsWith("+")) s = "+" + s.replace(/^\+/, "");
  return s;
}

function blockedPolicyResponse(reason) {
  if (reason === "DUPLICATE_24H") {
    console.warn("[ANTI-SPAM] Mensaje idéntico detectado");
  } else {
    console.warn(`[ANTI-SPAM] Envío bloqueado — ${reason}`);
  }
  /* Decisión de política (no error HTTP): orquestadores leen status/reason; http real = 0 */
  return {
    ok: false,
    status: "blocked",
    reason,
    json: null,
    bodyText: "",
    httpStatus: 0,
  };
}

/**
 * @param {object} pool
 * @param {object} opts — opts + to, text/image fields
 * @param {string} contentHash — sha256 hex
 * @returns {Promise<{ blocked?: boolean, reason?: string, shouldLogAfterSend: boolean, contentHash: string }>}
 */
async function runAntiSpamBeforeSend(pool, opts, contentHash) {
  if (opts.skipThrottle) {
    return { shouldLogAfterSend: false, contentHash };
  }
  const anti = getAntiSpam();
  if (!anti || !pool || !contentHash || contentHash.length !== 64) {
    return { shouldLogAfterSend: false, contentHash };
  }
  const phoneE164 = normalizePhoneE164(opts.to);
  const r = await anti.evaluateWaSendPolicy(pool, {
    phoneE164,
    customerId: opts.customerId,
    messageType: opts.messageType,
    contentHash,
  });
  if (!r.allowed) {
    return { blocked: true, reason: r.reason, shouldLogAfterSend: false, contentHash };
  }
  return { shouldLogAfterSend: r.shouldLogAfterSend, contentHash };
}

async function recordAntiSpamAfterSuccess(pool, opts, contentHash, shouldLogAfterSend) {
  if (!shouldLogAfterSend || !contentHash || !pool) return;
  const anti = getAntiSpam();
  if (!anti) return;
  await anti.recordWaSentMessage(pool, {
    customerId: opts.customerId,
    phoneE164: normalizePhoneE164(opts.to),
    messageType: opts.messageType,
    contentHash,
  });
}

/**
 * @param {object} opts
 * @param {string} opts.apiBaseUrl — sin barra final
 * @param {string} opts.apiKey
 * @param {string} opts.to — E.164, p. ej. +584121234567
 * @param {string} opts.text
 * @param {string} [opts.messageType='CHAT']
 * @param {number} [opts.customerId]
 * @param {boolean} [opts.skipThrottle=false] — bypass del cap diario, quiet hours y anti-spam
 * @returns {Promise<{ ok: boolean, status: number|string, json: object|null, bodyText: string, throttled?: boolean, reason?: string }>}
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

  const quietBlock = getWaQuietBlockReason(opts);
  if (quietBlock) {
    console.warn(`[waQuietHours] BLOQUEADO texto ${to} — ventana ${quietBlock.start}–${quietBlock.end} ${quietBlock.tz}`);
    return { ok: false, status: 0, json: null, bodyText: "", quiet_hours: true };
  }

  const pool = getPool();
  const anti = getAntiSpam();
  const contentHash = anti ? anti.hashContentUtf8(text) : "";
  const asp = await runAntiSpamBeforeSend(pool, opts, contentHash);
  if (asp.blocked) {
    return blockedPolicyResponse(asp.reason);
  }

  const throttle = getThrottle();
  if (pool && throttle) {
    const cap = await throttle.checkWaSendCap(to, pool, { skipThrottle: !!opts.skipThrottle });
    if (!cap.allowed) {
      console.warn(`[waThrottle] BLOQUEADO ${to} — ${cap.count}/${cap.cap} mensajes hoy`);
      return { ok: false, status: 0, json: null, bodyText: "", throttled: true, throttle_count: cap.count, throttle_cap: cap.cap };
    }
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
  if (ok) {
    await recordAntiSpamAfterSuccess(pool, opts, asp.contentHash, asp.shouldLogAfterSend);
  }
  return { ok, status: res.status, json, bodyText };
}

/**
 * Imagen por URL + leyenda opcional (Wasender mismo endpoint).
 * @see https://wasenderapi.com/api-docs/messages/send-image-message
 * @param {object} opts
 * @param {string} opts.imageUrl — URL pública HTTPS (JPEG/PNG, máx. ~5MB)
 * @param {string} [opts.text] — caption
 * @param {string} [opts.messageType='CHAT']
 * @param {number} [opts.customerId]
 * @param {boolean} [opts.skipThrottle=false]
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

  const quietBlockImg = getWaQuietBlockReason(opts);
  if (quietBlockImg) {
    console.warn(`[waQuietHours] BLOQUEADO imagen ${to} — ventana ${quietBlockImg.start}–${quietBlockImg.end} ${quietBlockImg.tz}`);
    return { ok: false, status: 0, json: null, bodyText: "", quiet_hours: true };
  }

  const pool = getPool();
  const anti = getAntiSpam();
  const contentHash = anti
    ? anti.hashContentUtf8(JSON.stringify({ imageUrl, text }))
    : "";
  const asp = await runAntiSpamBeforeSend(pool, opts, contentHash);
  if (asp.blocked) {
    return blockedPolicyResponse(asp.reason);
  }

  const throttle = getThrottle();
  if (pool && throttle) {
    const cap = await throttle.checkWaSendCap(to, pool, { skipThrottle: !!opts.skipThrottle });
    if (!cap.allowed) {
      console.warn(`[waThrottle] BLOQUEADO imagen ${to} — ${cap.count}/${cap.cap} mensajes hoy`);
      return { ok: false, status: 0, json: null, bodyText: "", throttled: true };
    }
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
  if (ok) {
    await recordAntiSpamAfterSuccess(pool, opts, asp.contentHash, asp.shouldLogAfterSend);
  }
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
 * @param {string} [opts.messageType='CHAT']
 * @param {number} [opts.customerId]
 * @param {boolean} [opts.skipThrottle=false]
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

  const quietBlockLoc = getWaQuietBlockReason(opts);
  if (quietBlockLoc) {
    console.warn(`[waQuietHours] BLOQUEADO location ${to} — ventana ${quietBlockLoc.start}–${quietBlockLoc.end} ${quietBlockLoc.tz}`);
    return { ok: false, status: 0, json: null, bodyText: "", quiet_hours: true };
  }

  const pool = getPool();
  const anti = getAntiSpam();
  const name = opts.name != null ? String(opts.name).trim() : "";
  const address = opts.address != null ? String(opts.address).trim() : "";
  const capText = opts.text != null ? String(opts.text) : "";
  const contentHash = anti
    ? anti.hashContentUtf8(
        JSON.stringify({
          latitude,
          longitude,
          name,
          address,
          text: capText,
        })
      )
    : "";
  const asp = await runAntiSpamBeforeSend(pool, opts, contentHash);
  if (asp.blocked) {
    return blockedPolicyResponse(asp.reason);
  }

  const throttle = getThrottle();
  if (pool && throttle) {
    const cap = await throttle.checkWaSendCap(to, pool, { skipThrottle: !!opts.skipThrottle });
    if (!cap.allowed) {
      console.warn(`[waThrottle] BLOQUEADO location ${to} — ${cap.count}/${cap.cap} mensajes hoy`);
      return { ok: false, status: 0, json: null, bodyText: "", throttled: true };
    }
  }
  const location = { latitude, longitude };
  if (name) location.name = name;
  if (address) location.address = address;
  const body = { to, location };
  if (capText) body.text = capText;
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
  if (ok) {
    await recordAntiSpamAfterSuccess(pool, opts, asp.contentHash, asp.shouldLogAfterSend);
  }
  return { ok, status: res.status, json, bodyText };
}

module.exports = {
  sendWasenderTextMessage,
  sendWasenderImageMessage,
  sendWasenderLocationMessage,
};
