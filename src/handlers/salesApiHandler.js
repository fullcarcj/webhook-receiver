"use strict";

const { z } = require("zod");
const pino = require("pino");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const salesService = require("../services/salesService");
const orderService = require("../services/orderService");

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

const paymentMethodEnum = z.enum([
  "cash",
  "card",
  "transfer",
  "mercadopago",
  "pago_movil",
  "other",
  "unknown",
  "zelle",
  "binance",
  "usd",
  "efectivo",
  "efectivo_bs",
  "panama",
  "credito",
]);

const createBodySchema = z.object({
  source: z.enum(["mostrador", "social_media", "ecommerce", "mercadolibre", "fuerza_ventas"]),
  /** channel_id explícito (1-5). Si se omite se infiere desde source en salesService. */
  channel_id: z.number().int().min(1).max(5).optional(),
  customer_id: z.number().int().positive().optional(),
  /** CH-05 fuerza_ventas: obligatorio en el servicio si source='fuerza_ventas' */
  seller_id: z.number().int().positive().optional(),
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price_usd: z.number().positive(),
        selected_components: z
          .array(
            z.object({
              bundle_id: z.number().int().positive(),
              selected_product_id: z.number().int().positive().optional(),
            })
          )
          .optional(),
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
  zone_id: z.number().int().positive().optional(),
  /** Monto cobrado (misma unidad que el medio: USD para Zelle, Bs para efectivo_bs si aplica) */
  payment_amount: z.number().positive().optional(),
  exchange_rate: z.number().positive().optional(),
  proof_url: z.string().url().optional().or(z.literal("")),
});

const quoteCreateSchema = z.object({
  source: z.enum(["mostrador", "social_media", "mercadolibre", "ecommerce"]),
  customer_id: z.number().int().positive().optional(),
  currency: z.enum(["BS", "USD"]).default("BS").optional(),
  items: z
    .array(
      z.object({
        sku: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_price_usd: z.number().positive(),
      })
    )
    .min(1),
});

const patchBodySchema = z.object({
  status: z.enum(["paid", "cancelled", "shipped"]),
});

