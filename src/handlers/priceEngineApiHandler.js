"use strict";

const { z } = require("zod");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { ensureAdmin } = require("../middleware/adminAuth");
const priceEngineService = require("../services/priceEngineService");
const priceApprovalService = require("../services/priceApprovalService");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 1024 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

const updateSettingSchema = z.object({
  value: z.number().min(0).max(100),
  changed_by: z.enum(["Javier", "Jesus", "Sebastian"]),
  reason: z.string().min(3).max(500).optional(),
});

const calculateSchema = z.object({
  base_usd: z.number().positive(),
  channel: z.enum(["mostrador", "mercadolibre", "ecommerce", "social_media"]),
  customer_id: z.number().int().positive().optional(),
});

const requestApprovalSchema = z.object({
  order_id: z.number().int().positive().optional(),
  product_id: z.number().int().positive(),
  sku: z.string().min(1),
  product_name: z.string().min(1),
  calculated_price_bs: z.number().positive(),
  requested_price_bs: z.number().positive(),
  requested_by: z.enum(["Jesus", "Sebastian"]),
  reason: z.string().min(10).max(500),
});

const reviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reviewed_by: z.literal("Javier"),
  approved_price_bs: z.number().positive().optional(),
  comment: z.string().max(500).optional(),
});

async function handlePriceApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (
    !pathname.startsWith("/api/price-settings") &&
    !pathname.startsWith("/api/price/") &&
    pathname !== "/api/price/cache"
  ) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (!ensureAdmin(req, res, url)) return true;

  try {
    if (req.method === "GET" && pathname === "/api/price-settings") {
      const data = await priceEngineService.listSettings();
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }
    if (req.method === "GET" && pathname === "/api/price-settings/history") {
      const limit = Number(url.searchParams.get("limit") || "100");
      const offset = Number(url.searchParams.get("offset") || "0");
      const data = await priceEngineService.listSettingsHistory({ limit, offset });
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }
    const setPatch = pathname.match(/^\/api\/price-settings\/([^/]+)$/);
    if (req.method === "PATCH" && setPatch) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(updateSettingSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await priceEngineService.updateSetting({
        key: decodeURIComponent(setPatch[1]),
        newValue: parsed.data.value,
        changedBy: parsed.data.changed_by,
        reason: parsed.data.reason,
      });
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }

    if (req.method === "POST" && pathname === "/api/price/calculate") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(calculateSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await priceEngineService.calculatePrice({
        baseUsd: parsed.data.base_usd,
        channel: parsed.data.channel,
        customerId: parsed.data.customer_id,
      });
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }

    if (req.method === "GET" && pathname === "/api/price/cache") {
      const data = priceEngineService.getCache();
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }

    if (req.method === "POST" && pathname === "/api/price/approval/request") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(requestApprovalSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await priceApprovalService.requestPriceApproval({
        orderId: parsed.data.order_id,
        productId: parsed.data.product_id,
        sku: parsed.data.sku,
        productName: parsed.data.product_name,
        calculatedPriceBs: parsed.data.calculated_price_bs,
        requestedPriceBs: parsed.data.requested_price_bs,
        requestedBy: parsed.data.requested_by,
        reason: parsed.data.reason,
      });
      return writeJson(res, 201, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }

    const reviewMatch = pathname.match(/^\/api\/price\/approval\/(\d+)\/review$/);
    if (req.method === "POST" && reviewMatch) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(reviewSchema, body);
      if (!parsed.ok) return writeJson(res, 422, { error: "validation_error", details: parsed.error.issues }), true;
      const data = await priceApprovalService.reviewPriceRequest({
        requestId: Number(reviewMatch[1]),
        decision: parsed.data.decision,
        reviewedBy: parsed.data.reviewed_by,
        approvedPriceBs: parsed.data.approved_price_bs,
        comment: parsed.data.comment,
      });
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }

    if (req.method === "GET" && pathname === "/api/price/approval/pending") {
      const limit = Number(url.searchParams.get("limit") || "100");
      const offset = Number(url.searchParams.get("offset") || "0");
      const data = await priceApprovalService.listPendingApprovals({ limit, offset });
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }

    if (req.method === "GET" && pathname === "/api/price/approval/history") {
      const limit = Number(url.searchParams.get("limit") || "100");
      const offset = Number(url.searchParams.get("offset") || "0");
      const data = await priceApprovalService.listApprovalsHistory({ limit, offset });
      return writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } }), true;
    }
  } catch (e) {
    if (e && e.code === "SETTING_NOT_FOUND") return writeJson(res, 404, { error: "setting_not_found" }), true;
    if (e && e.code === "INVALID_BASE_PRICE") return writeJson(res, 400, { error: "invalid_base_price" }), true;
    if (e && e.code === "INVALID_CHANNEL") return writeJson(res, 400, { error: "invalid_channel" }), true;
    if (e && e.code === "INVALID_PRICE_REQUEST") return writeJson(res, 400, { error: "invalid_price_request", message: e.message }), true;
    if (e && e.code === "INVALID_DECISION") return writeJson(res, 400, { error: "invalid_decision" }), true;
    if (e && e.code === "REQUEST_NOT_FOUND_OR_EXPIRED") return writeJson(res, 404, { error: "request_not_found_or_expired", message: e.message }), true;
    return writeJson(res, 500, { error: "error", message: String(e.message || e) }), true;
  }

  return writeJson(res, 404, { error: "not_found" }), true;
}

module.exports = { handlePriceApiRequest };
