"use strict";

/**
 * Handler de endpoints de estadísticas y monitoreo.
 * Actualmente expone:
 *   GET /api/stats/reconciliation  — resumen 24h del motor de conciliación
 *   GET /api/stats/payment-attempts — comprobantes recibidos hoy
 *
 * Auth: X-Admin-Secret == ADMIN_SECRET (header) o ?k= / ?secret= (query)
 */

const { pool } = require("../../db");
const pino     = require("pino");
const log      = pino({ level: process.env.LOG_LEVEL || "info", name: "stats_api" });

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function isAdmin(req) {
  if (!ADMIN_SECRET) return false;
  const headerSecret = req.headers["x-admin-secret"] || "";
  if (headerSecret && headerSecret === ADMIN_SECRET) return true;
  const url    = new URL(req.url, "http://localhost");
  const qk     = url.searchParams.get("k") || url.searchParams.get("secret") || "";
  return qk === ADMIN_SECRET;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>} true si manejó la petición
 */
async function handleStatsApiRequest(req, res) {
  const url    = new URL(req.url, "http://localhost");
  const path   = url.pathname;
  const method = req.method || "GET";

  if (!path.startsWith("/api/stats")) return false;

  if (!isAdmin(req)) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
    return true;
  }

  // ── GET /api/stats/reconciliation ────────────────────────────────────────
  if (path === "/api/stats/reconciliation" && method === "GET") {
    try {
      // Tabla puede no existir aún (pre-migración)
      const { rows: summary } = await pool.query(`
        SELECT
          COUNT(*)                                                FILTER (WHERE status = 'auto_matched')  AS auto_matched,
          COUNT(*)                                                FILTER (WHERE status = 'manual_review') AS pending_review,
          COUNT(*)                                                FILTER (WHERE match_level = 1)          AS level1,
          COUNT(*)                                                FILTER (WHERE match_level = 2)          AS level2,
          COUNT(*)                                                FILTER (WHERE match_level = 3)          AS level3,
          COUNT(*)                                                FILTER (WHERE source = 'bank_statement') AS from_bank,
          COUNT(*)                                                FILTER (WHERE source = 'payment_attempt') AS from_receipt,
          COALESCE(SUM(amount_diff_bs) FILTER (WHERE status = 'auto_matched'), 0) AS total_diff_bs,
          MAX(created_at)                                         AS last_match_at,
          COUNT(*)                                                AS total_last_24h
        FROM reconciliation_log
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `);

      const { rows: overdue } = await pool.query(`
        SELECT COUNT(*) AS payment_overdue_count
        FROM sales_orders
        WHERE status = 'payment_overdue'
      `);

      const { rows: pendingOrders } = await pool.query(`
        SELECT COUNT(*) AS pending_orders_count
        FROM sales_orders
        WHERE status = 'pending'
          AND order_total_amount IS NOT NULL
          AND order_total_amount > 0
      `);

      const { rows: pendingAttempts } = await pool.query(`
        SELECT COUNT(*) AS pending_attempts_count
        FROM payment_attempts
        WHERE reconciliation_status = 'pending'
          AND created_at >= NOW() - INTERVAL '3 days'
      `);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok:   true,
        data: {
          ...summary[0],
          payment_overdue_count:  Number(overdue[0]?.payment_overdue_count  ?? 0),
          pending_orders_count:   Number(pendingOrders[0]?.pending_orders_count ?? 0),
          pending_attempts_count: Number(pendingAttempts[0]?.pending_attempts_count ?? 0),
        },
        meta: { timestamp: new Date().toISOString(), window: "24h" },
      }));
    } catch (err) {
      log.error({ err: err.message }, "stats: error en /api/stats/reconciliation");
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ── GET /api/stats/payment-attempts ──────────────────────────────────────
  if (path === "/api/stats/payment-attempts" && method === "GET") {
    try {
      const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0",  10), 0);
      const status = url.searchParams.get("status") || null;
      const today  = url.searchParams.get("today")  === "1";

      let where   = "WHERE TRUE";
      const params = [];
      if (status) {
        params.push(status);
        where += ` AND pa.reconciliation_status = $${params.length}`;
      }
      if (today) {
        where += ` AND pa.created_at >= CURRENT_DATE`;
      }

      const { rows } = await pool.query(`
        SELECT
          pa.id, pa.customer_id, pa.chat_id, pa.firebase_url,
          pa.is_receipt, pa.prefiler_score,
          pa.extracted_reference, pa.extracted_amount_bs,
          pa.extracted_date, pa.extracted_bank, pa.extracted_payment_type,
          pa.extraction_confidence, pa.reconciliation_status,
          pa.reconciled_order_id, pa.reconciled_at, pa.created_at,
          c.full_name AS customer_name, c.phone AS customer_phone
        FROM payment_attempts pa
        LEFT JOIN customers c ON c.id = pa.customer_id
        ${where}
        ORDER BY pa.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, limit, offset]);

      const { rows: total } = await pool.query(
        `SELECT COUNT(*) AS total FROM payment_attempts pa ${where}`,
        params
      );

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok:   true,
        data: rows,
        meta: { total: Number(total[0].total), limit, offset },
      }));
    } catch (err) {
      log.error({ err: err.message }, "stats: error en /api/stats/payment-attempts");
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ── GET /api/stats/reconciliation-log ────────────────────────────────────
  if (path === "/api/stats/reconciliation-log" && method === "GET") {
    try {
      const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "50", 10), 200);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0",  10), 0);

      const { rows } = await pool.query(`
        SELECT
          rl.id, rl.order_id, rl.bank_statement_id, rl.payment_attempt_id,
          rl.source, rl.match_level, rl.confidence_score,
          rl.amount_order_bs, rl.amount_source_bs, rl.amount_diff_bs,
          rl.tolerance_used_bs, rl.reference_matched, rl.date_matched,
          rl.resolved_by, rl.status, rl.created_at,
          so.source AS order_source, so.external_order_id, so.order_total_amount
        FROM reconciliation_log rl
        LEFT JOIN sales_orders so ON so.id = rl.order_id
        ORDER BY rl.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const { rows: cnt } = await pool.query(`SELECT COUNT(*) AS total FROM reconciliation_log`);

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok:   true,
        data: rows,
        meta: { total: Number(cnt[0].total), limit, offset },
      }));
    } catch (err) {
      log.error({ err: err.message }, "stats: error en /api/stats/reconciliation-log");
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  return false;
}

module.exports = { handleStatsApiRequest };
