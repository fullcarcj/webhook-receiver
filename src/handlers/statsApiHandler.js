"use strict";

/**
 * Handler unificado para Analytics ERP/CRM + Control Financiero Multi-Moneda.
 *
 * Rutas soportadas:
 *   GRUPO 1 — Overview
 *     GET /api/stats/overview
 *     GET /api/stats/realtime
 *   GRUPO 2 — Ventas
 *     GET /api/stats/sales
 *     GET /api/stats/sales/hourly
 *     GET /api/stats/sales/products
 *   GRUPO 3 — Clientes y CRM
 *     GET /api/stats/customers
 *     GET /api/stats/customers/vehicles
 *     GET /api/stats/whatsapp
 *     GET /api/stats/mercadolibre
 *   GRUPO 4 — Conciliación
 *     GET /api/stats/reconciliation          (extiende el existente)
 *     GET /api/stats/payment-attempts        (existente)
 *     GET /api/stats/reconciliation-log      (existente)
 *   GRUPO 5 — Control Financiero (lectura)
 *     GET /api/stats/cashflow
 *     GET /api/stats/expenses
 *     GET /api/stats/pnl
 *     GET /api/stats/exchange-rates
 *   GRUPO 6 — Control Financiero (escritura + gestión)
 *     GET  /api/finance/debits/unjustified
 *     POST /api/finance/debits/:id/justify
 *     GET  /api/finance/categories
 *     POST /api/finance/categories
 *     GET  /api/finance/transactions
 *     POST /api/finance/transactions
 *     POST /api/finance/exchange-rates
 *     GET  /api/finance/exchange-rates/current
 *
 * Auth: X-Admin-Secret == ADMIN_SECRET (header) o ?k= / ?secret= (query)
 * Respuesta unificada: { data, meta } / { error: { code, message }, meta }
 */

const pino = require("pino");
const { z } = require("zod");
const log   = pino({ level: process.env.LOG_LEVEL || "info", name: "stats_api" });

const statsService    = require("../services/statsService");
const financialService = require("../services/financialService");
const { pool }        = require("../../db");
const { resolvePeriod, buildMeta } = require("../utils/statsHelpers");
const { requireAdminOrPermission } = require("../utils/authMiddleware");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(res, status, data, meta) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ data, meta }));
  return true;
}

function fail(res, status, code, message, meta = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { code, message }, meta }));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end",  () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(Object.assign(new Error("JSON inválido"), { code: "INVALID_JSON", status: 400 })); }
    });
    req.on("error", reject);
  });
}

function getPeriod(url) {
  return resolvePeriod(
    url.searchParams.get("period") || "month",
    url.searchParams.get("from"),
    url.searchParams.get("to")
  );
}

// ─── Zod schemas para /api/finance/* ─────────────────────────────────────────

const justifySchema = z.object({
  expense_category_id: z.number().int().positive(),
  justification_note:  z.string().max(500).optional(),
  justified_by:        z.enum(["Javier", "Jesus", "Sebastian"]),
});

const categorySchema = z.object({
  name: z.string().min(2).max(100),
  type: z.enum(["gasto", "inversion", "devolucion", "nomina"]),
});

const transactionSchema = z.object({
  type:                z.enum(["ingreso", "egreso", "inversion"]),
  currency:            z.enum(["USD", "ZELLE", "BINANCE", "EFECTIVO", "EFECTIVO_BS", "CREDITO", "PANAMA"]),
  amount:              z.number().positive(),
  expense_category_id: z.number().int().positive().optional(),
  description:         z.string().min(3).max(500),
  reference:           z.string().max(100).optional(),
  tx_date:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  registered_by:       z.enum(["Javier", "Jesus", "Sebastian"]),
  exchange_rate_used:  z.number().positive().optional(),
});

const exchangeRateSchema = z.object({
  rate_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bs_per_usd:    z.number().positive(),
  source:        z.enum(["manual", "bcv", "parallel"]).default("manual"),
  registered_by: z.enum(["Javier", "Jesus", "Sebastian"]),
});

// ─── Handler principal ────────────────────────────────────────────────────────

