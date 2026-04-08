"use strict";

const { z } = require("zod");
const pino = require("pino");
const { timingSafeCompare } = require("../services/currencyService");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const salesService = require("../services/salesService");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "salesApi" });

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

function ensureAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    writeJson(res, 503, { error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  if (!timingSafeCompare(req.headers["x-admin-secret"], secret)) {
    writeJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

const paymentMethodEnum = z.enum([
  "cash",
  "card",
  "transfer",
  "mercadopago",
  "pago_movil",
  "other",
  "unknown",
]);

const createBodySchema = z.object({
  source: z.enum(["mostrador", "social_media"]),
  customer_id: z.number().int().positive().optional(),
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price_usd: z.number().positive(),
      })
    )
    .min(1),
  notes: z.string().max(2000).optional(),
  sold_by: z.string().max(100).optional(),
  status: z.enum(["pending", "paid", "pending_payment"]).optional(),
  external_order_id: z.string().min(1).max(200).optional(),
  payment_method: paymentMethodEnum.optional(),
  identity_external_id: z.string().min(1).max(255).optional(),
  company_id: z.number().int().positive().optional(),
});

const patchBodySchema = z.object({
  status: z.enum(["paid", "cancelled", "shipped"]),
});

const importMlBodySchema = z.object({
  ml_user_id: z.number().int().positive(),
  order_id: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
});

function parseSalesPath(pathname) {
  const base = "/api/sales";
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  const trimmed = rest.replace(/^\/+|\/+$/g, "");
  return trimmed;
}

async function handleSalesApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/sales")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const segment = parseSalesPath(pathname);

  try {
    if (req.method === "GET" && (pathname === "/api/sales/stats" || segment === "stats")) {
      if (!ensureAdmin(req, res)) return true;
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const stats = await salesService.getSalesStats({ from, to });
      writeJson(res, 200, { data: stats, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/sales" || pathname === "/api/sales/")) {
      if (!ensureAdmin(req, res)) return true;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const source = url.searchParams.get("source") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const out = await salesService.listSalesOrders({
        limit: limit != null ? Number(limit) : undefined,
        offset: offset != null ? Number(offset) : undefined,
        source,
        status,
        from,
        to,
      });
      writeJson(res, 200, {
        data: out.rows,
        meta: {
          total: out.total,
          limit: out.limit,
          offset: out.offset,
          timestamp: new Date().toISOString(),
        },
      });
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/sales/import/ml" || segment === "import/ml")) {
      if (!ensureAdmin(req, res)) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(importMlBodySchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      if (d.order_id != null) {
        const data = await salesService.importSalesOrderFromMlOrder({
          mlUserId: d.ml_user_id,
          orderId: d.order_id,
        });
        writeJson(res, data.idempotent ? 200 : 201, {
          data,
          meta: { timestamp: new Date().toISOString() },
        });
      } else {
        const data = await salesService.importSalesOrdersFromMlTable({
          mlUserId: d.ml_user_id,
          limit: d.limit,
          offset: d.offset,
        });
        writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      }
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/sales/create" || segment === "create")) {
      if (!ensureAdmin(req, res)) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(createBodySchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      const created = await salesService.createOrder({
        source: d.source,
        customerId: d.customer_id,
        items: d.items,
        notes: d.notes,
        soldBy: d.sold_by,
        status: d.status,
        externalOrderId: d.external_order_id,
        paymentMethod: d.payment_method,
        identityExternalId: d.identity_external_id,
        companyId: d.company_id,
      });
      const code = created.idempotent ? 200 : 201;
      writeJson(res, code, {
        data: created,
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    }

    if (req.method === "GET" && segment && /^\d+$/.test(segment)) {
      if (!ensureAdmin(req, res)) return true;
      const id = Number(segment);
      const row = await salesService.getSalesOrderById(id);
      writeJson(res, 200, { data: row, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "PATCH" && segment && /^\d+$/.test(segment)) {
      if (!ensureAdmin(req, res)) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(patchBodySchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const id = Number(segment);
      const updated = await salesService.patchSalesOrderStatus(id, parsed.data.status);
      writeJson(res, 200, { data: updated, meta: { timestamp: new Date().toISOString() } });
      return true;
    }
  } catch (e) {
    if (e && e.code === "NOT_FOUND") {
      writeJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    if ((e && e.code === "SALES_SCHEMA_MISSING") || (e && e.code === "42P01")) {
      writeJson(res, 503, {
        error: "schema_missing",
        detail: "Migraciones: npm run db:sales && npm run db:sales-ml && npm run db:sales-global",
      });
      return true;
    }
    if (e && e.code === "LOYALTY_SCHEMA_MISSING") {
      writeJson(res, 503, { error: "loyalty_schema_missing", detail: "Ejecutar sql/20260408_loyalty.sql" });
      return true;
    }
    if (e && e.code === "IMPORT_DISABLED") {
      writeJson(res, 503, {
        error: "import_disabled",
        detail: "Definir SALES_ML_IMPORT_ENABLED=1 (y migración npm run db:sales-ml si aplica)",
      });
      return true;
    }
    if (e && e.code === "42703") {
      writeJson(res, 503, {
        error: "schema_missing",
        detail: "Ejecutar npm run db:sales-ml (columnas applies_stock / records_cash)",
      });
      return true;
    }
    if (e && e.code === "INSUFFICIENT_STOCK") {
      writeJson(res, 409, { error: "insufficient_stock", message: String(e.message) });
      return true;
    }
    if (e && e.code === "INVALID_TRANSITION") {
      writeJson(res, 409, { error: "invalid_transition", message: String(e.message) });
      return true;
    }
    if (e && e.code === "INSUFFICIENT_POINTS") {
      writeJson(res, 409, { error: "insufficient_points", message: String(e.message) });
      return true;
    }
    if (e && e.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: String(e.message) });
      return true;
    }
    logger.error({ err: e }, "sales_api_error");
    writeJson(res, 500, { error: "error", message: String(e.message) });
    return true;
  }

  writeJson(res, 404, { error: "not_found" });
  return true;
}

module.exports = { handleSalesApiRequest };
