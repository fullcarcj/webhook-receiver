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

/** Respuesta GET /messages/...: prioriza order_id si viene en el JSON. */
function extractOrderIdFromMessage(data) {
  if (!data || typeof data !== "object") return null;
  return toPositiveInt(
    data.order_id ??
      data.order?.id ??
      data.pack_id ??
      data.pack?.id ??
      (data.message && data.message.order_id) ??
      (data.message && data.message.pack_id) ??
      data.resource?.pack_id
  );
}

module.exports = {
  extractOrderIdFromOrder,
  extractOrderIdFromMessage,
};
