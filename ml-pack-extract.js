/**
 * Id de orden para mensajería post-venta (ruta ML: .../packs/{id}/option — aquí id = order id).
 */

function toPositiveInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Respuesta GET /orders/{id}: id de la orden. */
function extractOrderIdFromOrder(data) {
  if (!data || typeof data !== "object") return null;
  return toPositiveInt(data.id ?? data.order_id ?? data.pack_id ?? data.pack?.id);
}

/**
 * Recorre subárboles típicos de GET /messages/{id} (ML: ids opacos, order_id en resource/context/message).
 * @param {object} obj
 * @param {number} depth
 * @returns {number|null}
 */
function scanOrderIdNested(obj, depth) {
  if (!obj || typeof obj !== "object" || depth <= 0) return null;
  for (const k of ["order_id", "pack_id"]) {
    if (obj[k] != null) {
      const n = toPositiveInt(obj[k]);
      if (n) return n;
    }
  }
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        for (const el of v) {
          if (el && typeof el === "object") {
            const n = scanOrderIdNested(el, depth - 1);
            if (n) return n;
          }
        }
      } else {
        const n = scanOrderIdNested(v, depth - 1);
        if (n) return n;
      }
    }
  }
  return null;
}

/** Respuesta GET /messages/...: prioriza order_id si viene en el JSON. */
function extractOrderIdFromMessage(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.order_id,
    data.order?.id,
    data.pack_id,
    data.pack?.id,
    data.resource?.pack_id,
    data.resource?.order_id,
    data.context?.order_id,
    data.metadata?.order_id,
    data.conversation?.order_id,
    data.message?.order_id,
    data.message?.pack_id,
    data.message?.pack?.id,
    data.message?.order?.id,
    data.message?.resource?.order_id,
    data.message?.resource?.pack_id,
    data.message?.context?.order_id,
  ];
  for (const c of candidates) {
    const n = toPositiveInt(c);
    if (n) return n;
  }
  const nested = scanOrderIdNested(data, 6);
  if (nested) return nested;
  try {
    const blob = JSON.stringify(data);
    const m = blob.match(/"order_id"\s*:\s*(\d{10,})/);
    if (m) return toPositiveInt(m[1]);
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * Id numérico de orden desde el resource del webhook (p. ej. "/orders/2000001234567890").
 * @param {string} [resourceStr]
 * @returns {number|null}
 */
function extractOrderIdFromResource(resourceStr) {
  if (resourceStr == null || typeof resourceStr !== "string") return null;
  const s = resourceStr.trim();
  const m = s.match(/\/orders\/(\d+)/i) || s.match(/^orders\/(\d+)/i);
  return m ? toPositiveInt(m[1]) : null;
}

/**
 * GET /orders/{id}/feedback: a veces ML incluye `order_id` en el cuerpo (respaldo si el resource no trae /orders/…).
 * No usar `id` en la raíz (puede ser otro identificador).
 */
function extractOrderIdFromFeedbackPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.order_id != null) return toPositiveInt(data.order_id);
  return null;
}

module.exports = {
  extractOrderIdFromOrder,
  extractOrderIdFromMessage,
  extractOrderIdFromResource,
  extractOrderIdFromFeedbackPayload,
};
