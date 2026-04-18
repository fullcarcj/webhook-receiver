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
const { resolveCustomer } = require("../services/resolveCustomer");

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
  /** Mostrador sin customer_id: doc, teléfono o consumidor_final */
  id_type: z.enum(["V", "E", "J", "G", "P"]).optional(),
  id_number: z.string().max(32).optional(),
  phone: z.string().max(80).optional(),
  consumidor_final: z.boolean().optional(),
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
        id_type: d.id_type,
        id_number: d.id_number,
        phone: d.phone,
        consumidor_final: d.consumidor_final,
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

    if (req.method === "GET" && segment && /^(\d+|pos-\d+|so-\d+)$/i.test(segment)) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      const row = await salesService.getSalesOrderById(segment);
      writeJson(res, 200, { data: row, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    // ─── BE-1.6 · POST /api/sales/chats/:chatId/take-over ─────────────────────
    // Vendedor toma una conversación que estaba en manos del bot.
    // Requiere tabla bot_handoffs (npm run db:bot-handoffs).
    const takeOverMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/take-over$/);
    if (takeOverMatch && req.method === "POST") {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const chatId = Number(takeOverMatch[1]);
      let body = {};
      try { body = await parseJsonBody(req); } catch (_) {
        writeJson(res, 400, { error: "invalid_json" }); return true;
      }
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;
      const user = req._authUser || null;
      const userId = user?.id ?? null;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const chatRow = await client.query("SELECT id FROM crm_chats WHERE id = $1", [chatId]);
        if (!chatRow.rowCount) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { error: "chat_not_found" }); return true;
        }

        const active = await client.query(
          "SELECT id, to_user_id FROM bot_handoffs WHERE chat_id = $1 AND ended_at IS NULL",
          [chatId]
        );
        if (active.rowCount > 0) {
          await client.query("ROLLBACK");
          writeJson(res, 409, {
            error: "handoff_already_active",
            message: `Chat ya tomado por usuario ${active.rows[0].to_user_id}`,
            existing_handoff_id: active.rows[0].id,
          }); return true;
        }

        const insert = await client.query(
          `INSERT INTO bot_handoffs (chat_id, from_bot, to_user_id, reason)
           VALUES ($1, TRUE, $2, $3)
           RETURNING id, started_at`,
          [chatId, userId, reason]
        );

        // Nombre del agente para mensaje system en crm_messages
        let agentName = `Agente ${userId ?? "?"}`;
        if (userId) {
          const uRow = await client.query("SELECT full_name FROM users WHERE id = $1", [userId]);
          if (uRow.rowCount) agentName = uRow.rows[0].full_name || agentName;
        }

        await client.query(
          `INSERT INTO crm_messages (chat_id, type, content, created_at)
           VALUES ($1, 'system', $2, NOW())`,
          [chatId, `${agentName} se unió a la conversación`]
        );

        await client.query("COMMIT");
        writeJson(res, 200, {
          data: {
            handoff_id: insert.rows[0].id,
            chat_id: chatId,
            taken_by: { id: userId, name: agentName },
            started_at: insert.rows[0].started_at,
          },
        });
      } catch (err) {
        await client.query("ROLLBACK");
        // Tabla bot_handoffs aún no migrada
        if (err.code === "42P01") {
          writeJson(res, 503, {
            error: "schema_missing",
            detail: "Ejecutar: npm run db:bot-handoffs",
          }); return true;
        }
        throw err;
      } finally {
        client.release();
      }
      return true;
    }

    // ─── BE-1.7 · POST /api/sales/chats/:chatId/return-to-bot ─────────────────
    // Cierra el handoff activo y devuelve la conversación al bot.
    // Política: cualquier usuario con permiso 'ventas' puede devolver (no solo quien tomó).
    const returnToBotMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/return-to-bot$/);
    if (returnToBotMatch && req.method === "POST") {
      if (!await requireAdminOrPermission(req, res, "ventas")) return true;
      const chatId = Number(returnToBotMatch[1]);
      const user = req._authUser || null;
      const userId = user?.id ?? null;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const active = await client.query(
          "SELECT id FROM bot_handoffs WHERE chat_id = $1 AND ended_at IS NULL",
          [chatId]
        );
        if (!active.rowCount) {
          await client.query("ROLLBACK");
          writeJson(res, 404, {
            error: "handoff_not_found",
            message: "No hay handoff activo para este chat",
          }); return true;
        }

        const handoffId = active.rows[0].id;
        await client.query(
          "UPDATE bot_handoffs SET ended_at = NOW() WHERE id = $1",
          [handoffId]
        );

        let agentName = `Agente ${userId ?? "?"}`;
        if (userId) {
          const uRow = await client.query("SELECT full_name FROM users WHERE id = $1", [userId]);
          if (uRow.rowCount) agentName = uRow.rows[0].full_name || agentName;
        }

        await client.query(
          `INSERT INTO crm_messages (chat_id, type, content, created_at)
           VALUES ($1, 'system', $2, NOW())`,
          [chatId, `${agentName} devolvió la conversación al asistente automático`]
        );

        await client.query("COMMIT");
        writeJson(res, 200, {
          data: {
            handoff_id: handoffId,
            chat_id: chatId,
            returned_by: { id: userId, name: agentName },
            ended_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        await client.query("ROLLBACK");
        if (err.code === "42P01") {
          writeJson(res, 503, {
            error: "schema_missing",
            detail: "Ejecutar: npm run db:bot-handoffs",
          }); return true;
        }
        throw err;
      } finally {
        client.release();
      }
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

  // ─── GET /api/sales/chats/:chatId/handoff-status ────────────────────────────
  const handoffStatusMatch = pathname.match(/^\/api\/sales\/chats\/(\d+)\/handoff-status$/);
  if (handoffStatusMatch && req.method === "GET") {
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

  // ─── GET /api/sales/bot-actions ─────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/sales/bot-actions") {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
    const chatId  = url.searchParams.get("chat_id")  ? Number(url.searchParams.get("chat_id"))  : null;
    const orderId = url.searchParams.get("order_id") ? Number(url.searchParams.get("order_id")) : null;
    const limit   = Math.min(Number(url.searchParams.get("limit") || "50"), 100);
    const offset  = Number(url.searchParams.get("offset") || "0");
    if (!chatId && !orderId) {
      writeJson(res, 400, { error: "bad_request", message: "Requerido: chat_id o order_id" });
      return true;
    }
    const rows = chatId
      ? await botActionsService.getByChat(chatId, { limit, offset })
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

  writeJson(res, 404, { error: "not_found" });
  return true;
}

module.exports = { handleSalesApiRequest };
