/**
 * pack_id para mensajería post-venta (action_guide) desde respuestas de la API ML.
 */

function toPositiveInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractPackIdFromOrder(data) {
  if (!data || typeof data !== "object") return null;
  return toPositiveInt(data.pack_id ?? data.pack?.id);
}

function extractPackIdFromMessage(data) {
  if (!data || typeof data !== "object") return null;
  return toPositiveInt(
    data.pack_id ??
      data.pack?.id ??
      (data.message && data.message.pack_id) ??
      data.resource?.pack_id
  );
}

module.exports = { extractPackIdFromOrder, extractPackIdFromMessage };
