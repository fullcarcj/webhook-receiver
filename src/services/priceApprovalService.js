"use strict";

const { pool } = require("../../db");
const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "price_approval" });
const { emit } = require("./sseService");

async function requestPriceApproval({
  orderId,
  productId,
  sku,
  productName,
  calculatedPriceBs,
  requestedPriceBs,
  requestedBy,
  reason,
}) {
  if (Number(requestedPriceBs) >= Number(calculatedPriceBs)) {
    const e = new Error("INVALID_PRICE_REQUEST");
    e.code = "INVALID_PRICE_REQUEST";
    throw e;
  }
  const discountPct = Math.round((((calculatedPriceBs - requestedPriceBs) / calculatedPriceBs) * 100) * 100) / 100;
  const { rows } = await pool.query(
    `INSERT INTO price_approval_requests
      (order_id, product_id, sku, product_name, calculated_price_bs, requested_price_bs, discount_pct,
       requested_by, request_reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
     RETURNING id, expires_at`,
    [orderId || null, productId, sku, productName, calculatedPriceBs, requestedPriceBs, discountPct, requestedBy, reason]
  );
  const r = rows[0];
  emit("price_approval_request", {
    request_id: r.id,
    sku,
    product_name: productName,
    calculated_price_bs: calculatedPriceBs,
    requested_price_bs: requestedPriceBs,
    discount_pct: discountPct,
    requested_by: requestedBy,
    reason,
    expires_at: r.expires_at,
  });
  log.info({ requestId: r.id, sku, requestedBy }, "price_approval: solicitud creada");
  return { request_id: r.id, status: "pending", expires_at: r.expires_at, discount_pct: discountPct };
}

async function reviewPriceRequest({ requestId, decision, reviewedBy, approvedPriceBs = null, comment = null }) {
  if (!["approved", "rejected"].includes(String(decision))) {
    const e = new Error("INVALID_DECISION");
    e.code = "INVALID_DECISION";
    throw e;
  }
  const { rows } = await pool.query(
    `SELECT * FROM price_approval_requests
     WHERE id = $1 AND status = 'pending' AND expires_at > NOW()`,
    [requestId]
  );
  if (!rows.length) {
    const e = new Error("REQUEST_NOT_FOUND_OR_EXPIRED");
    e.code = "REQUEST_NOT_FOUND_OR_EXPIRED";
    throw e;
  }
  const req = rows[0];
  const finalPrice = decision === "approved" ? Number(approvedPriceBs || req.requested_price_bs) : null;
  await pool.query(
    `UPDATE price_approval_requests
     SET status = $1, approved_price_bs = $2, reviewed_by = $3, review_comment = $4, reviewed_at = NOW()
     WHERE id = $5`,
    [decision, finalPrice, reviewedBy, comment, requestId]
  );
  emit("price_approval_result", {
    request_id: requestId,
    decision,
    approved_price_bs: finalPrice,
    reviewed_by: reviewedBy,
    comment,
    requested_by: req.requested_by,
    sku: req.sku,
    product_name: req.product_name,
  });
  log.info({ requestId, decision, reviewedBy }, "price_approval: solicitud revisada");
  return { request_id: requestId, decision, approved_price_bs: finalPrice, reviewed_by: reviewedBy, comment };
}

async function expirePendingRequests() {
  const { rows } = await pool.query(
    `UPDATE price_approval_requests
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()
     RETURNING id, requested_by, sku`
  );
  for (const r of rows) {
    emit("price_approval_expired", {
      request_id: r.id,
      requested_by: r.requested_by,
      sku: r.sku,
    });
  }
  if (rows.length) log.warn({ expired: rows.length }, "price_approval: solicitudes expiradas");
  return { expired: rows.length };
}

async function listPendingApprovals({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT *
     FROM price_approval_requests
     WHERE status = 'pending'
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [lim, off]
  );
  return rows;
}

async function listApprovalsHistory({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT *
     FROM price_approval_requests
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [lim, off]
  );
  return rows;
}

module.exports = {
  requestPriceApproval,
  reviewPriceRequest,
  expirePendingRequests,
  listPendingApprovals,
  listApprovalsHistory,
};
