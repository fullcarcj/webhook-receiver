/**
 * Normaliza mensajes del JSON de GET /messages/packs/{pack_id}/sellers/{seller_id}
 * (post-venta / tag post_sale).
 */

/**
 * @param {object} m
 * @returns {string|null}
 */
function extractMlMessageId(m) {
  if (!m || typeof m !== "object") return null;
  const v = m.id != null ? m.id : m.message_id;
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * @param {object} m
 * @returns {{ from_user_id: number|null, to_user_id: number|null }}
 */
function extractFromToUserIds(m) {
  if (!m || typeof m !== "object") return { from_user_id: null, to_user_id: null };
  let fromUid = null;
  let toUid = null;
  const from = m.from;
  const to = m.to;
  if (from && typeof from === "object") {
    if (from.user_id != null) fromUid = Number(from.user_id);
    else if (from.id != null) fromUid = Number(from.id);
  }
  if (to && typeof to === "object") {
    if (to.user_id != null) toUid = Number(to.user_id);
    else if (to.id != null) toUid = Number(to.id);
  }
  return {
    from_user_id: Number.isFinite(fromUid) && fromUid > 0 ? fromUid : null,
    to_user_id: Number.isFinite(toUid) && toUid > 0 ? toUid : null,
  };
}

/**
 * @param {object} data — cuerpo JSON del GET pack
 * @returns {object[]}
 */
function messagesArrayFromPackBody(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

/**
 * @param {object} data
 * @returns {number|null}
 */
function pagingTotalFromPackBody(data) {
  if (!data || typeof data !== "object") return null;
  const p = data.paging;
  if (p && typeof p === "object" && p.total != null) {
    const n = Number(p.total);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * @param {number} mlUserId
 * @param {number} orderId — id usado en la ruta del pack (suele ser order_id en post-venta)
 * @param {string|null} tag — p. ej. post_sale
 * @param {object} m — elemento del array messages
 * @param {string} fetchedAt — ISO
 * @returns {object|null} fila para upsertMlOrderPackMessage
 */
/**
 * Id de mensaje opaco en `resource` del webhook (solo hex o `/messages/{id}`).
 * @param {string|null|undefined} resourceStr
 * @returns {string|null}
 */
function extractOpaqueMessageIdFromResource(resourceStr) {
  if (resourceStr == null || typeof resourceStr !== "string") return null;
  const s = resourceStr.trim();
  if (/^[0-9a-f]{32}$/i.test(s)) return s;
  const uuid = s.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  if (uuid) return s;
  const m = s.match(/\/messages\/([^/?#]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return null;
}

/**
 * Cuerpo del GET /messages/{id}: mensaje en raíz o bajo `message`.
 * @param {object} data
 * @returns {object|null}
 */
function pickMessageRoot(data) {
  if (!data || typeof data !== "object") return null;
  if (extractMlMessageId(data)) return data;
  if (data.message && typeof data.message === "object" && extractMlMessageId(data.message)) {
    return data.message;
  }
  return null;
}

/**
 * Persistir fila desde la respuesta del fetch del webhook `messages` (cuando el pack listado
 * `/messages/packs/{order_id}/...` aún no existe o devuelve 404).
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {string|null} tag
 * @param {object} data — JSON del GET
 * @param {string} fetchedAt — ISO
 * @param {string|null|undefined} resourceStr — resource del webhook (fallback id mensaje)
 * @returns {object|null} fila para upsertMlOrderPackMessage
 */
function orderPackMessageRowFromWebhookMessageGet(
  mlUserId,
  orderId,
  tag,
  data,
  fetchedAt,
  resourceStr
) {
  const root = pickMessageRoot(data) || data;
  if (!root || typeof root !== "object") return null;
  let mid = extractMlMessageId(root);
  if (!mid) mid = extractOpaqueMessageIdFromResource(resourceStr);
  if (!mid) return null;
  const { from_user_id, to_user_id } = extractFromToUserIds(root);
  let rawJson;
  try {
    rawJson = JSON.stringify(data);
  } catch {
    rawJson = "{}";
  }
  const text =
    root.text != null
      ? String(root.text)
      : root.message != null
        ? String(root.message)
        : root.body != null
          ? String(root.body)
          : null;
  return {
    ml_user_id: mlUserId,
    order_id: orderId,
    ml_message_id: mid,
    from_user_id,
    to_user_id,
    message_text: text,
    date_created:
      root.date_created != null
        ? String(root.date_created)
        : root.date != null
          ? String(root.date)
          : null,
    status: root.status != null ? String(root.status) : null,
    moderation_status: root.moderation_status != null ? String(root.moderation_status) : null,
    tag: tag != null ? String(tag) : null,
    raw_json: rawJson,
    fetched_at: fetchedAt,
    updated_at: fetchedAt,
  };
}

function orderPackMessageRowFromApi(mlUserId, orderId, tag, m, fetchedAt) {
  const mid = extractMlMessageId(m);
  if (!mid) return null;
  const { from_user_id, to_user_id } = extractFromToUserIds(m);
  let rawJson;
  try {
    rawJson = JSON.stringify(m);
  } catch {
    rawJson = "{}";
  }
  const text =
    m.text != null
      ? String(m.text)
      : m.message != null
        ? String(m.message)
        : m.body != null
          ? String(m.body)
          : null;
  return {
    ml_user_id: mlUserId,
    order_id: orderId,
    ml_message_id: mid,
    from_user_id,
    to_user_id,
    message_text: text,
    date_created:
      m.date_created != null
        ? String(m.date_created)
        : m.date != null
          ? String(m.date)
          : null,
    status: m.status != null ? String(m.status) : null,
    moderation_status: m.moderation_status != null ? String(m.moderation_status) : null,
    tag: tag != null ? String(tag) : null,
    raw_json: rawJson,
    fetched_at: fetchedAt,
    updated_at: fetchedAt,
  };
}

module.exports = {
  extractMlMessageId,
  extractFromToUserIds,
  messagesArrayFromPackBody,
  pagingTotalFromPackBody,
  orderPackMessageRowFromApi,
  orderPackMessageRowFromWebhookMessageGet,
  extractOpaqueMessageIdFromResource,
  pickMessageRoot,
};
