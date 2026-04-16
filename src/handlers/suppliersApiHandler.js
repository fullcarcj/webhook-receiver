"use strict";

const { pool } = require("../../db");
const { requireAdminOrPermission } = require("../utils/authMiddleware");

const CURRENCIES = new Set(["USD", "BS", "ZELLE", "BINANCE", "PANAMA"]);

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

function parseLimitOffset(url) {
  const lim = Math.min(Math.max(parseInt(String(url.searchParams.get("limit") || "50"), 10) || 50, 1), 200);
  const off = Math.max(parseInt(String(url.searchParams.get("offset") || "0"), 10) || 0, 0);
  return { limit: lim, offset: off };
}

function parsePositiveId(pathSegment) {
  const n = Number(pathSegment);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 */
async function handleSuppliersApiRequest(req, res, url) {
  const pathname = (url.pathname || "").replace(/\/+$/, "") || "/";

  if (!pathname.startsWith("/api/suppliers")) {
    return false;
  }

  try {
    if (req.method === "GET" && (pathname === "/api/suppliers" || pathname === "/api/suppliers/")) {
      if (!await requireAdminOrPermission(req, res, "compras", "read")) return true;
      const { limit, offset } = parseLimitOffset(url);
      const search = url.searchParams.get("search");
      const isActiveRaw = url.searchParams.get("is_active");

      const params = [];
      let p = 1;
      const cond = ["TRUE"];

      if (search != null && String(search).trim() !== "") {
        cond.push(`name ILIKE $${p++}`);
        params.push(`%${String(search).trim()}%`);
      }

      if (isActiveRaw === null || isActiveRaw === "") {
        cond.push(`is_active = TRUE`);
      } else if (isActiveRaw === "true" || isActiveRaw === "1") {
        cond.push(`is_active = TRUE`);
      } else if (isActiveRaw === "false" || isActiveRaw === "0") {
        cond.push(`is_active = FALSE`);
      }

      const where = cond.join(" AND ");
      const countSql = `SELECT COUNT(*)::bigint AS c FROM suppliers WHERE ${where}`;
      const listSql = `
        SELECT id, name, country, lead_time_days, currency, contact_info, is_active, created_at
        FROM suppliers
        WHERE ${where}
        ORDER BY name ASC
        LIMIT $${p++} OFFSET $${p++}
      `;
      const listParams = [...params, limit, offset];

      const [{ rows: cr }, { rows }] = await Promise.all([
        pool.query(countSql, params),
        pool.query(listSql, listParams),
      ]);
      const total = Number(cr[0]?.c || 0);
      writeJson(res, 200, {
        suppliers: rows,
        pagination: { total, limit, offset },
      });
      return true;
    }

    const mId = pathname.match(/^\/api\/suppliers\/(\d+)$/);
    if (mId && req.method === "GET") {
      if (!await requireAdminOrPermission(req, res, "compras", "read")) return true;
      const id = parsePositiveId(mId[1]);
      if (id == null) {
        writeJson(res, 400, { ok: false, error: "invalid_id" });
        return true;
      }
      const { rows: sr } = await pool.query(
        `SELECT id, name, country, lead_time_days, currency, contact_info, is_active, created_at
         FROM suppliers WHERE id = $1`,
        [id]
      );
      if (!sr.length) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      const { rows: recent } = await pool.query(
        `SELECT p.id, p.purchase_date, p.total_usd, p.total_bs, p.status, p.notes
         FROM purchases p
         WHERE p.supplier_id = $1
         ORDER BY p.purchase_date DESC, p.created_at DESC
         LIMIT 10`,
        [id]
      );
      writeJson(res, 200, { supplier: sr[0], recent_purchases: recent });
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/suppliers" || pathname === "/api/suppliers/")) {
      if (!await requireAdminOrPermission(req, res, "compras", "write")) return true;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        if (e instanceof SyntaxError) {
          writeJson(res, 400, { ok: false, error: "invalid_json" });
          return true;
        }
        throw e;
      }
      const name = body.name != null ? String(body.name).trim() : "";
      if (!name) {
        writeJson(res, 422, { ok: false, error: "name_required" });
        return true;
      }
      const country = body.country != null ? String(body.country).trim() : "Venezuela";
      const lead = body.lead_time_days != null ? Number(body.lead_time_days) : 7;
      if (!Number.isFinite(lead) || lead < 0) {
        writeJson(res, 422, { ok: false, error: "invalid_lead_time_days" });
        return true;
      }
      let currency = body.currency != null ? String(body.currency).trim().toUpperCase() : "USD";
      if (!CURRENCIES.has(currency)) {
        writeJson(res, 422, { ok: false, error: "invalid_currency", allowed: [...CURRENCIES] });
        return true;
      }
      const contactInfo = body.contact_info !== undefined ? body.contact_info : null;

      try {
        const { rows } = await pool.query(
          `INSERT INTO suppliers (name, country, lead_time_days, currency, contact_info, is_active)
           VALUES ($1, $2, $3, $4::text, $5::jsonb, TRUE)
           RETURNING id, name, country, lead_time_days, currency, contact_info, is_active, created_at`,
          [name, country, Math.floor(lead), currency, contactInfo]
        );
        writeJson(res, 201, { supplier: rows[0] });
        return true;
      } catch (e) {
        if (e && e.code === "23505") {
          writeJson(res, 409, { ok: false, error: "duplicate_name", message: "Ya existe un proveedor con ese nombre" });
          return true;
        }
        throw e;
      }
    }

    if (mId && req.method === "PATCH") {
      if (!await requireAdminOrPermission(req, res, "compras", "write")) return true;
      const id = parsePositiveId(mId[1]);
      if (id == null) {
        writeJson(res, 400, { ok: false, error: "invalid_id" });
        return true;
      }
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        if (e instanceof SyntaxError) {
          writeJson(res, 400, { ok: false, error: "invalid_json" });
          return true;
        }
        throw e;
      }
      const sets = [];
      const params = [];
      let pi = 1;

      if (body.name != null) {
        sets.push(`name = $${pi++}`);
        params.push(String(body.name).trim());
      }
      if (body.country != null) {
        sets.push(`country = $${pi++}`);
        params.push(String(body.country).trim());
      }
      if (body.lead_time_days != null) {
        const ld = Number(body.lead_time_days);
        if (!Number.isFinite(ld) || ld < 0) {
          writeJson(res, 422, { ok: false, error: "invalid_lead_time_days" });
          return true;
        }
        sets.push(`lead_time_days = $${pi++}`);
        params.push(Math.floor(ld));
      }
      if (body.currency != null) {
        const c = String(body.currency).trim().toUpperCase();
        if (!CURRENCIES.has(c)) {
          writeJson(res, 422, { ok: false, error: "invalid_currency", allowed: [...CURRENCIES] });
          return true;
        }
        sets.push(`currency = $${pi++}`);
        params.push(c);
      }
      if (body.contact_info !== undefined) {
        sets.push(`contact_info = $${pi++}::jsonb`);
        params.push(body.contact_info == null ? null : body.contact_info);
      }
      if (body.is_active !== undefined) {
        sets.push(`is_active = $${pi++}`);
        params.push(Boolean(body.is_active));
      }

      if (sets.length === 0) {
        writeJson(res, 400, { ok: false, error: "no_fields" });
        return true;
      }

      params.push(id);
      try {
        const { rows } = await pool.query(
          `UPDATE suppliers SET ${sets.join(", ")} WHERE id = $${pi} RETURNING id, name, country, lead_time_days, currency, contact_info, is_active, created_at`,
          params
        );
        if (!rows.length) {
          writeJson(res, 404, { ok: false, error: "not_found" });
          return true;
        }
        writeJson(res, 200, { supplier: rows[0] });
        return true;
      } catch (e) {
        if (e && e.code === "23505") {
          writeJson(res, 409, { ok: false, error: "duplicate_name" });
          return true;
        }
        throw e;
      }
    }

    if (mId && req.method === "DELETE") {
      if (!await requireAdminOrPermission(req, res, "compras", "write")) return true;
      const id = parsePositiveId(mId[1]);
      if (id == null) {
        writeJson(res, 400, { ok: false, error: "invalid_id" });
        return true;
      }
      const { rowCount } = await pool.query(`UPDATE suppliers SET is_active = FALSE WHERE id = $1`, [id]);
      if (!rowCount) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true });
      return true;
    }

    return false;
  } catch (e) {
    if (e && e.message === "body_too_large") {
      writeJson(res, 413, { ok: false, error: "body_too_large" });
      return true;
    }
    console.error("[suppliers]", e);
    writeJson(res, 500, { ok: false, error: e && e.message ? String(e.message) : "error" });
    return true;
  }
}

module.exports = { handleSuppliersApiRequest };
