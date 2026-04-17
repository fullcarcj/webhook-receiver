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
 *     GET /api/stats/inventory
 *   GRUPO 3 — Clientes y CRM
 *     GET /api/stats/customers
 *     GET /api/stats/customers/vehicles
 *     GET /api/stats/whatsapp
 *     GET /api/stats/mercadolibre
 *     GET /api/stats/ml-profitability
 *   GRUPO 4 — Conciliación
 *     GET /api/stats/reconciliation          (extiende el existente)
 *     GET /api/stats/payment-attempts        (existente)
 *     GET /api/stats/reconciliation-log      (existente)
 *   GRUPO 5 — Control Financiero (lectura)
 *     GET /api/stats/cashflow
 *     GET /api/stats/expenses
 *     GET /api/stats/pnl
 *     GET /api/stats/exchange-rates
 *   GRUPO 5b — Finanzas (fiscal)
 *     GET  /api/finance/summary
 *     GET  /api/finance/comprobantes
 *     GET  /api/finance/reconciliation-status
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

  const isFinanceApi = path.startsWith("/api/finance");
  if (isFinanceApi) {
    if (!await requireAdminOrPermission(req, res, "fiscal")) return true;
  } else {
    if (!await requireAdminOrPermission(req, res, "ventas")) return true;
  }

  const t0 = Date.now();

  try {
    // ── FINANZAS — resumen / comprobantes / estado conciliación ─────────────
    if (path === "/api/finance/summary" && method === "GET") {
      const { start, end, label } = getPeriod(url);
      const igtfRateRow = await pool.query(
        `SELECT setting_value FROM finance_settings WHERE setting_key = 'igtf_rate_pct' LIMIT 1`
      ).catch(() => ({ rows: [] }));
      const igtfRatePct = igtfRateRow.rows[0]
        ? Number(igtfRateRow.rows[0].setting_value)
        : 3;

      const [
        cf,
        pend,
        unjust,
        igtf,
        wa,
      ] = await Promise.all([
        pool.query(`
          SELECT
            COALESCE(SUM(CASE WHEN tx_type = 'CREDIT' THEN amount ELSE 0 END), 0)::numeric AS ingresos_bs,
            COALESCE(SUM(CASE WHEN tx_type = 'DEBIT' THEN amount ELSE 0 END), 0)::numeric AS egresos_bs,
            COUNT(*)::bigint AS total_movimientos
          FROM bank_statements
          WHERE tx_date >= $1::date AND tx_date < $2::date
        `, [start, end]),
        pool.query(`
          SELECT COUNT(*)::bigint AS pending_approvals
          FROM manual_transactions
          WHERE approval_status = 'pending'
        `).catch(() => ({ rows: [{ pending_approvals: "0" }] })),
        pool.query(`
          SELECT COUNT(*)::bigint AS unjustified_debits
          FROM bank_statements bs
          LEFT JOIN debit_justifications dj ON dj.bank_statement_id = bs.id
          WHERE bs.tx_type = 'DEBIT'
            AND bs.reconciliation_status::text = 'UNMATCHED'
            AND dj.id IS NULL
            AND bs.tx_date >= $1::date AND bs.tx_date < $2::date
        `, [start, end]).catch(() => ({ rows: [{ unjustified_debits: "0" }] })),
        pool.query(`
          SELECT
            COALESCE(SUM(igtf_amount_usd), 0)::numeric AS igtf_collected_usd,
            COUNT(*)::bigint AS igtf_transactions
          FROM sale_payments
          WHERE generates_igtf = true
            AND created_at >= $1 AND created_at < $2
        `, [start, end]),
        pool.query(`
          SELECT
            COUNT(*)::bigint AS total_attempts,
            COUNT(*) FILTER (WHERE reconciliation_status = 'matched')::bigint AS matched,
            COUNT(*) FILTER (WHERE reconciliation_status = 'no_match')::bigint AS no_match,
            COUNT(*) FILTER (WHERE extracted_amount_bs IS NULL)::bigint AS extraction_failed
          FROM payment_attempts
          WHERE created_at >= $1 AND created_at < $2
        `, [start, end]),
      ]);

      const c0 = cf.rows[0] || {};
      const ing = Number(c0.ingresos_bs || 0);
      const egr = Number(c0.egresos_bs || 0);
      const totA = Number(wa.rows[0]?.total_attempts || 0);
      const mat = Number(wa.rows[0]?.matched || 0);

      return ok(res, 200, {
        period: label,
        cashflow: {
          ingresos_bs: ing,
          egresos_bs: egr,
          balance_bs: Number((ing - egr).toFixed(4)),
          total_movimientos: Number(c0.total_movimientos || 0),
        },
        pending_approvals: Number(pend.rows[0]?.pending_approvals || 0),
        unjustified_debits: Number(unjust.rows[0]?.unjustified_debits || 0),
        igtf: {
          collected_usd: Number(igtf.rows[0]?.igtf_collected_usd || 0),
          transactions: Number(igtf.rows[0]?.igtf_transactions || 0),
          rate_pct: Number.isFinite(igtfRatePct) ? igtfRatePct : 3,
        },
        comprobantes_wa: {
          total_attempts: totA,
          matched: mat,
          no_match: Number(wa.rows[0]?.no_match || 0),
          extraction_failed: Number(wa.rows[0]?.extraction_failed || 0),
          match_rate_pct: totA > 0 ? Number(((mat / totA) * 100).toFixed(2)) : 0,
        },
      }, buildMeta(t0, label));
    }

    if (path === "/api/finance/comprobantes" && method === "GET") {
      const sp = url.searchParams;
      const PA_STATUS = new Set(["matched", "no_match", "pending", "manual_review", "rejected"]);
      const statusRaw = sp.get("status");
      let status = null;
      if (statusRaw != null && String(statusRaw).trim() !== "") {
        const s = String(statusRaw).trim().toLowerCase();
        if (!PA_STATUS.has(s)) {
          return fail(res, 400, "INVALID_STATUS", "status debe ser matched|no_match|pending|manual_review|rejected");
        }
        status = s;
      }
      const fromTs = sp.get("from");
      const toTs = sp.get("to");
      let limit = parseInt(sp.get("limit") || "50", 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      if (limit > 200) limit = 200;
      let offset = parseInt(sp.get("offset") || "0", 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;

      const params = [];
      let n = 1;
      let where = "WHERE TRUE";
      if (status) {
        where += ` AND pa.reconciliation_status = $${n++}`;
        params.push(status);
      }
      if (fromTs) {
        where += ` AND pa.created_at >= $${n++}::timestamptz`;
        params.push(fromTs);
      }
      if (toTs) {
        where += ` AND pa.created_at <= $${n++}::timestamptz`;
        params.push(toTs);
      }

      const countR = await pool.query(
        `SELECT COUNT(*)::bigint AS c FROM payment_attempts pa ${where}`,
        params
      );
      const total = Number(countR.rows[0].c);

      const dataR = await pool.query(
        `SELECT
           pa.id,
           pa.firebase_url,
           pa.extracted_reference,
           pa.extracted_amount_bs,
           pa.extracted_date,
           pa.extracted_bank,
           pa.reconciliation_status,
           pa.created_at,
           c.full_name AS customer_name,
           c.phone AS customer_phone,
           so.external_order_id
         FROM payment_attempts pa
         LEFT JOIN customers c ON c.id = pa.customer_id
         LEFT JOIN sales_orders so ON so.id = pa.reconciled_order_id
         ${where}
         ORDER BY pa.created_at DESC
         LIMIT $${n++} OFFSET $${n++}`,
        [...params, limit, offset]
      );

      return ok(res, 200, {
        rows: dataR.rows,
        pagination: { total, limit, offset },
      }, buildMeta(t0, "comprobantes"));
    }

    if (path === "/api/finance/reconciliation-status" && method === "GET") {
      const { rows: byStatus } = await pool.query(`
        SELECT
          reconciliation_status::text AS status,
          COUNT(*)::bigint AS count,
          COALESCE(SUM(amount), 0)::numeric AS total_bs
        FROM bank_statements
        GROUP BY reconciliation_status
        ORDER BY count DESC
      `);

      const { rows: worker24 } = await pool.query(`
        SELECT
          status AS action,
          COUNT(*)::bigint AS count,
          MAX(created_at) AS last_run
        FROM reconciliation_log
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status
        ORDER BY count DESC
      `).catch(() => ({ rows: [] }));

      const { rows: tot } = await pool.query(`
        SELECT
          COUNT(*)::bigint AS total_statements,
          COUNT(*) FILTER (WHERE reconciliation_status::text = 'UNMATCHED')::bigint AS unmatched_count,
          COALESCE(SUM(amount) FILTER (WHERE reconciliation_status::text = 'UNMATCHED'), 0)::numeric AS unmatched_bs
        FROM bank_statements
      `);

      const t = tot[0] || {};
      return ok(res, 200, {
        by_status: byStatus.map((r) => ({
          status: r.status,
          count: Number(r.count),
          total_bs: Number(r.total_bs),
        })),
        worker_24h: worker24.map((r) => ({
          action: r.action,
          count: Number(r.count),
          last_run: r.last_run,
        })),
        total_statements: Number(t.total_statements || 0),
        unmatched_count: Number(t.unmatched_count || 0),
        unmatched_bs: Number(t.unmatched_bs || 0),
      }, buildMeta(t0, "reconciliation-status"));
    }

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

    if (path === "/api/stats/inventory" && method === "GET") {
      const data = await statsService.getInventoryStats();
      return ok(res, 200, data, buildMeta(t0, "inventory"));
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

    // GET /api/stats/ml-profitability
    // Desglose de rentabilidad real por ventas ML: comisiones, envío, impuestos y neto (payout).
    // Requiere: npm run db:ml-order-fees (migración que agrega columnas ml_*_usd en sales_orders).
    if (path === "/api/stats/ml-profitability" && method === "GET") {
      const { start, end, label } = getPeriod(url);

      const { rows } = await pool.query(`
        SELECT
          COUNT(*)::bigint                                                             AS orders_count,
          COALESCE(SUM(order_total_amount),       0)::numeric(20,2)                   AS revenue_usd,
          COALESCE(SUM(ml_sale_fee_usd),          0)::numeric(20,2)                   AS total_fees_usd,
          COALESCE(SUM(ml_shipping_cost_usd),     0)::numeric(20,2)                   AS total_shipping_usd,
          COALESCE(SUM(ml_taxes_usd),             0)::numeric(20,2)                   AS total_taxes_usd,
          COALESCE(SUM(ml_payout_usd),            0)::numeric(20,2)                   AS total_payout_usd,
          ROUND(
            AVG(
              CASE WHEN COALESCE(order_total_amount, 0) > 0
                THEN ml_payout_usd / order_total_amount * 100
              END
            ), 2
          )::numeric(6,2)                                                              AS avg_margin_pct
        FROM sales_orders
        WHERE source       = 'mercadolibre'
          AND status       IN ('paid', 'shipped', 'completed')
          AND created_at   >= $1
          AND created_at   <= $2
          AND ml_payout_usd IS NOT NULL
      `, [start, end]);

      const r = rows[0] || {};
      const revenueUsd      = Number(r.revenue_usd      || 0);
      const totalFeesUsd    = Number(r.total_fees_usd    || 0);
      const totalShippingUsd = Number(r.total_shipping_usd || 0);
      const totalTaxesUsd   = Number(r.total_taxes_usd   || 0);
      const totalDeductions = Number((totalFeesUsd + totalShippingUsd + totalTaxesUsd).toFixed(2));

      return ok(res, 200, {
        period:          label,
        orders_count:    Number(r.orders_count    || 0),
        revenue_usd:     revenueUsd,
        fees: {
          sale_fee_usd:         totalFeesUsd,
          shipping_usd:         totalShippingUsd,
          taxes_usd:            totalTaxesUsd,
          total_deductions_usd: totalDeductions,
        },
        payout_usd:      Number(r.total_payout_usd || 0),
        avg_margin_pct:  r.avg_margin_pct != null ? Number(r.avg_margin_pct) : null,
      }, buildMeta(t0, label));
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