const importMlBodySchema = z
  .object({
    ml_user_id: z.number().int().positive().optional(),
    /** Lote: importar candidatos de todas las cuentas en `ml_accounts` (no usar con `ml_user_id`). */
    all_accounts: z.boolean().optional(),
    order_id: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(500).optional(),
    offset: z.number().int().nonnegative().optional(),
    /** Solo importación por lotes (sin order_id). Filtra `ml_orders` por feedback pendiente. */
    ml_feedback_filter: z
      .enum([
        "none",
        "feedback_sale_pending",
        "feedback_purchase_pending",
        "feedback_any_pending",
        "feedback_both_pending",
        "feedback_purchase_strict",
        "feedback_sale_strict",
        "feedback_any_strict",
        "feedback_both_strict",
      ])
      .optional(),
  })
  .superRefine((data, ctx) => {
    const hasOrder = data.order_id != null;
    const hasUser = data.ml_user_id != null;
    const all = data.all_accounts === true;
    if (hasOrder && !hasUser) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "order_id requiere ml_user_id" });
    }
    if (hasOrder && all) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "order_id no se combina con all_accounts" });
    }
    if (!hasOrder) {
      if (!all && !hasUser) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Indicá ml_user_id o all_accounts: true" });
      }
      if (all && hasUser) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "No combines all_accounts con ml_user_id" });
      }
    }
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
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const stats = await salesService.getSalesStats({ from, to });
      writeJson(res, 200, { data: stats, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "GET" && (pathname === "/api/sales" || pathname === "/api/sales/")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const source = url.searchParams.get("source") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const includeCompleted = url.searchParams.get("include_completed") === "1";
      const out = await salesService.listSalesOrders({
        limit: limit != null ? Number(limit) : undefined,
        offset: offset != null ? Number(offset) : undefined,
        source,
        status,
        from,
        to,
        excludeCompleted: !includeCompleted,
      });
      writeJson(res, 200, {
        data: out.rows,
        meta: {
          total: out.total,
          limit: out.limit,
          offset: out.offset,
          exclude_completed_default: !includeCompleted,
          timestamp: new Date().toISOString(),
        },
      });
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/sales/import/ml" || segment === "import/ml")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
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
          allAccounts: d.all_accounts === true,
          mlUserId: d.ml_user_id,
          limit: d.limit,
          offset: d.offset,
          mlFeedbackFilter: d.ml_feedback_filter,
        });
        writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      }
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/sales/create" || segment === "create")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
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
      try {
        const { calculatePrice } = require("../services/priceEngineService");
        const quoteCurrency = "BS";
        for (const it of d.items || []) {
          const calc = await calculatePrice({
            baseUsd: Number(it.unit_price_usd),
            channel: d.source,
            customerId: d.customer_id,
          });
          it.price_engine = quoteCurrency === "BS" ? calc.prices.price_bs_bcv : calc.prices.price_usd;
        }
      } catch (_) {
        // Motor de precios no bloqueante para createOrder mientras despliegues migraciones.
      }
      const created = await salesService.createOrder({
        source: d.source,
        channelId: d.channel_id,
        sellerId: d.seller_id,
        customerId: d.customer_id,
        items: d.items,
        notes: d.notes,
        soldBy: d.sold_by,
        status: d.status,
        externalOrderId: d.external_order_id,
        paymentMethod: d.payment_method,
        identityExternalId: d.identity_external_id,
        companyId: d.company_id,
        zoneId: d.zone_id,
        paymentAmount: d.payment_amount,
        exchangeRate: d.exchange_rate,
        proofUrl: d.proof_url,
      });
      const code = created.idempotent ? 200 : 201;
      writeJson(res, code, {
        data: created,
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/quotes/create") {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(quoteCreateSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      const { calculatePrice } = require("../services/priceEngineService");
      const items = [];
      let total_bs = 0;
      let total_usd = 0;
      for (const it of d.items) {
        const calc = await calculatePrice({
          baseUsd: Number(it.unit_price_usd),
          channel: d.source,
          customerId: d.customer_id,
        });
        const unit_bs = Number(calc.prices.price_bs_bcv || calc.prices.price_bs_binance || 0);
        const unit_usd = Number(calc.prices.price_usd || 0);
        const line_bs = Number((unit_bs * Number(it.quantity)).toFixed(2));
        const line_usd = Number((unit_usd * Number(it.quantity)).toFixed(2));
        total_bs += line_bs;
        total_usd += line_usd;
        items.push({
          sku: it.sku,
          quantity: it.quantity,
          base_usd: it.unit_price_usd,
          unit_price_usd: unit_usd,
          unit_price_bs: unit_bs,
          line_total_usd: line_usd,
          line_total_bs: line_bs,
          pricing: calc,
        });
      }
      writeJson(res, 201, {
        data: {
          source: d.source,
          customer_id: d.customer_id || null,
          currency: d.currency || "BS",
          total_usd: Number(total_usd.toFixed(2)),
          total_bs: Number(total_bs.toFixed(2)),
          items,
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    }

    if (req.method === "GET" && (segment === "alerts/pending" || pathname === "/api/sales/alerts/pending")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const type = url.searchParams.get("type") || "all";
      const data = await orderService.listPendingRatingAlerts(type);
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const historyMatch = segment && segment.match(/^(\d+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const id = Number(historyMatch[1]);
      const rows = await orderService.getOrderHistory(id);
      writeJson(res, 200, { data: rows, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const statusMatch = segment && segment.match(/^(\d+)\/status$/);
    if (req.method === "PATCH" && statusMatch) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const id = Number(statusMatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const updated = await orderService.updateOrderStatus(id, body);
      writeJson(res, 200, { data: updated, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "GET" && segment && /^\d+$/.test(segment)) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const id = Number(segment);
      const row = await salesService.getSalesOrderById(id);
      writeJson(res, 200, { data: row, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "PATCH" && segment && /^\d+$/.test(segment)) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
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
    if (e && e.code === "VALIDATION_ERROR") {
      writeJson(res, e.status || 400, {
        error: "VALIDATION_ERROR",
        details: e.errors || [],
      });
      return true;
    }
    if (e && e.code === "INVALID_STATUS_TRANSITION") {
      writeJson(res, 422, {
        error: "INVALID_STATUS_TRANSITION",
        message: String(e.message || ""),
      });
      return true;
    }
    if (e && e.code === "NOT_FOUND") {
      writeJson(res, 404, { error: "NOT_FOUND" });
      return true;
    }
    if (e && e.code === "ZONE_NOT_FOUND") {
      writeJson(res, 404, { error: "zone_not_found", message: String(e.message || "") });
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
        detail:
          "Ejecutar migraciones de ventas; si faltan columnas de ciclo de vida: npm run db:orders-lifecycle. " +
          "También: npm run db:sales-ml (applies_stock / records_cash)",
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
