"use strict";

const { z } = require("zod");
const pino = require("pino");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const salesService = require("../services/salesService");
const orderService = require("../services/orderService");
const { pool } = require("../../db");
const botActionsService  = require("../services/botActionsService");
const exceptionsService  = require("../services/exceptionsService");
const botHandoffsService = require("../services/botHandoffsService");
const supervisorService  = require("../services/supervisorService");
const { resolveCustomer } = require("../services/resolveCustomer");
const sseBroker          = require("../realtime/sseBroker");
const slaTimerManager    = require("../services/slaTimerManager");
const { transition: smTransition, EVENTS: SM_EVENTS } = require("../services/crmChatStateMachine");
const { resolveMlPackFromSaleId } = require("../services/salesMlPackMessaging");
const { manualBankLinkToleranceBs } = require("../utils/manualBankLinkTolerance");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "salesApi" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Respuesta de mercadoLibrePostJsonForUser / mercadoLibreFetchForUser (sin token). */
function mlPackApiErrorDetail(mlRes) {
  if (!mlRes || typeof mlRes !== "object") return {};
  const d = mlRes.data;
  let mlMessage = null;
  let mlError = null;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    if (d.message != null) mlMessage = String(d.message);
    if (d.error != null) mlError = String(d.error);
    if (d.cause && typeof d.cause === "object" && d.cause.message != null) {
      mlMessage = mlMessage || String(d.cause.message);
    }
  }
  return {
    http_status: mlRes.status,
    ml_path: mlRes.path,
    ml_error: mlError,
    ml_message: mlMessage,
    body_preview:
      typeof mlRes.rawText === "string" && mlRes.rawText.length > 0
        ? mlRes.rawText.slice(0, 2000)
        : null,
  };
}

/** Texto único para toasts que solo leen `error` (evita mostrar solo "not_found"). */
function buildMlPackResolveUserError(ctx) {
  const base = ctx.message != null ? String(ctx.message) : "Error al resolver mensajería ML.";
  const d = ctx.detail;
  if (!d || typeof d !== "object") return base;
  const extra = [];
  if (d.hint) extra.push(String(d.hint));
  if (d.external_order_id != null) extra.push(`external_order_id=${d.external_order_id}`);
  if (d.sale_id_requested != null) extra.push(`sale_id=${d.sale_id_requested}`);
  if (d.parsed_ml_order_id != null) extra.push(`order_id_ml=${d.parsed_ml_order_id}`);
  if (d.ml_user_id != null) extra.push(`ml_user_id=${d.ml_user_id}`);
  if (d.ml_orders_row_found === false) extra.push("sin fila en ml_orders para esa cuenta y orden");
  if (d.lookup) extra.push(`consulta=${d.lookup}`);
  if (d.source) extra.push(`source=${d.source}`);
  if (extra.length === 0) return base;
  return `${base} — ${extra.join(" · ")}`;
}

function buildMlPackSyncUserMessage(syncMeta) {
  if (!syncMeta || typeof syncMeta !== "object") return null;
  if (syncMeta.skipped) {
    return syncMeta.hint != null ? String(syncMeta.hint) : "Sincronización omitida.";
  }
  if (syncMeta.ok === false) {
    const parts = [syncMeta.error != null ? String(syncMeta.error) : "Error al sincronizar mensajes con ML"];
    if (syncMeta.ml_message) parts.push(String(syncMeta.ml_message));
    if (syncMeta.ml_error) parts.push(String(syncMeta.ml_error));
    if (syncMeta.http_status != null) parts.push(`HTTP ${syncMeta.http_status}`);
    if (syncMeta.ml_path) parts.push(String(syncMeta.ml_path));
    return parts.join(" — ");
  }
  return null;
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
  "ves_banesco",
  "ves_bdv",
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
  /**
   * Costo carrera al cliente en Bs. (opcional). Solo con `zone_id`: si se omite se usa el precio de lista de la zona.
   */
  delivery_client_price_bs: z.number().positive().max(99999999).optional(),
  /** Monto cobrado (misma unidad que el medio: USD para Zelle, Bs para efectivo_bs si aplica) */
  payment_amount: z.number().positive().optional(),
  exchange_rate: z.number().positive().optional(),
  proof_url: z.string().url().optional().or(z.literal("")),
  /** Mostrador sin customer_id: doc, teléfono o consumidor_final */
  id_type: z.enum(["V", "E", "J", "G", "P"]).optional(),
  id_number: z.string().max(32).optional(),
  phone: z.string().max(80).optional(),
  consumidor_final: z.boolean().optional(),
  /** ID de crm_chats · vincula la orden al chat de origen (opcional) */
  conversation_id: z.number().int().positive().optional(),
})
  .superRefine((data, ctx) => {
    if (data.delivery_client_price_bs != null && data.zone_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "delivery_client_price_bs requiere zone_id",
        path: ["delivery_client_price_bs"],
      });
    }
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

const patchFulfillmentBodySchema = z.object({
  /** Clave canónica o `null` para limpiar. */
  fulfillment_type: z.union([z.string().max(64), z.null()]),
});