async function handleStatsApiRequest(req, res) {
  const url    = new URL(req.url || "/", "http://localhost");
  const path   = url.pathname;
  const method = req.method || "GET";

  if (!path.startsWith("/api/stats") && !path.startsWith("/api/finance")) return false;
  // También maneja /api/stats/wa-throttle

  if (!await requireAdminOrPermission(req, res, 'ventas')) return true;

  const t0 = Date.now();

  try {
    // ── GRUPO 1 — OVERVIEW ──────────────────────────────────────────────────

    if (path === "/api/stats/overview" && method === "GET") {
      const data = await statsService.getOverview();
      return ok(res, 200, data, buildMeta(t0, "today"));
    }

    if (path === "/api/stats/realtime" && method === "GET") {
      const data = await statsService.getRealtime();
      return ok(res, 200, data, buildMeta(t0, "realtime"));
    }

    // ── GRUPO 2 — VENTAS ─────────────────────────────────────────────────────

    if (path === "/api/stats/sales" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getSales({
        start, end, label,
        source: url.searchParams.get("source") || null,
        seller: url.searchParams.get("seller") || null,
      });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/sales/hourly" && method === "GET") {
      const weeks = Math.min(parseInt(url.searchParams.get("weeks") || "4", 10), 52);
      const data  = await statsService.getSalesHourly(weeks);
      return ok(res, 200, data, buildMeta(t0, `last_${weeks}_weeks`));
    }

    if (path === "/api/stats/sales/products" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
      const data  = await statsService.getSalesProducts({ start, end, limit });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    // ── GRUPO 3 — CLIENTES ───────────────────────────────────────────────────

    if (path === "/api/stats/customers" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getCustomers({ start, end, label });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/customers/vehicles" && method === "GET") {
      const data = await statsService.getCustomerVehicles();
      return ok(res, 200, data, buildMeta(t0, "all_time"));
    }

    if (path === "/api/stats/whatsapp" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getWhatsapp({ start, end });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/mercadolibre" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getMercadoLibre({ start, end });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    // ── GRUPO 4 — CONCILIACIÓN ───────────────────────────────────────────────

    if (path === "/api/stats/reconciliation" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getReconciliationStats({ start, end, label });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/payment-attempts" && method === "GET") {
      const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0",  10), 0);
      const status = url.searchParams.get("status") || null;
      const today  = url.searchParams.get("today")  === "1";

      let where = "WHERE TRUE";
      const params = [];
      if (status) { params.push(status); where += ` AND pa.reconciliation_status = $${params.length}`; }
      if (today)  { where += ` AND pa.created_at >= CURRENT_DATE`; }

      const { rows } = await pool.query(`
        SELECT pa.*, c.full_name AS customer_name, c.phone AS customer_phone
        FROM payment_attempts pa LEFT JOIN customers c ON c.id = pa.customer_id
        ${where} ORDER BY pa.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]);
      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*) AS total FROM payment_attempts pa ${where}`, params
      );
      return ok(res, 200, rows, { ...buildMeta(t0, "custom"), total: Number(cnt[0].total), limit, offset });
    }

    if (path === "/api/stats/reconciliation-log" && method === "GET") {
      const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0",  10), 0);
      const { rows } = await pool.query(`
        SELECT rl.*, so.source AS order_source, so.external_order_id, so.order_total_amount
        FROM reconciliation_log rl LEFT JOIN sales_orders so ON so.id = rl.order_id
        ORDER BY rl.created_at DESC LIMIT $1 OFFSET $2
      `, [limit, offset]);
      const { rows: cnt } = await pool.query(`SELECT COUNT(*) AS total FROM reconciliation_log`);
      return ok(res, 200, rows, { ...buildMeta(t0, "custom"), total: Number(cnt[0].total), limit, offset });
    }

    // ── GRUPO 5 — FINANCIERO LECTURA ─────────────────────────────────────────

    if (path === "/api/stats/cashflow" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getCashflow({ start, end, label });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/expenses" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getExpenses({ start, end });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/pnl" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getPnl({ start, end, label });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    if (path === "/api/stats/exchange-rates" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const data = await statsService.getExchangeRates({ start, end });
      return ok(res, 200, data, buildMeta(t0, label));
    }

    // ── GRUPO 6 — FINANCIERO ESCRITURA ───────────────────────────────────────

    if (path === "/api/finance/debits/unjustified" && method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
      const data  = await financialService.getUnjustifiedDebits({
        from:  url.searchParams.get("from") || null,
        to:    url.searchParams.get("to")   || null,
        limit,
      });
      return ok(res, 200, data, buildMeta(t0, "realtime"));
    }

    // POST /api/finance/debits/:id/justify
    const justifyMatch = path.match(/^\/api\/finance\/debits\/(\d+)\/justify$/);
    if (justifyMatch && method === "POST") {
      const id   = parseInt(justifyMatch[1], 10);
      const body = await readBody(req);
      const parsed = justifySchema.safeParse(body);
      if (!parsed.success) {
        return fail(res, 400, "VALIDATION_ERROR", parsed.error.errors.map((e) => e.message).join(", "));
      }
      const data = await financialService.justifyDebit(id, parsed.data);
      // Emitir SSE
      try {
        const { emitOrderStatusChanged } = require("../services/sseService");
        emitOrderStatusChanged({ orderId: id, fromStatus: "unjustified", toStatus: "justified", changedBy: parsed.data.justified_by });
      } catch (_) {}
      return ok(res, 201, data, buildMeta(t0, "realtime"));
    }

    if (path === "/api/finance/categories" && method === "GET") {
      const data = await financialService.getCategories();
      return ok(res, 200, data, buildMeta(t0, "all_time"));
    }

    if (path === "/api/finance/categories" && method === "POST") {
      const body   = await readBody(req);
      const parsed = categorySchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message);
      const data = await financialService.createCategory(parsed.data);
      return ok(res, 201, data, buildMeta(t0, "realtime"));
    }

    if (path === "/api/finance/transactions" && method === "GET") {
      const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0",  10), 0);
      const data   = await financialService.getTransactions({
        currency: url.searchParams.get("currency") || null,
        type:     url.searchParams.get("type")     || null,
        from:     url.searchParams.get("from")     || null,
        to:       url.searchParams.get("to")       || null,
        limit, offset,
      });
      return ok(res, 200, data, buildMeta(t0, "custom"));
    }

    if (path === "/api/finance/transactions" && method === "POST") {
      const body   = await readBody(req);
      const parsed = transactionSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message);
      const data = await financialService.createTransaction(parsed.data);
      return ok(res, 201, data, buildMeta(t0, "realtime"));
    }

    if (path === "/api/finance/exchange-rates/current" && method === "GET") {
      const data = await financialService.getCurrentExchangeRate();
      return ok(res, 200, data || {}, buildMeta(t0, "realtime"));
    }

    if (path === "/api/finance/exchange-rates" && method === "POST") {
      const body   = await readBody(req);
      const parsed = exchangeRateSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message);
      const data = await financialService.upsertExchangeRate(parsed.data);
      return ok(res, 201, data, buildMeta(t0, "realtime"));
    }

    // GET /api/stats/wa-throttle — monitoreo del cap diario por teléfono
    if (path === "/api/stats/wa-throttle" && method === "GET") {
      const { getWaThrottleSummary } = require("../services/waThrottle");
      const { pool } = require("../../db");
      const data = await getWaThrottleSummary(pool);
      return ok(res, 200, data, buildMeta(t0, "wa-throttle"));
    }

    // GET /api/stats/db-activity — monitoreo técnico DB (actividad, locks, cambios recientes)
    if (path === "/api/stats/db-activity" && method === "GET") {
      const minutes = Math.min(Math.max(parseInt(url.searchParams.get("minutes") || "15", 10), 1), 240);

      const { rows: active } = await pool.query(`
        SELECT
          pid,
          usename,
          application_name,
          state,
          wait_event_type,
          wait_event,
          NOW() - query_start AS running_for,
          LEFT(query, 220) AS query_preview
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state <> 'idle'
        ORDER BY query_start ASC
        LIMIT 50
      `);

      const { rows: waits } = await pool.query(`
        SELECT
          COALESCE(wait_event_type, 'none') AS wait_event_type,
          COUNT(*)::int AS sessions
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
        GROUP BY COALESCE(wait_event_type, 'none')
        ORDER BY sessions DESC
      `);

      const { rows: lockWaits } = await pool.query(`
        SELECT COUNT(*)::int AS lock_waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
      `);

      const { rows: recency } = await pool.query(`
        SELECT *
        FROM (
          SELECT
            'sales_orders'::text AS table_name,
            COUNT(*)::int AS rows_changed_window,
            MAX(created_at) AS last_change_at
          FROM sales_orders
          WHERE created_at >= NOW() - ($1::text || ' minutes')::interval
          UNION ALL
          SELECT
            'bank_statements'::text AS table_name,
            COUNT(*)::int AS rows_changed_window,
            MAX(created_at) AS last_change_at
          FROM bank_statements
          WHERE created_at >= NOW() - ($1::text || ' minutes')::interval
          UNION ALL
          SELECT
            'payment_attempts'::text AS table_name,
            COUNT(*)::int AS rows_changed_window,
            MAX(created_at) AS last_change_at
          FROM payment_attempts
          WHERE created_at >= NOW() - ($1::text || ' minutes')::interval
          UNION ALL
          SELECT
            'inventory_projections'::text AS table_name,
            COUNT(*)::int AS rows_changed_window,
            MAX(last_calculated_at) AS last_change_at
          FROM inventory_projections
          WHERE last_calculated_at >= NOW() - ($1::text || ' minutes')::interval
        ) t
        ORDER BY table_name ASC
      `, [String(minutes)]);

      return ok(res, 200, {
        window_minutes: minutes,
        lock_waiting: Number(lockWaits[0]?.lock_waiting || 0),
        wait_event_summary: waits,
        active_sessions: active,
        recent_table_changes: recency,
      }, buildMeta(t0, `db_activity_${minutes}m`));
    }

    // Ruta no encontrada dentro del módulo
    return fail(res, 404, "NOT_FOUND", `Endpoint ${path} no existe`, buildMeta(t0, "custom"));

  } catch (err) {
    log.error({ err: err.message, path, method }, "stats_handler: error");
    return fail(res, err.status || 500, err.code || "INTERNAL_ERROR", err.message, buildMeta(t0, "custom"));
  }
}

module.exports = { handleStatsApiRequest };
