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
};