const patchPaymentMethodBodySchema = z.object({
  /** Mismo catálogo que `payment_method` en POST /api/sales; `null` limpia. */
  payment_method: z.union([paymentMethodEnum, z.null()]),
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

/** `sales_orders.id` desde el id de listado unificado (`123` o `so-123`). `pos-*` u otros → NaN. */
function mlPackPathSalePkFromCapture(idPart) {
  const s = String(idPart ?? "").trim();
  if (/^so-\d+$/i.test(s)) return Number(s.slice(3));
  if (/^\d+$/.test(s)) return Number(s);
  return NaN;
}

/** `sales_orders` no tiene `company_id` en todas las migraciones; se usa el de `customers` o env. */
function resolveSalesCompanyIdFromUrl(url) {
  const raw = url.searchParams.get("company_id");
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Number(process.env.SALES_CURRENCY_COMPANY_ID || "1") || 1;
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
      const lifecycleStage = url.searchParams.get("lifecycle_stage") || undefined;
      const out = await salesService.listSalesOrders({
        limit: limit != null ? Number(limit) : undefined,
        offset: offset != null ? Number(offset) : undefined,
        source,
        status,
        from,
        to,
        excludeCompleted: !includeCompleted,
        lifecycleStage,
      });
      writeJson(res, 200, {
        data: out.rows,
        lifecycle_summary: out.lifecycle_summary,
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

    /** GET /api/sales/resolve-ml-order?ml_order_id= — id unificado `so-*` para pack ML (bandeja → pedidos). */
    if (req.method === "GET" && segment === "resolve-ml-order") {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const rawOid = url.searchParams.get("ml_order_id");
      const oidStr = rawOid != null ? String(rawOid).trim() : "";
      if (!/^\d{5,20}$/.test(oidStr)) {
        writeJson(res, 400, {
          code: "BAD_ML_ORDER_ID",
          error: "ml_order_id debe ser un número de orden ML (solo dígitos).",
        });
        return true;
      }
      const { rows } = await pool.query(
        `SELECT ('so-' || so.id::text) AS id, so.external_order_id
         FROM sales_orders so
         WHERE so.source = 'mercadolibre'
           AND so.external_order_id ~ '^[0-9]+-[0-9]+$'
           AND split_part(so.external_order_id, '-', 2)::bigint = $1::bigint
         ORDER BY so.updated_at DESC NULLS LAST, so.id DESC
         LIMIT 1`,
        [oidStr]
      );
      if (!rows.length) {
        writeJson(res, 404, {
          code: "NOT_FOUND",
          error: "No hay venta importada en ERP para esa orden de Mercado Libre.",
          message: "Importá la orden o sincronizá ventas ML.",
        });
        return true;
      }
      writeJson(res, 200, {
        data: {
          id: rows[0].id,
          external_order_id: rows[0].external_order_id != null ? String(rows[0].external_order_id) : null,
        },
        meta: { timestamp: new Date().toISOString() },
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
        // force:true: el admin pidió una orden puntual — importar sin importar su antigüedad.
        const data = await salesService.importSalesOrderFromMlOrder({
          mlUserId: d.ml_user_id,
          orderId: d.order_id,
          force: true,
        });
        if (!data.idempotent) {
          try {
            sseBroker.broadcast("new_sale", {
              sales_order_id: data.id,
              ml_user_id: d.ml_user_id,
              order_id: d.order_id,
              external_order_id:
                data.external_order_id != null ? String(data.external_order_id) : null,
              source: "sales_import_ml",
            });
          } catch (_e) {
            /* no crítico */
          }
        }
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

    /** POST /api/sales/ml/reconcile — detecta huérfanos en ml_orders sin sales_orders e importa. */
    if (req.method === "POST" && (pathname === "/api/sales/ml/reconcile" || segment === "ml/reconcile")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      let body = {};
      try { body = await parseJsonBody(req); } catch (_e) { /* body opcional */ }
      const dryRun = body.dry_run === true || String(body.dry_run ?? "").toLowerCase() === "true";
      const allAccounts = body.all_accounts === true || String(body.all_accounts ?? "").toLowerCase() === "true";
      const mlUserId = body.ml_user_id != null ? Number(body.ml_user_id) : undefined;
      const limit = body.limit != null ? Number(body.limit) : undefined;
      if (!allAccounts && (mlUserId == null || !Number.isFinite(mlUserId) || mlUserId <= 0)) {
        writeJson(res, 400, { error: "bad_request", message: "Requerido: ml_user_id (número) o all_accounts:true" });
        return true;
      }
      const result = await salesService.reconcileMlSalesOrphans({
        mlUserId,
        allAccounts,
        dryRun,
        limit,
        verbose: body.verbose === true,
      });
      writeJson(res, 200, { data: result, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    /** POST /api/sales/ml/feedback — calificación del vendedor hacia el comprador (API ML). */
    if (req.method === "POST" && (pathname === "/api/sales/ml/feedback" || segment === "ml/feedback")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const mlUserId = body.ml_user_id != null ? Number(body.ml_user_id) : NaN;
      const orderId = body.order_id != null ? Number(body.order_id) : NaN;
      if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
        writeJson(res, 400, {
          error: "bad_request",
          message: "Requeridos: ml_user_id (número) y order_id (número de orden ML)",
        });
        return true;
      }
      try {
        const data = await salesService.postMlSellerOrderFeedback({
          mlUserId,
          orderId,
          fulfilled: body.fulfilled !== false && String(body.fulfilled ?? "").toLowerCase() !== "false",
          rating: body.rating != null ? String(body.rating) : "positive",
          message: body.message,
          reason: body.reason,
          restock_item: body.restock_item === true || String(body.restock_item ?? "").toLowerCase() === "true",
        });
        writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      } catch (e) {
        if (e && e.code === "BAD_REQUEST") {
          writeJson(res, 400, { error: "bad_request", message: e.message || "Solicitud inválida" });
          return true;
        }
        if (e && e.code === "ML_HTTP") {
          const st = Number(e.httpStatus) >= 400 && Number(e.httpStatus) < 600 ? Number(e.httpStatus) : 502;
          writeJson(res, st, {
            error: "ml_feedback_failed",
            message: e.message || "Mercado Libre rechazó la calificación",
            detail: e.detail || null,
          });
          return true;
        }
        throw e;
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
        deliveryClientPriceBs: d.delivery_client_price_bs,
        paymentAmount: d.payment_amount,
        exchangeRate: d.exchange_rate,
        proofUrl: d.proof_url,
        id_type: d.id_type,
        id_number: d.id_number,
        phone: d.phone,
        consumidor_final: d.consumidor_final,
        conversationId: d.conversation_id ?? null,
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

    const mResolvedCustomer = segment && segment.match(/^(\d+)\/resolved-customer\/?$/i);
    if (req.method === "GET" && mResolvedCustomer) {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const saleId = Number(mResolvedCustomer[1]);
      const companyId = resolveSalesCompanyIdFromUrl(url);
      const { rows } = await pool.query(
        `SELECT so.id,
                so.customer_id,
                so.source AS sale_source,
                c.id AS cid,
                c.full_name,
                c.phone,
                c.id_type,
                c.id_number
         FROM sales_orders so
         LEFT JOIN customers c ON c.id = so.customer_id AND c.company_id = $2
         WHERE so.id = $1`,
        [saleId, companyId]
      );
      if (!rows.length) {
        writeJson(res, 404, { code: "SALE_NOT_FOUND" });
        return true;
      }
      const r = rows[0];
      if (r.customer_id != null && r.cid == null) {
        writeJson(res, 404, { code: "SALE_NOT_FOUND" });
        return true;
      }
      if (r.customer_id == null || r.cid == null) {
        writeJson(res, 200, { resolved: false, customer: null });
        return true;
      }
      writeJson(res, 200, {
        resolved: true,
        customer: {
          id: r.cid,
          full_name: r.full_name,
          phone: r.phone,
          id_type: r.id_type,
          id_number: r.id_number,
        },
      });
      return true;
    }

    const mResolveCustomer = segment && segment.match(/^(\d+)\/resolve-customer\/?$/i);
    if (req.method === "POST" && mResolveCustomer) {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const saleId = Number(mResolveCustomer[1]);
      const companyId = resolveSalesCompanyIdFromUrl(url);
      const { rows: orows } = await pool.query(
        `SELECT so.id,
                so.customer_id,
                so.source,
                so.ml_user_id,
                so.external_order_id,
                cu.id AS cu_id,
                mo.buyer_id AS ml_buyer_id,
                mb.phone_1 AS buyer_phone,
                mb.nickname,
                mb.nombre_apellido
         FROM sales_orders so
         LEFT JOIN customers cu ON cu.id = so.customer_id AND cu.company_id = $2
         LEFT JOIN ml_orders mo ON so.source = 'mercadolibre'
           AND so.ml_user_id IS NOT NULL
           AND so.external_order_id ~ '^[0-9]+-[0-9]+$'
           AND mo.ml_user_id = so.ml_user_id
           AND mo.order_id = split_part(so.external_order_id, '-', 2)::bigint
         LEFT JOIN ml_buyers mb ON mb.buyer_id = mo.buyer_id
         WHERE so.id = $1`,
        [saleId, companyId]
      );
      if (!orows.length) {
        writeJson(res, 404, { code: "SALE_NOT_FOUND" });
        return true;
      }
      const o = orows[0];
      if (o.customer_id != null && o.cu_id == null) {
        writeJson(res, 404, { code: "SALE_NOT_FOUND" });
        return true;
      }
      if (o.customer_id != null) {
        writeJson(res, 200, {
          resolved: true,
          already_had_customer: true,
          customer_id: Number(o.customer_id),
        });
        return true;
      }
      const buyerId = o.ml_buyer_id != null ? Number(o.ml_buyer_id) : NaN;
      if (!Number.isFinite(buyerId) || buyerId <= 0) {
        writeJson(res, 422, {
          code: "NO_BUYER_DATA",
          message: "Esta orden no tiene datos de comprador para resolver",
        });
        return true;
      }
      const nameFromMl =
        (o.nombre_apellido && String(o.nombre_apellido).trim()) ||
        (o.nickname && String(o.nickname).trim()) ||
        null;
      try {
        const resolved = await resolveCustomer(
          {
            source: "mercadolibre",
            external_id: String(buyerId),
            data: {
              ml_buyer_id: buyerId,
              phone: o.buyer_phone || undefined,
              name: nameFromMl || undefined,
              company_id: companyId,
            },
          },
          { companyId }
        );
        const cid = Number(resolved.customerId);
        await pool.query(`UPDATE sales_orders SET customer_id = $1, updated_at = NOW() WHERE id = $2`, [
          cid,
          saleId,
        ]);
        writeJson(res, 200, {
          resolved: true,
          already_had_customer: false,
          customer_id: cid,
          match_level: resolved.matchLevel,
        });
      } catch (err) {
        console.error("[sales/resolve] failed", {
          sale_id: saleId,
          buyer_id: buyerId,
          error: err && err.message,
        });
        writeJson(res, 500, {
          code: "IDENTITY_RESOLUTION_FAILED",
          message: "No se pudo resolver el cliente. Verifique datos del comprador.",
        });
      }
      return true;
    }

    /** GET /api/sales/:id/ml-pack-messages — historial pack ML (BD); ?sync=1 refresca desde API ML */
    const mlPackMsgMatch = segment && segment.match(/^(\d+|so-\d+)\/ml-pack-messages\/?$/i);
    if (req.method === "GET" && mlPackMsgMatch) {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const saleId = mlPackPathSalePkFromCapture(mlPackMsgMatch[1]);
      const ctx = await resolveMlPackFromSaleId(saleId);
      if (!ctx.ok) {
        const st = ctx.code === "NOT_FOUND" ? 404 : 422;
        writeJson(res, st, {
          ok: false,
          code: ctx.code,
          error: buildMlPackResolveUserError(ctx),
          error_slug: String(ctx.code || "").toLowerCase(),
          message: ctx.message,
          detail: ctx.detail != null ? ctx.detail : undefined,
        });
        return true;
      }
      const sync = url.searchParams.get("sync") === "1" || url.searchParams.get("sync") === "true";
      let syncMeta = null;
      if (sync) {
        const { syncPackMessagesForOrder, resolveMlPackApplicationId } = require("../../ml-pack-messages-sync");
        const tag = (process.env.ML_PACK_MESSAGES_SYNC_TAG || "post_sale").trim() || "post_sale";
        const appId = resolveMlPackApplicationId();
        const pageSize = Math.min(
          100,
          Math.max(1, Number(process.env.ML_PACK_MESSAGES_SYNC_PAGE_SIZE) || 50)
        );
        const delayMs = Math.max(0, Number(process.env.ML_PACK_MESSAGES_SYNC_DELAY_MS) || 0);
        syncMeta = await syncPackMessagesForOrder(ctx.ml_user_id, ctx.ml_order_id, {
          tag,
          appId,
          pageSize,
          delayMs,
        });
      }
      const { listMlOrderPackMessagesByUser } = require("../../db");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 300));
      const rows = await listMlOrderPackMessagesByUser(ctx.ml_user_id, limit, {
        order_id: ctx.ml_order_id,
      });
      const chronological = [...rows].reverse();
      const syncUserMsg = syncMeta != null ? buildMlPackSyncUserMessage(syncMeta) : null;
      writeJson(res, 200, {
        data: {
          messages: chronological,
          ml_order_id: ctx.ml_order_id,
          ml_user_id: ctx.ml_user_id,
          buyer_id: ctx.buyer_id,
          chat_id: ctx.chat_id,
          external_order_id: ctx.external_order_id,
        },
        meta: {
          timestamp: new Date().toISOString(),
          ...(syncMeta != null ? { sync: syncMeta } : {}),
          ...(syncUserMsg ? { sync_error: syncUserMsg } : {}),
        },
      });
      return true;
    }

    /** POST /api/sales/:id/ml-pack-messages/send — envío post_sale vía API ML (texto; adjuntos no soportados aún) */
    const mlPackSendMatch = segment && segment.match(/^(\d+|so-\d+)\/ml-pack-messages\/send\/?$/i);
    if (req.method === "POST" && mlPackSendMatch) {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const saleId = mlPackPathSalePkFromCapture(mlPackSendMatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const text = body && body.text != null ? String(body.text).trim() : "";
      if (!text) {
        writeJson(res, 400, { code: "MISSING_TEXT", message: "El texto es obligatorio" });
        return true;
      }
      if (text.length > 350) {
        writeJson(res, 400, {
          code: "TEXT_TOO_LONG",
          message: "Máximo 350 caracteres (límite ML post_sale)",
        });
        return true;
      }
      const ctx = await resolveMlPackFromSaleId(saleId);
      if (!ctx.ok) {
        const st = ctx.code === "NOT_FOUND" ? 404 : 422;
        writeJson(res, st, {
          ok: false,
          code: ctx.code,
          error: buildMlPackResolveUserError(ctx),
          error_slug: String(ctx.code || "").toLowerCase(),
          message: ctx.message,
          detail: ctx.detail != null ? ctx.detail : undefined,
        });
        return true;
      }
      const crypto = require("crypto");
      const { mercadoLibrePostJsonForUser } = require("../../oauth-token");
      const { resolveMlPackApplicationId } = require("../../ml-pack-messages-sync");
      const appId = resolveMlPackApplicationId();
      const q = new URLSearchParams({ application_id: appId, tag: "post_sale" });
      const path = `/messages/packs/${ctx.ml_order_id}/sellers/${ctx.ml_user_id}?${q.toString()}`;
      const mlRes = await mercadoLibrePostJsonForUser(ctx.ml_user_id, path, {
        from: { user_id: ctx.ml_user_id },
        to: { user_id: ctx.buyer_id },
        option_id: "OTHER",
        text,
      });
      const okHttp = mlRes.ok && (mlRes.status === 200 || mlRes.status === 201);
      if (!okHttp) {
        logger.warn({ saleId, status: mlRes.status }, "sales ml-pack send failed");
        const apiBits = mlPackApiErrorDetail(mlRes);
        const dSend = {
          sale_id: saleId,
          ml_user_id: ctx.ml_user_id,
          ml_order_id: ctx.ml_order_id,
          buyer_id: ctx.buyer_id,
          ...apiBits,
        };
        const sendUserErr = [
          "Mercado Libre rechazó el envío o hubo error de red.",
          apiBits.http_status != null ? `HTTP ${apiBits.http_status}` : null,
          apiBits.ml_message,
          apiBits.ml_error,
          apiBits.ml_path,
        ]
          .filter(Boolean)
          .join(" ");
        writeJson(res, 502, {
          ok: false,
          code: "ML_SEND_FAILED",
          error: sendUserErr,
          message: "Mercado Libre rechazó el envío o hubo error de red",
          detail: dSend,
        });
        return true;
      }

      if (ctx.chat_id != null) {
        const extId = `ml_sale_${saleId}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
        const answeredBy =
          body.answered_by != null && String(body.answered_by).trim() !== ""
            ? String(body.answered_by).trim()
            : "ventas_pedidos";
        await pool.query(
          `INSERT INTO crm_messages (
             chat_id, external_message_id, direction, type, content,
             sent_by, is_read, created_at
           ) VALUES (
             $1, $2, 'outbound', 'text', $3::jsonb,
             $4, true, NOW()
           )
           ON CONFLICT (external_message_id) DO NOTHING`,
          [ctx.chat_id, extId, JSON.stringify({ text, source: "ventas_ml_pack" }), answeredBy]
        );
        await pool.query(
          `UPDATE crm_chats SET
             last_message_text = $1,
             last_message_at = NOW(),
             updated_at = NOW()
           WHERE id = $2`,
          [text.slice(0, 5000), ctx.chat_id]
        );
      }

      writeJson(res, 200, {
        ok: true,
        data: { ml_order_id: ctx.ml_order_id, chat_id: ctx.chat_id },
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    }

    if (req.method === "GET" && segment && /^(\d+|pos-\d+|so-\d+)$/i.test(segment)) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const row = await salesService.getSalesOrderById(segment);
      writeJson(res, 200, { data: row, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // ─── BE-1.6 · POST /api/sales/chats/:chatId/take-over (D2 · ADR-009) ────────
    // Vendedor toma una conversación del bot.
    // Orden estricto: state machine primero → bot_handoffs → COMMIT → SSE/SLA post-commit.
    const takeOverMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/take-over$/);
    if (takeOverMatch && req.method === "POST") {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const chatId = Number(takeOverMatch[1]);
      let body = {};
      try { body = await parseJsonBody(req); } catch (_) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;
      const user   = req._authUser || null;
      const userId = user?.id ?? null;
      if (!userId) {
        writeJson(res, 401, { error: "UNAUTHORIZED" }); return true;
      }

      const client = await pool.connect();
      let deadlineOut = null;
      let handoffId   = null;
      let agentName   = `Agente ${userId}`;
      try {
        await client.query("BEGIN");

        // Bloqueo pesimista + lectura del estado actual
        const { rows: chatRows } = await client.query(
          `SELECT * FROM crm_chats WHERE id = $1 FOR UPDATE`,
          [chatId]
        );
        if (!chatRows.length) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { error: "chat_not_found" }); return true;
        }
        const chat = chatRows[0];

        // Previene que un vendedor tome dos chats simultáneos en PENDING_RESPONSE
        const { rows: busyRows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM crm_chats
           WHERE assigned_to = $1 AND status = 'PENDING_RESPONSE' AND id <> $2`,
          [userId, chatId]
        );
        if (Number(busyRows[0].n) >= 1) {
          await client.query("ROLLBACK");
          writeJson(res, 409, {
            error: "PENDING_SLOT_BUSY",
            message: "Debes responder o liberar tu conversación actual antes de tomar una nueva.",
          }); return true;
        }

        // State machine primero (acepta UNASSIGNED, RE_OPENED, ATTENDED)
        let tr;
        try {
          tr = smTransition(chat, SM_EVENTS.TAKE, { userId });
        } catch (e) {
          await client.query("ROLLBACK");
          writeJson(res, 409, {
            error: "INVALID_TRANSITION",
            message: "Este chat no se puede tomar en su estado actual.",
            current_status: chat.status,
          }); return true;
        }

        // Aplicar resultado de state machine
        await client.query(
          `UPDATE crm_chats
           SET status = $1, assigned_to = $2, sla_deadline_at = $3, updated_at = NOW()
           WHERE id = $4`,
          [tr.nextStatus, tr.assignedTo, tr.slaDeadlineAt, chatId]
        );
        deadlineOut = tr.slaDeadlineAt;

        // Verificar que no haya handoff activo (integridad — cubre carreras de red)
        const { rows: hRows } = await client.query(
          `SELECT id, to_user_id FROM bot_handoffs WHERE chat_id = $1 AND ended_at IS NULL`,
          [chatId]
        );
        if (hRows.length > 0) {
          await client.query("ROLLBACK");
          writeJson(res, 409, {
            error: "handoff_already_active",
            message: `Chat ya tomado por usuario ${hRows[0].to_user_id}`,
            existing_handoff_id: hRows[0].id,
          }); return true;
        }

        // Nombre del agente para mensaje system
        const { rows: uRows } = await client.query(
          `SELECT COALESCE(NULLIF(TRIM(full_name),''), NULLIF(TRIM(username),''), 'Agente') AS n
           FROM users WHERE id = $1`, [userId]
        );
        if (uRows.length) agentName = uRows[0].n;

        // Insertar bot_handoff
        const { rows: hInsert } = await client.query(
          `INSERT INTO bot_handoffs (chat_id, from_bot, to_user_id, reason)
           VALUES ($1, TRUE, $2, $3)
           RETURNING id, started_at`,
          [chatId, userId, reason]
        );
        handoffId = hInsert[0].id;

        // Mensaje de auditoría en crm_messages (DB, dentro de tx — no es Wasender)
        await client.query(
          `INSERT INTO crm_messages (chat_id, type, content, created_at)
           VALUES ($1, 'system', $2, NOW())`,
          [chatId, `${agentName} se unió a la conversación`]
        );

        await client.query("COMMIT");
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
        if (err.code === "42P01") {
          writeJson(res, 503, { error: "schema_missing", detail: "npm run db:bot-handoffs" });
          return true;
        }
        logger.error({ err }, "take_over");
        writeJson(res, 500, { error: "internal_error" }); return true;
      } finally {
        client.release();
      }

      // Post-commit: SSE + SLA (fuera de tx, no críticos si fallan)
      if (deadlineOut) slaTimerManager.schedule(chatId, deadlineOut);
      sseBroker.broadcast("chat_taken", { chat_id: chatId, user_id: userId, user_name: agentName });
      sseBroker.broadcast("clear_notification", { chat_id: chatId });
      sseBroker.broadcast("sla_started", {
        chat_id:     chatId,
        deadline_at: deadlineOut instanceof Date ? deadlineOut.toISOString() : String(deadlineOut),
      });

      writeJson(res, 200, {
        data: {
          handoff_id:    handoffId,
          chat_id:       chatId,
          taken_by:      { id: userId, name: agentName },
          status:        "PENDING_RESPONSE",
          sla_deadline_at: deadlineOut instanceof Date ? deadlineOut.toISOString() : deadlineOut,
        },
      });
      return true;
    }

    // ─── BE-1.7 · POST /api/sales/chats/:chatId/return-to-bot (D2 · ADR-009) ───
    // Cierra el handoff activo y devuelve la conversación al bot.
    // Solo desde PENDING_RESPONSE. Cualquier vendedor con permiso puede devolver.
    const returnToBotMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/return-to-bot$/);
    if (returnToBotMatch && req.method === "POST") {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const chatId = Number(returnToBotMatch[1]);
      const user   = req._authUser || null;
      const userId = user?.id ?? null;

      const client = await pool.connect();
      let handoffId = null;
      let agentName = `Agente ${userId ?? "?"}`;
      try {
        await client.query("BEGIN");

        const { rows: chatRows } = await client.query(
          `SELECT * FROM crm_chats WHERE id = $1 FOR UPDATE`,
          [chatId]
        );
        if (!chatRows.length) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { error: "chat_not_found" }); return true;
        }
        const chat = chatRows[0];

        // Solo PENDING_RESPONSE puede devolver (D2 · ADR-009)
        if (chat.status !== "PENDING_RESPONSE") {
          await client.query("ROLLBACK");
          writeJson(res, 400, {
            error: "HANDOFF_INVALID_STATE",
            message: `Solo se puede devolver un chat en PENDING_RESPONSE (actual: ${chat.status})`,
            current_status: chat.status,
          }); return true;
        }

        // Aplicar transición directamente (cualquier vendedor puede devolver, no solo el asignado)
        await client.query(
          `UPDATE crm_chats
           SET status = 'UNASSIGNED', assigned_to = NULL, sla_deadline_at = NULL, updated_at = NOW()
           WHERE id = $1`,
          [chatId]
        );

        // Cerrar bot_handoff activo
        const { rows: hRows } = await client.query(
          `UPDATE bot_handoffs
           SET ended_at = NOW(), ended_by = $2
           WHERE chat_id = $1 AND ended_at IS NULL
           RETURNING id`,
          [chatId, userId]
        );
        if (!hRows.length) {
          // Sin handoff activo el bot ya tenía control — continuar de todas formas
          logger.warn({ chatId }, "return_to_bot: no hay handoff activo pero chat estaba PENDING_RESPONSE");
        } else {
          handoffId = hRows[0].id;
        }

        // Nombre del agente
        if (userId) {
          const { rows: uRows } = await client.query(
            `SELECT COALESCE(NULLIF(TRIM(full_name),''), NULLIF(TRIM(username),''), 'Agente') AS n
             FROM users WHERE id = $1`, [userId]
          );
          if (uRows.length) agentName = uRows[0].n;
        }

        await client.query(
          `INSERT INTO crm_messages (chat_id, type, content, created_at)
           VALUES ($1, 'system', $2, NOW())`,
          [chatId, `${agentName} devolvió la conversación al asistente automático`]
        );

        await client.query("COMMIT");
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
        if (err.code === "42P01") {
          writeJson(res, 503, { error: "schema_missing", detail: "npm run db:bot-handoffs" });
          return true;
        }
        logger.error({ err }, "return_to_bot");
        writeJson(res, 500, { error: "internal_error" }); return true;
      } finally {
        client.release();
      }

      // Post-commit: cancelar SLA + SSE
      slaTimerManager.cancel(chatId);
      sseBroker.broadcast("chat_released", { chat_id: chatId });

      writeJson(res, 200, {
        data: {
          handoff_id:  handoffId,
          chat_id:     chatId,
          returned_by: { id: userId, name: agentName },
          ended_at:    new Date().toISOString(),
        },
      });
      return true;
    }

    const mFulfillmentPatch = pathname.match(/^\/api\/sales\/(so-\d+|\d+)\/fulfillment$/i);
    if (req.method === "PATCH" && mFulfillmentPatch) {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(patchFulfillmentBodySchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const idPart = mFulfillmentPatch[1];
      const updated = await salesService.patchSalesOrderFulfillmentType(
        idPart,
        parsed.data.fulfillment_type
      );
      writeJson(res, 200, { data: updated, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const mPaymentMethodPatch = pathname.match(/^\/api\/sales\/(so-\d+|\d+)\/payment-method$/i);
    if (req.method === "PATCH" && mPaymentMethodPatch) {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(patchPaymentMethodBodySchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const idPartPm = mPaymentMethodPatch[1];
      const updatedPm = await salesService.patchSalesOrderPaymentMethod(
        idPartPm,
        parsed.data.payment_method
      );
      writeJson(res, 200, { data: updatedPm, meta: { timestamp: new Date().toISOString() } });
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
    if (e && e.code === "MISSING_IDENTITY_MOSTRADOR") {
      writeJson(res, 422, buildMissingMostradorIdentity422Body());
      return true;
    }
    if (e && e.code === "INVALID_ID_FORMAT") {
      writeJson(res, 422, {
        code: e.code,
        reason: e.reason != null ? String(e.reason) : "",
      });
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

  // ─── GET /api/sales/supervisor/kpis ─────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/sales/supervisor/kpis") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const data = await supervisorService.getSupervisorKPIs();
    writeJson(res, 200, data);
    return true;
  }

  // ─── GET /api/sales/supervisor/waiting ──────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/sales/supervisor/waiting") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const data = await supervisorService.getSupervisorWaiting();
    writeJson(res, 200, data);
    return true;
  }

  // ─── GET /api/sales/supervisor/exceptions ───────────────────────────────────
  if (req.method === "GET" && pathname === "/api/sales/supervisor/exceptions") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const data = await supervisorService.getSupervisorExceptions();
    writeJson(res, 200, data);
    return true;
  }

  // ─── GET /api/sales/chats/:chatId/bot-actions (BE-2.1 / Tarea 2) ────────────
  const chatBotActionsMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/bot-actions$/);
  if (chatBotActionsMatch && req.method === "GET") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const chatId     = Number(chatBotActionsMatch[1]);
    const limit      = Math.min(Number(url.searchParams.get("limit")  || "50"), 200);
    const offset     = Number(url.searchParams.get("offset") || "0");
    const actionType = url.searchParams.get("action_type") || null;
    const sinceRaw   = url.searchParams.get("since") || null;
    const reviewedRaw = url.searchParams.get("reviewed");
    const reviewed   = reviewedRaw === "true" ? true : reviewedRaw === "false" ? false : null;
    let since = null;
    if (sinceRaw) {
      const d = new Date(sinceRaw);
      if (Number.isNaN(d.getTime())) {
        writeJson(res, 400, { error: "bad_request", message: "since debe ser ISO timestamp" });
        return true;
      }
      since = d.toISOString();
    }
    const rows = await botActionsService.getByChat(chatId, { limit, offset, reviewed, since, actionType });
    writeJson(res, 200, { data: rows });
    return true;
  }

  // ─── GET /api/sales/supervisor/bot-actions (BE-2.6 / Tarea 5) ───────────────
  // Cola del supervisor: acciones sin revisar. ?is_reviewed=false (default) o true.
  if (req.method === "GET" && pathname === "/api/sales/supervisor/bot-actions") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const limit     = Math.min(Number(url.searchParams.get("limit") || "50"), 200);
    const sinceRaw  = url.searchParams.get("since") || null;
    let since = sinceRaw ? (() => {
      const d = new Date(sinceRaw);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    })() : null;
    const rows = await botActionsService.listUnreviewed({ limit, since });
    writeJson(res, 200, { data: rows });
    return true;
  }

  // ─── GET /api/sales/chats/:chatId/handoff-status (DEPRECATED · ADR-009) ─────
  const handoffStatusMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/handoff-status$/);
  if (handoffStatusMatch && req.method === "GET") {
    logger.warn({ path: pathname }, "DEPRECATED: handoff-status — ningún consumidor activo detectado. Remover en Sprint 5.");
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const chatId = Number(handoffStatusMatch[1]);
    const { active, handoff } = await botHandoffsService.isHandedOver(chatId);
    writeJson(res, 200, {
      chat_id:        chatId,
      is_handed_over: active,
      handoff: active ? {
        id:          handoff.id,
        to_user_id:  handoff.to_user_id,
        started_at:  handoff.started_at,
        reason:      handoff.reason || null,
      } : null,
    });
    return true;
  }

  // ─── PATCH /api/sales/bot-actions/:id/review (BE-2.6) ───────────────────────
  const botActionReviewMatch = pathname.match(/^\/api\/sales\/bot-actions\/(\d+)\/review$/);
  if (botActionReviewMatch && req.method === "PATCH") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const actionId = Number(botActionReviewMatch[1]);
    let body = {};
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const { isCorrect, note } = body;
    if (typeof isCorrect !== "boolean") {
      writeJson(res, 400, { error: "bad_request", message: "isCorrect debe ser boolean" });
      return true;
    }
    const user = req._authUser || null;
    const reviewedBy = user?.id ?? null;
    const noteClean = typeof note === "string" ? note.trim().slice(0, 2000) || null : null;
    const updated = await botActionsService.review(actionId, { isCorrect, reviewedBy, note: noteClean });
    if (!updated) {
      writeJson(res, 404, { error: "not_found" }); return true;
    }
    writeJson(res, 200, { data: { id: actionId, reviewed: true, is_correct: isCorrect } });
    return true;
  }

  // ─── GET /api/sales/bot-actions (BE-2.7) ────────────────────────────────────
  // Filtros: chat_id, order_id, reviewed (bool), since (ISO), action_type, limit, offset
  if (req.method === "GET" && pathname === "/api/sales/bot-actions") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const chatId     = url.searchParams.get("chat_id")     ? Number(url.searchParams.get("chat_id"))  : null;
    const orderId    = url.searchParams.get("order_id")    ? Number(url.searchParams.get("order_id")) : null;
    const limit      = Math.min(Number(url.searchParams.get("limit")  || "50"), 200);
    const offset     = Number(url.searchParams.get("offset") || "0");
    const actionType = url.searchParams.get("action_type") || null;
    const sinceRaw   = url.searchParams.get("since") || null;
    const reviewedRaw = url.searchParams.get("reviewed");
    const reviewed   = reviewedRaw === "true" ? true : reviewedRaw === "false" ? false : null;

    let since = null;
    if (sinceRaw) {
      const d = new Date(sinceRaw);
      if (Number.isNaN(d.getTime())) {
        writeJson(res, 400, { error: "bad_request", message: "since debe ser ISO timestamp" });
        return true;
      }
      since = d.toISOString();
    } else {
      since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    if (!chatId && !orderId) {
      writeJson(res, 400, { error: "bad_request", message: "Requerido: chat_id o order_id" });
      return true;
    }
    const rows = chatId
      ? await botActionsService.getByChat(chatId, { limit, offset, reviewed, since, actionType })
      : await botActionsService.getByOrder(orderId, { limit, offset });
    writeJson(res, 200, { data: rows });
    return true;
  }

  // ─── GET /api/sales/exceptions ───────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/sales/exceptions") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const status = url.searchParams.get("status") || "open";
    const limit  = Math.min(Number(url.searchParams.get("limit")  || "50"), 100);
    const offset = Number(url.searchParams.get("offset") || "0");
    const rows = await exceptionsService.list({ status, limit, offset });
    writeJson(res, 200, { data: rows });
    return true;
  }

  // ─── PATCH /api/sales/exceptions/:id/resolve ────────────────────────────────
  const exResolveMatch = pathname.match(/^\/api\/sales\/exceptions\/(\d+)\/resolve$/);
  if (exResolveMatch && req.method === "PATCH") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const exId = Number(exResolveMatch[1]);
    let body = {};
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const user = req._authUser || null;
    const resolvedBy = user?.id ?? null;
    const note = typeof body.resolution_note === "string" ? body.resolution_note.trim().slice(0, 2000) || null : null;
    const updated = await exceptionsService.resolve(exId, { resolvedBy, resolutionNote: note });
    if (!updated) {
      writeJson(res, 404, { error: "not_found_or_already_resolved" });
      return true;
    }
    writeJson(res, 200, { data: { id: exId, status: "resolved" } });
    return true;
  }

  // ─── POST /api/sales/exceptions (crear excepción manual desde UI) ────────────
  if (req.method === "POST" && pathname === "/api/sales/exceptions") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    let body = {};
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const { entity_type, entity_id, reason, severity, context, chat_id } = body;
    if (!entity_type || !entity_id || !reason) {
      writeJson(res, 400, {
        error: "bad_request",
        message: "Requerido: entity_type, entity_id, reason",
      });
      return true;
    }
    const id = await exceptionsService.raise({
      entityType: entity_type,
      entityId:   Number(entity_id),
      reason:     String(reason).slice(0, 120),
      severity:   severity || "medium",
      context:    context || null,
      chatId:     chat_id ? Number(chat_id) : null,
    });
    writeJson(res, 201, { data: { id } });
    return true;
  }

  // ─── GET /api/sales/bank-credits — créditos bancarios recientes para picker ──
  if (req.method === "GET" && pathname === "/api/sales/bank-credits") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const url = new URL(req.url, `http://localhost`);
    const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);
    const offset = Number(url.searchParams.get("offset") || 0);
    const { rows } = await pool.query(
      `SELECT bs.id, bs.tx_date, bs.reference_number, bs.description,
              bs.amount, bs.payment_type, bs.reconciliation_status,
              ba.account_number
       FROM bank_statements bs
       LEFT JOIN bank_accounts ba ON ba.id = bs.bank_account_id
       WHERE bs.tx_type = 'CREDIT'
       ORDER BY bs.tx_date DESC, bs.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    writeJson(res, 200, { ok: true, rows });
    return true;
  }

  // ─── POST /api/sales/orders/:id/reconcile — vinculación manual de pago ────────
  const reconcileMatch = pathname.match(/^\/api\/sales\/orders\/(\d+)\/reconcile$/);
  if (reconcileMatch && req.method === "POST") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const orderId = Number(reconcileMatch[1]);
    let body = {};
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const statementId = body.statement_id != null ? Number(body.statement_id) : NaN;
    if (!Number.isFinite(statementId) || statementId <= 0) {
      writeJson(res, 400, { error: "bad_request", message: "statement_id requerido" });
      return true;
    }

    // Verificar que la orden existe y obtener total en Bs
    const { rows: soRows } = await pool.query(
      `SELECT so.id, so.status, so.total_amount_bs
       FROM sales_orders so WHERE so.id = $1 LIMIT 1`,
      [orderId]
    );
    if (!soRows.length) {
      writeJson(res, 404, { error: "not_found", message: "Orden de venta no encontrada" });
      return true;
    }
    const so = soRows[0];

    const { rows: bsRows } = await pool.query(
      `SELECT id,
              amount::text AS amount,
              tx_type::text AS tx_type,
              reconciliation_status::text AS reconciliation_status
       FROM bank_statements WHERE id = $1 LIMIT 1`,
      [statementId]
    );
    if (!bsRows.length) {
      writeJson(res, 404, { error: "not_found", message: "Extracto bancario no encontrado" });
      return true;
    }
    const bs = bsRows[0];
    if (String(bs.tx_type || "").toUpperCase() !== "CREDIT") {
      writeJson(res, 400, { error: "bad_request", message: "Solo se pueden vincular abonos (crédito)." });
      return true;
    }
    const stBs = String(bs.reconciliation_status || "").toUpperCase();
    if (!["UNMATCHED", "SUGGESTED"].includes(stBs)) {
      writeJson(res, 409, {
        error: "conflict",
        message: "El movimiento de extracto no está disponible (debe estar sin conciliar o sugerido).",
      });
      return true;
    }
    const amtOrder = Number(so.total_amount_bs) || 0;
    const amtSource =
      bs.amount != null && String(bs.amount).trim() !== ""
        ? Number(String(bs.amount).replace(",", "."))
        : NaN;
    if (!Number.isFinite(amtSource)) {
      writeJson(res, 400, { error: "bad_request", message: "No se pudo leer el monto del extracto." });
      return true;
    }
    const tol = manualBankLinkToleranceBs();
    const amtDiff = Math.abs(amtOrder - amtSource);
    if (amtDiff > tol) {
      writeJson(res, 409, {
        error: "amount_mismatch",
        message: `Monto de la orden y del extracto fuera de tolerancia (±${tol} Bs.).`,
        order_bs: amtOrder,
        statement_bs: amtSource,
        tolerance_bs: tol,
      });
      return true;
    }

    await pool.query(
      `INSERT INTO reconciliation_log
         (order_id, bank_statement_id, source, match_level, confidence_score,
          amount_order_bs, amount_source_bs, amount_diff_bs, tolerance_used_bs,
          reference_matched, date_matched, resolved_by, status)
       VALUES ($1, $2, 'bank_statement', 3, 100.0, $3, $4, $5, $6,
               false, false, 'manual_ui', 'approved')`,
      [orderId, statementId, amtOrder, amtSource, amtDiff, tol]
    );

    await pool.query(
      `UPDATE bank_statements
         SET reconciliation_status = 'MATCHED'::reconciliation_status
       WHERE id = $1`,
      [statementId]
    );

    // Actualizar status de la orden a 'paid' si está en estado previo al pago
    const prevStatus = String(so.status || "").toLowerCase();
    if (["pending", "pending_payment", "approved"].includes(prevStatus)) {
      await pool.query(
        `UPDATE sales_orders SET status = 'paid', updated_at = NOW() WHERE id = $1`,
        [orderId]
      );
    }

    writeJson(res, 200, { ok: true, message: "Pago vinculado correctamente", order_id: orderId, statement_id: statementId });
    return true;
  }

  writeJson(res, 404, { error: "not_found" });
  return true;
}

module.exports = { handleSalesApiRequest };
