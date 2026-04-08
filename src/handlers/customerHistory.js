"use strict";

const { z } = require("zod");
const { pool } = require("../../db");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { authAdminOrFrontend } = require("../middleware/authFlex");
const { safeParse } = require("../middleware/validateCrm");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function mapSchemaError(err) {
  const c = err && err.code;
  if (c === "42P01" || c === "42P04") {
    const e = new Error("schema_missing");
    e.code = "SCHEMA_MISSING";
    return e;
  }
  return err;
}

function parsePositiveInt(s) {
  const t = String(s).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  source: z.enum(["mercadolibre", "mostrador"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * GET /api/customers/:id/history
 */
async function handleCustomerHistoryRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (req.method !== "GET" || !/^\/api\/customers\/\d+\/history$/.test(pathname)) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  const auth = authAdminOrFrontend(req);
  if (!auth.ok) {
    writeJson(res, auth.status, auth.body);
    return true;
  }

  const id = parsePositiveInt(pathname.replace(/^\/api\/customers\//, "").replace(/\/history$/, ""));
  if (id == null) {
    writeJson(res, 400, { error: "invalid_id" });
    return true;
  }

  try {
    const { rows: ex } = await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [id]);
    if (!ex.length) {
      writeJson(res, 404, { error: "Customer not found" });
      return true;
    }
  } catch (e) {
    writeJson(res, 500, { error: "error", message: String(e.message) });
    return true;
  }

  const qraw = Object.fromEntries(url.searchParams.entries());
  const parsed = safeParse(querySchema, qraw);
  if (!parsed.ok) {
    writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
    return true;
  }
  const q = parsed.data;

  const limit = q.limit ?? 20;
  const offset = q.offset ?? 0;

  let fromTs = null;
  let toTs = null;
  if (q.from) {
    const d = new Date(q.from);
    if (!Number.isNaN(d.getTime())) fromTs = d.toISOString();
  }
  if (q.to) {
    const d = new Date(q.to);
    if (!Number.isNaN(d.getTime())) toTs = d.toISOString();
  }

  const src = q.source;

  const sqlMl = `
    SELECT
      'mercadolibre'::text AS source,
      mo.order_id::text AS order_id,
      COALESCE(mo.date_created::text, mo.fetched_at::text) AS ordered_at,
      COALESCE(mo.date_created::timestamptz, mo.fetched_at::timestamptz) AS ordered_at_ts,
      mo.total_amount AS amount_usd,
      mo.currency_id AS currency,
      mo.status AS order_status,
      NULL::jsonb AS items_json
    FROM customer_ml_buyers cmb
    JOIN ml_buyers mb ON mb.buyer_id = cmb.ml_buyer_id
    JOIN ml_orders mo ON mo.buyer_id = mb.buyer_id
    WHERE cmb.customer_id = $1
      AND ($2::timestamptz IS NULL OR COALESCE(mo.date_created::timestamptz, mo.fetched_at::timestamptz) >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR COALESCE(mo.date_created::timestamptz, mo.fetched_at::timestamptz) <= $3::timestamptz)
  `;

  const sqlMo = `
    SELECT
      'mostrador'::text AS source,
      mo.id::text AS order_id,
      mo.created_at::text AS ordered_at,
      mo.created_at AS ordered_at_ts,
      mo.total_amount_usd AS amount_usd,
      'USD'::text AS currency,
      'completed'::text AS order_status,
      mo.items_json
    FROM crm_mostrador_orders mo
    WHERE mo.customer_id = $1
      AND ($2::timestamptz IS NULL OR mo.created_at >= $2::timestamptz)
      AND ($3::timestamptz IS NULL OR mo.created_at <= $3::timestamptz)
  `;

  try {
    let innerSql;
    if (src === "mercadolibre") {
      innerSql = sqlMl;
    } else if (src === "mostrador") {
      innerSql = sqlMo;
    } else {
      innerSql = `(${sqlMl}) UNION ALL (${sqlMo})`;
    }

    const countSql = `SELECT COUNT(*)::bigint AS n FROM (${innerSql}) u`;
    const { rows: countRows } = await pool.query(countSql, [id, fromTs, toTs]);
    const total = Number(countRows[0].n) || 0;

    const { rows } = await pool.query(
      `SELECT * FROM (${innerSql}) u
       ORDER BY u.ordered_at_ts DESC NULLS LAST
       LIMIT $4 OFFSET $5`,
      [id, fromTs, toTs, limit, offset]
    );

    const orders = rows.map((r) => ({
      source: r.source,
      order_id: r.order_id,
      ordered_at: r.ordered_at,
      amount_usd: r.amount_usd != null ? Number(r.amount_usd) : null,
      currency: r.currency,
      order_status: r.order_status,
      items_json: r.items_json,
    }));

    writeJson(res, 200, {
      data: {
        customer_id: id,
        orders,
        pagination: {
          limit,
          offset,
          total,
          has_more: offset + orders.length < total,
        },
      },
      meta: { timestamp: new Date().toISOString() },
    });
    return true;
  } catch (e) {
    const m = mapSchemaError(e);
    if (m.code === "SCHEMA_MISSING") {
      writeJson(res, 503, { error: "schema_missing", detail: String(e.message) });
      return true;
    }
    if (e && e.code === "42P01" && String(e.message || "").includes("crm_mostrador_orders")) {
      writeJson(res, 503, {
        error: "schema_missing",
        detail: "Ejecutar sql/20260408_mostrador_orders.sql para historial mostrador",
      });
      return true;
    }
    writeJson(res, 500, { error: "error", message: String(e.message) });
    return true;
  }
}

module.exports = { handleCustomerHistoryRequest };
