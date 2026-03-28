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

module.exports = {
  orderRowFromMlApi,
  feedbackSummaryFromOrder,
};
