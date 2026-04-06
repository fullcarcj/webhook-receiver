"use strict";

const { pool } = require("../../db-postgres");
const { timingSafeCompare } = require("../services/currencyService");
const {
  validateShippingData,
  calculateFreightByCbm,
  assignCategoryToProducts,
  getUnassignedProducts,
} = require("../services/shippingService");

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
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  const provided = req.headers["x-admin-secret"];
  if (!timingSafeCompare(provided, secret)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

function parseIdFromPath(pathname, regex) {
  const m = pathname.match(regex);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function handleShippingApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/shipping")) return false;

  try {
    if (req.method === "POST" && url.pathname === "/api/shipping/providers") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const { rows } = await pool.query(
        `INSERT INTO shipping_providers
           (company_id, name, transport_mode, contact_email, contact_phone, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          Number(body.company_id || 1),
          body.name,
          body.transport_mode || "SEA",
          body.contact_email || null,
          body.contact_phone || null,
          body.notes || null,
        ]
      );
      writeJson(res, 201, { ok: true, data: rows[0] || null });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/shipping/providers") {
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const { rows } = await pool.query(
        `SELECT * FROM shipping_providers
         WHERE company_id = $1 AND is_active = TRUE
         ORDER BY name`,
        [companyId]
      );
      writeJson(res, 200, { ok: true, rows });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/categories") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const { rows } = await pool.query(
        `INSERT INTO shipping_categories
           (company_id, provider_id, name, transport_mode, rate_per_cbm,
            min_charge_cbm, avg_volume_cbm, valid_from, notes, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date,CURRENT_DATE),$9,$10)
         RETURNING *`,
        [
          Number(body.company_id || 1),
          Number(body.provider_id),
          body.name,
          body.transport_mode || "SEA",
          body.rate_per_cbm,
          body.min_charge_cbm != null ? body.min_charge_cbm : 0.1,
          body.avg_volume_cbm != null ? body.avg_volume_cbm : null,
          body.valid_from || null,
          body.notes || null,
          body.description || null,
        ]
      );
      writeJson(res, 201, { ok: true, data: rows[0] || null });
      return true;
    }

    if (req.method === "PATCH" && /^\/api\/shipping\/categories\/\d+\/rate$/.test(url.pathname)) {
      if (!ensureAdmin(req, res)) return true;
      const id = parseIdFromPath(url.pathname, /^\/api\/shipping\/categories\/(\d+)\/rate$/);
      if (!id) {
        writeJson(res, 400, { ok: false, error: "id inválido" });
        return true;
      }
      const body = await parseJsonBody(req);
      const { rows } = await pool.query(
        `UPDATE shipping_categories SET
           rate_per_cbm = $1,
           min_charge_cbm = COALESCE($2, min_charge_cbm),
           updated_at = now()
         WHERE id = $3
         RETURNING *`,
        [body.rate_per_cbm, body.min_charge_cbm != null ? body.min_charge_cbm : null, id]
      );
      writeJson(res, rows[0] ? 200 : 404, rows[0] ? { ok: true, data: rows[0] } : { ok: false, error: "not_found" });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/shipping/categories") {
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const providerId = url.searchParams.get("provider_id");
      let sql = `SELECT * FROM shipping_categories WHERE company_id = $1`;
      const params = [companyId];
      if (providerId) {
        sql += ` AND provider_id = $2`;
        params.push(Number(providerId));
      }
      sql += ` ORDER BY name`;
      const { rows } = await pool.query(sql, params);
      writeJson(res, 200, { ok: true, rows });
      return true;
    }

    if (req.method === "GET" && /^\/api\/shipping\/categories\/\d+\/rate-history$/.test(url.pathname)) {
      const id = parseIdFromPath(url.pathname, /^\/api\/shipping\/categories\/(\d+)\/rate-history$/);
      if (!id) {
        writeJson(res, 400, { ok: false, error: "id inválido" });
        return true;
      }
      const { rows } = await pool.query(
        `SELECT * FROM shipping_rate_history
         WHERE shipping_category_id = $1
         ORDER BY effective_from DESC`,
        [id]
      );
      writeJson(res, 200, { ok: true, rows });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/products/assign") {
      if (!ensureAdmin(req, res)) return true;
      const body = await parseJsonBody(req);
      const result = await assignCategoryToProducts(body);
      writeJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/shipping/products/unassigned") {
      if (!ensureAdmin(req, res)) return true;
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("page_size") || 100);
      const data = await getUnassignedProducts({ page, pageSize });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && /^\/api\/shipping\/shipments\/\d+\/validate$/.test(url.pathname)) {
      if (!ensureAdmin(req, res)) return true;
      const shipmentId = parseIdFromPath(url.pathname, /^\/api\/shipping\/shipments\/(\d+)\/validate$/);
      if (!shipmentId) {
        writeJson(res, 400, { ok: false, error: "shipment id inválido" });
        return true;
      }
      const result = await validateShippingData(shipmentId);
      if (!result.valid) {
        writeJson(res, 422, { error: "MISSING_SHIPPING_DATA", skus: result.errors });
        return true;
      }
      writeJson(res, 200, { valid: true });
      return true;
    }

    if (req.method === "POST" && /^\/api\/shipping\/shipments\/\d+\/refresh-rates$/.test(url.pathname)) {
      if (!ensureAdmin(req, res)) return true;
      const shipmentId = parseIdFromPath(url.pathname, /^\/api\/shipping\/shipments\/(\d+)\/refresh-rates$/);
      if (!shipmentId) {
        writeJson(res, 400, { ok: false, error: "shipment id inválido" });
        return true;
      }
      const { rows: shipRows } = await pool.query(
        `SELECT id, status FROM import_shipments WHERE id = $1`,
        [shipmentId]
      );
      const shipment = shipRows[0] || null;
      if (!shipment) {
        writeJson(res, 404, { ok: false, error: "shipment no encontrado" });
        return true;
      }
      if (["CLOSED", "CANCELLED"].includes(String(shipment.status || "").toUpperCase())) {
        writeJson(res, 409, { error: "Shipment cerrado - no se puede refrescar" });
        return true;
      }

      const { rows: beforeRows } = await pool.query(
        `SELECT rate_snapshot_cbm
         FROM import_shipment_lines
         WHERE shipment_id = $1
           AND rate_snapshot_cbm IS NOT NULL`,
        [shipmentId]
      );
      const previousRates = beforeRows
        .map((r) => Number(r.rate_snapshot_cbm))
        .filter((n) => Number.isFinite(n) && n > 0);
      const previousRate =
        previousRates.length > 0
          ? Number((previousRates.reduce((a, b) => a + b, 0) / previousRates.length).toFixed(4))
          : null;

      const out = await calculateFreightByCbm(shipmentId);

      const { rows: afterRows } = await pool.query(
        `SELECT rate_snapshot_cbm
         FROM import_shipment_lines
         WHERE shipment_id = $1
           AND rate_snapshot_cbm IS NOT NULL`,
        [shipmentId]
      );
      const newRates = afterRows
        .map((r) => Number(r.rate_snapshot_cbm))
        .filter((n) => Number.isFinite(n) && n > 0);
      const newRate =
        newRates.length > 0
          ? Number((newRates.reduce((a, b) => a + b, 0) / newRates.length).toFixed(4))
          : null;

      writeJson(res, 200, { ok: true, ...out, previous_rate: previousRate, new_rate: newRate });
      return true;
    }

    writeJson(res, 405, { ok: false, error: "método no permitido" });
    return true;
  } catch (e) {
    if (e && e.code === "MISSING_SHIPPING_DATA") {
      writeJson(res, 422, { error: "MISSING_SHIPPING_DATA", skus: e.details || [] });
      return true;
    }
    writeJson(res, 500, { ok: false, error: e.message || String(e) });
    return true;
  }
}

module.exports = {
  handleShippingApiRequest,
};

