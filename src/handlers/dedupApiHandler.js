"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { mergeCustomers } = require("../services/customerMergeService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "dedup_api" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 256 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

function parsePositiveInt(s) {
  const t = String(s).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function customerMini(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    full_name: row.full_name,
    phone: row.phone,
    id_type: row.id_type,
    id_number: row.id_number,
  };
}

async function handleDedupApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/dedup")) return false;

  applyCrmApiCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const user = await requireAdminOrPermission(req, res, "settings");
  if (!user) return true;

  const companyId = user.companyId != null ? Number(user.companyId) : 1;

  try {
    if (req.method === "GET" && pathname === "/api/dedup/merge-log") {
      try {
        const rawLimit = url.searchParams.get("limit");
        const rawOffset = url.searchParams.get("offset");
        const limitParsed =
          rawLimit == null || rawLimit === "" ? 20 : parseInt(rawLimit, 10);
        if (!Number.isFinite(limitParsed) || limitParsed < 1) {
          writeJson(res, 400, { code: "INVALID_LIMIT", message: "limit inválido" });
          return true;
        }
        if (limitParsed > 100) {
          writeJson(res, 400, {
            code: "LIMIT_TOO_HIGH",
            message: "limit máximo es 100",
          });
          return true;
        }
        const limit = limitParsed;

        const offsetParsed =
          rawOffset == null || rawOffset === "" ? 0 : parseInt(rawOffset, 10);
        if (!Number.isFinite(offsetParsed) || offsetParsed < 0) {
          writeJson(res, 400, { code: "INVALID_OFFSET", message: "offset inválido" });
          return true;
        }
        const offset = offsetParsed;

        const rawCompanyId = url.searchParams.get("company_id");
        let effectiveCompanyId;
        if (rawCompanyId != null && rawCompanyId !== "") {
          const n = parseInt(rawCompanyId, 10);
          if (!Number.isFinite(n) || n <= 0) {
            writeJson(res, 400, { code: "INVALID_COMPANY_ID", message: "company_id inválido" });
            return true;
          }
          effectiveCompanyId = n;
        } else {
          effectiveCompanyId = companyId;
        }

        const fromParam = url.searchParams.get("from");
        const toParam = url.searchParams.get("to");
        if (fromParam != null && fromParam !== "") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(fromParam)) {
            writeJson(res, 400, { code: "INVALID_FROM", message: "from debe ser YYYY-MM-DD" });
            return true;
          }
        }
        if (toParam != null && toParam !== "") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
            writeJson(res, 400, { code: "INVALID_TO", message: "to debe ser YYYY-MM-DD" });
            return true;
          }
        }

        const triggeredRaw = url.searchParams.get("triggered_by");
        const allowedTriggered = new Set(["auto_worker", "api_approved", "manual"]);
        if (triggeredRaw != null && triggeredRaw !== "") {
          if (!allowedTriggered.has(triggeredRaw)) {
            writeJson(res, 400, {
              code: "INVALID_TRIGGERED_BY",
              message: "triggered_by no válido",
            });
            return true;
          }
        }

        const cond = ["ml.company_id = $1"];
        const params = [effectiveCompanyId];
        let p = 2;
        if (triggeredRaw != null && triggeredRaw !== "") {
          cond.push(`ml.triggered_by = $${p++}`);
          params.push(triggeredRaw);
        }
        if (fromParam != null && fromParam !== "") {
          cond.push(`ml.merged_at::date >= $${p++}::date`);
          params.push(fromParam);
        }
        if (toParam != null && toParam !== "") {
          cond.push(`ml.merged_at::date <= $${p++}::date`);
          params.push(toParam);
        }
        const where = cond.join(" AND ");

        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM customer_merge_log ml WHERE ${where}`,
          params
        );
        const total = countRows[0] ? Number(countRows[0].n) : 0;

        const listParams = [...params, limit, offset];
        const { rows } = await pool.query(
          `SELECT
            ml.id,
            ml.company_id,
            ml.kept_id,
            ml.dropped_id,
            ml.triggered_by,
            ml.score,
            ml.score_breakdown,
            ml.snapshot_kept,
            ml.snapshot_dropped,
            ml.rows_affected,
            ml.merged_at,
            ck.full_name AS kept_name,
            ck.id_type AS kept_id_type,
            ck.id_number AS kept_id_number,
            ck.phone AS kept_phone
          FROM customer_merge_log ml
          LEFT JOIN customers ck ON ck.id = ml.kept_id
          WHERE ${where}
          ORDER BY ml.merged_at DESC
          LIMIT $${p} OFFSET $${p + 1}`,
          listParams
        );

        const logEntries = rows.map((r) => ({
          id: Number(r.id),
          company_id: Number(r.company_id),
          kept_id: Number(r.kept_id),
          dropped_id: Number(r.dropped_id),
          kept_name: r.kept_name,
          kept_id_type: r.kept_id_type,
          kept_id_number: r.kept_id_number,
          kept_phone: r.kept_phone,
          triggered_by: r.triggered_by,
          score: r.score != null ? Number(r.score) : null,
          score_breakdown: r.score_breakdown,
          snapshot_kept: r.snapshot_kept,
          snapshot_dropped: r.snapshot_dropped,
          rows_affected: r.rows_affected,
          merged_at: r.merged_at,
        }));

        writeJson(res, 200, { log: logEntries, total, limit, offset });
        return true;
      } catch (err) {
        console.error("[dedup/merge-log] failed", err);
        writeJson(res, 500, {
          code: "MERGE_LOG_ERROR",
          message: String(err && err.message ? err.message : err),
        });
        return true;
      }
    }

    if (req.method === "GET" && pathname === "/api/dedup/candidates") {
      const status = url.searchParams.get("status") || undefined;
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

      const cond = ["mc.company_id = $1"];
      const params = [companyId];
      let p = 2;
      if (status) {
        cond.push(`mc.status = $${p++}`);
        params.push(status);
      }
      const where = cond.join(" AND ");

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM merge_candidates mc WHERE ${where}`,
        params
      );
      const total = countRows[0] ? Number(countRows[0].n) : 0;

      const listParams = [...params, limit, offset];
      const { rows } = await pool.query(
        `SELECT mc.*,
                ca.full_name AS ca_full_name, ca.phone AS ca_phone,
                ca.id_type AS ca_id_type, ca.id_number AS ca_id_number,
                cb.full_name AS cb_full_name, cb.phone AS cb_phone,
                cb.id_type AS cb_id_type, cb.id_number AS cb_id_number
         FROM merge_candidates mc
         JOIN customers ca ON ca.id = mc.customer_id_a
         JOIN customers cb ON cb.id = mc.customer_id_b
         WHERE ${where}
         ORDER BY mc.updated_at DESC NULLS LAST, mc.id DESC
         LIMIT $${p} OFFSET $${p + 1}`,
        listParams
      );

      const candidates = rows.map((r) => ({
        id: Number(r.id),
        company_id: Number(r.company_id),
        customer_a: {
          id: Number(r.customer_id_a),
          full_name: r.ca_full_name,
          phone: r.ca_phone,
          id_type: r.ca_id_type,
          id_number: r.ca_id_number,
        },
        customer_b: {
          id: Number(r.customer_id_b),
          full_name: r.cb_full_name,
          phone: r.cb_phone,
          id_type: r.cb_id_type,
          id_number: r.cb_id_number,
        },
        score: Number(r.score),
        score_breakdown: r.score_breakdown,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at,
      }));

      writeJson(res, 200, { candidates, total });
      return true;
    }

    const oneMatch = pathname.match(/^\/api\/dedup\/candidates\/(\d+)$/);
    if (req.method === "GET" && oneMatch) {
      const id = parsePositiveInt(oneMatch[1]);
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }

      const { rows: mc } = await pool.query(
        `SELECT mc.*,
                ca.full_name AS ca_full_name, ca.phone AS ca_phone,
                ca.id_type AS ca_id_type, ca.id_number AS ca_id_number,
                cb.full_name AS cb_full_name, cb.phone AS cb_phone,
                cb.id_type AS cb_id_type, cb.id_number AS cb_id_number
         FROM merge_candidates mc
         JOIN customers ca ON ca.id = mc.customer_id_a
         JOIN customers cb ON cb.id = mc.customer_id_b
         WHERE mc.id = $1 AND mc.company_id = $2`,
        [id, companyId]
      );
      if (!mc.length) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      const r = mc[0];
      const { rows: logs } = await pool.query(
        `SELECT snapshot_kept, snapshot_dropped, rows_affected, merged_at, triggered_by, score, score_breakdown
         FROM customer_merge_log
         WHERE company_id = $1
           AND (
             (kept_id = $2 AND dropped_id = $3)
             OR (kept_id = $3 AND dropped_id = $2)
           )
         ORDER BY merged_at DESC
         LIMIT 3`,
        [companyId, r.customer_id_a, r.customer_id_b]
      );

      writeJson(res, 200, {
        id: Number(r.id),
        company_id: Number(r.company_id),
        customer_a: {
          id: Number(r.customer_id_a),
          full_name: r.ca_full_name,
          phone: r.ca_phone,
          id_type: r.ca_id_type,
          id_number: r.ca_id_number,
        },
        customer_b: {
          id: Number(r.customer_id_b),
          full_name: r.cb_full_name,
          phone: r.cb_phone,
          id_type: r.cb_id_type,
          id_number: r.cb_id_number,
        },
        score: Number(r.score),
        score_breakdown: r.score_breakdown,
        status: r.status,
        created_at: r.created_at,
        merge_log: logs.length ? logs : null,
      });
      return true;
    }

    const approveMatch = pathname.match(/^\/api\/dedup\/candidates\/(\d+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const id = parsePositiveInt(approveMatch[1]);
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const body = await parseJsonBody(req);
      const keepId = parsePositiveInt(body.keep_customer_id);
      if (keepId == null) {
        writeJson(res, 400, { error: "keep_customer_id_required" });
        return true;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: mc } = await client.query(
          `SELECT * FROM merge_candidates WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [id, companyId]
        );
        if (!mc.length) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { error: "not_found" });
          return true;
        }
        const row = mc[0];
        const a = Number(row.customer_id_a);
        const b = Number(row.customer_id_b);
        if (keepId !== a && keepId !== b) {
          await client.query("ROLLBACK");
          writeJson(res, 400, { error: "keep_not_in_pair" });
          return true;
        }
        const dropId = keepId === a ? b : a;

        await client.query(
          `UPDATE merge_candidates
           SET status = 'approved', reviewed_by = $1, reviewed_at = now(), updated_at = now()
           WHERE id = $2`,
          [user.userId != null ? Number(user.userId) : null, id]
        );

        const result = await mergeCustomers(keepId, dropId, {
          triggeredBy: "api_approved",
          score: row.score,
          scoreBreakdown: row.score_breakdown,
          dbClient: client,
        });

        await client.query("COMMIT");
        writeJson(res, 200, { merged: true, ...result });
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_r) {
          /* ignore */
        }
        if (e && e.code === "SALES_REASSIGN_CONFLICT") {
          writeJson(res, 409, { error: e.code, message: e.message });
          return true;
        }
        log.error({ err: e }, "dedup_approve");
        writeJson(res, 500, { error: "merge_failed", message: String(e.message) });
      } finally {
        client.release();
      }
      return true;
    }

    const rejectMatch = pathname.match(/^\/api\/dedup\/candidates\/(\d+)\/reject$/);
    if (req.method === "POST" && rejectMatch) {
      const id = parsePositiveInt(rejectMatch[1]);
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }

      const { rowCount } = await pool.query(
        `UPDATE merge_candidates
         SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), updated_at = now()
         WHERE id = $2 AND company_id = $3`,
        [user.userId != null ? Number(user.userId) : null, id, companyId]
      );
      if (!rowCount) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { rejected: true });
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    log.error({ err: e }, "dedup_api");
    writeJson(res, 500, { error: "internal_error" });
    return true;
  }
}

module.exports = { handleDedupApiRequest };
