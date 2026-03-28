/**
 * Normaliza respuesta de orden ML (GET /orders/search o GET /orders/{id}) para `upsertMlOrder`.
 */

/**
 * `feedback.sale` = calificación del vendedor hacia el comprador (nosotros → comprador).
 * `feedback.purchase` = calificación del comprador hacia el vendedor (comprador → nosotros).
 * @returns {{ feedback_sale: string|null, feedback_purchase: string|null }}
 */
function feedbackSummaryFromOrder(order) {
  const fb = order && order.feedback;
  if (!fb || typeof fb !== "object") {
    return { feedback_sale: null, feedback_purchase: null };
  }
  function one(side) {
    if (side == null) return "pending";
    if (typeof side !== "object") return null;
    if (side.rating != null) return String(side.rating);
    if (side.status != null) return String(side.status);
    return "pending";
  }
  return {
    feedback_sale: one(fb.sale),
    feedback_purchase: one(fb.purchase),
  };
}

/**
 * @param {number} mlUserId - cuenta vendedor (ml_accounts.ml_user_id)
 * @param {object} order - objeto orden API
 * @param {object} [options]
 * @param {number} [options.http_status]
 * @param {string|null} [options.sync_error]
 * @param {string} [options.fetched_at] ISO
 * @returns {object|null}
 */
function orderRowFromMlApi(mlUserId, order, options = {}) {
  if (!order || typeof order !== "object") return null;
  const oid = order.id != null ? Number(order.id) : NaN;
  const uid = Number(mlUserId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(oid) || oid <= 0) return null;

  let rawJson;
  try {
    rawJson = JSON.stringify(order);
  } catch {
    rawJson = "{}";
  }

  const buyerId =
    order.buyer && order.buyer.id != null
      ? Number(order.buyer.id)
      : order.buyer_id != null
        ? Number(order.buyer_id)
        : null;

  const total =
    order.total_amount != null
      ? order.total_amount
      : order.paid_amount != null
        ? order.paid_amount
        : null;

  const fb = feedbackSummaryFromOrder(order);

  const now = new Date().toISOString();
  return {
    ml_user_id: uid,
    order_id: oid,
    status: order.status != null ? String(order.status) : null,
    date_created: order.date_created != null ? String(order.date_created) : null,
    total_amount: total,
    currency_id: order.currency_id != null ? String(order.currency_id) : null,
    buyer_id: buyerId != null && Number.isFinite(buyerId) ? buyerId : null,
    feedback_sale: fb.feedback_sale,
    feedback_purchase: fb.feedback_purchase,
    raw_json: rawJson,
    http_status: options.http_status != null ? Number(options.http_status) : null,
    sync_error: options.sync_error != null ? String(options.sync_error) : null,
    fetched_at: options.fetched_at != null ? String(options.fetched_at) : now,
    updated_at: now,
  };
}

/**
 * Filas normalizadas para `upsertMlOrderFeedback`.
 * Solo incluye lados con `id` numérico (feedback oficial en ML).
 * @param {number} mlUserId
 * @param {number|string} orderId
 * @param {object|null|undefined} feedbackRoot - `order.feedback` o cuerpo de GET /orders/{id}/feedback
 * @param {object} [options]
 * @param {string} [options.fetched_at]
 * @param {string} [options.updated_at]
 * @param {string} [options.source] - ej. order_search, order_embedded, orders_feedback_get
 * @returns {object[]}
 */
function feedbackDetailRowsFromOrder(mlUserId, orderId, feedbackRoot, options = {}) {
  const rows = [];
  if (!feedbackRoot || typeof feedbackRoot !== "object") return rows;
  const oid = orderId != null ? Number(orderId) : NaN;
  const uid = Number(mlUserId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(oid) || oid <= 0) return rows;

  const fetchedAt =
    options.fetched_at != null ? String(options.fetched_at) : new Date().toISOString();
  const updatedAt =
    options.updated_at != null ? String(options.updated_at) : fetchedAt;
  const source =
    options.source != null && String(options.source).trim() !== ""
      ? String(options.source).trim()
      : "order_embedded";

  for (const sideName of ["sale", "purchase"]) {
    const side = feedbackRoot[sideName];
    if (!side || typeof side !== "object") continue;
    const fid = side.id != null ? Number(side.id) : NaN;
    if (!Number.isFinite(fid) || fid <= 0) continue;

    let rawJson;
    try {
      rawJson = JSON.stringify(side);
    } catch {
      rawJson = "{}";
    }

    let replyStr = null;
    if (side.reply != null) {
      replyStr = typeof side.reply === "string" ? side.reply : JSON.stringify(side.reply);
    }

    const item = side.item && typeof side.item === "object" ? side.item : null;

    rows.push({
      ml_user_id: uid,
      order_id: oid,
      side: sideName,
      ml_feedback_id: fid,
      role: side.role != null ? String(side.role) : null,
      fulfilled:
        side.fulfilled === true ? true : side.fulfilled === false ? false : null,
      rating: side.rating != null ? String(side.rating) : null,
      reason: side.reason != null ? String(side.reason) : null,
      message: side.message != null ? String(side.message) : null,
      reply: replyStr,
      date_created: side.date_created != null ? String(side.date_created) : null,
      visibility_date: side.visibility_date != null ? String(side.visibility_date) : null,
      feedback_status: side.status != null ? String(side.status) : null,
      modified:
        side.modified === true ? true : side.modified === false ? false : null,
      restock_item:
        side.restock_item === true ? true : side.restock_item === false ? false : null,
      has_seller_refunded_money:
        side.has_seller_refunded_money === true
          ? true
          : side.has_seller_refunded_money === false
            ? false
            : null,
      from_user_id:
        side.from && side.from.id != null ? Number(side.from.id) : null,
      to_user_id: side.to && side.to.id != null ? Number(side.to.id) : null,
      from_nickname:
        side.from && side.from.nickname != null ? String(side.from.nickname) : null,
      to_nickname: side.to && side.to.nickname != null ? String(side.to.nickname) : null,
      item_id: item && item.id != null ? String(item.id) : null,
      item_title: item && item.title != null ? String(item.title) : null,
      item_price: item && item.price != null ? Number(item.price) : null,
      item_currency_id:
        item && item.currency_id != null ? String(item.currency_id) : null,
      extended_feedback: side.extended_feedback != null ? side.extended_feedback : null,
      site_id: side.site_id != null ? String(side.site_id) : null,
      app_id: side.app_id != null ? String(side.app_id) : null,
      raw_json: rawJson,
      source,
      fetched_at: fetchedAt,
      updated_at: updatedAt,
    });
  }
  return rows;
}

module.exports = {
  orderRowFromMlApi,
  feedbackSummaryFromOrder,
  feedbackDetailRowsFromOrder,
};
