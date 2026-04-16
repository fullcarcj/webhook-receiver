"use strict";

const { z } = require("zod");
const { timingSafeCompare } = require("../services/currencyService");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const purchaseService = require("../services/purchaseService");

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


const purchaseBodySchema = z.object({
  customer_id: z.number().int().positive(),
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        part_name: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price_usd: z.number().positive(),
      })
    )
    .min(1),
  notes: z.string().max(500).optional(),
  sold_by: z.string().max(100).optional(),
});

async function handlePurchaseApiRequest(req, res, url) {
  if (req.method !== "POST" || url.pathname !== "/api/customers/purchase") {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);
  if (!await requireAdminOrPermission(req, res, 'ventas')) return true;

  let body = {};
  try {
    body = await parseJsonBody(req);
  } catch (_e) {
    writeJson(res, 400, { error: "invalid_json" });
    return true;
  }

  const parsed = safeParse(purchaseBodySchema, body);
  if (!parsed.ok) {
    writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
    return true;
  }

  try {
    const out = await purchaseService.registerMostradorPurchase({
      customerId: parsed.data.customer_id,
      items: parsed.data.items,
      notes: parsed.data.notes,
      soldBy: parsed.data.sold_by,
    });
    writeJson(res, 201, {
      data: {
        order_id: out.order_id,
        customer_id: out.customer_id,
        total_amount_usd: out.total_amount_usd,
        points_earned: out.points_earned,
        new_loyalty_balance: out.new_loyalty_balance,
        new_level: out.new_level,
        items: out.items,
      },
      meta: { timestamp: new Date().toISOString() },
    });
    return true;
  } catch (e) {
    if (e && e.code === "NOT_FOUND") {
      writeJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    if (e && e.code === "LOYALTY_SCHEMA_MISSING") {
      writeJson(res, 503, { error: "loyalty_schema_missing", detail: "Ejecutar sql/20260408_loyalty.sql" });
      return true;
    }
    if (e && e.code === "42P01") {
      writeJson(res, 503, { error: "schema_missing", detail: "Ejecutar sql/20260408_mostrador_orders.sql" });
      return true;
    }
    if (e && e.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: String(e.message) });
      return true;
    }
    writeJson(res, 500, { error: "error", message: String(e.message) });
    return true;
  }
}

module.exports = { handlePurchaseApiRequest };
