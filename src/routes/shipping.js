"use strict";

const { pool } = require("../../db-postgres");
const { ensureAdmin } = require("../middleware/adminAuth");
const { rejectDuringDowntime } = require("../utils/sessionGuard");
const shippingService = require("../services/shippingService");

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

function parseIdFromPath(pathname, regex) {
  const m = pathname.match(regex);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const COMPANY_ID = 1;

async function handleShippingApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/shipping")) return false;

  const isMut =
    req.method === "POST" ||
    req.method === "PATCH" ||
    req.method === "PUT" ||
    req.method === "DELETE";

  try {
    // ── Settings ─────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/shipping/settings") {
      if (!ensureAdmin(req, res, url)) return true;
      const s = await shippingService.getShippingSettings(COMPANY_ID);
      writeJson(res, 200, { ok: true, data: s });
      return true;
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/shipping/settings/")) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const key = decodeURIComponent(url.pathname.slice("/api/shipping/settings/".length));
      if (!key || key.includes("/")) {
        writeJson(res, 400, { ok: false, error: "key inválida" });
        return true;
      }
      const body = await parseJsonBody(req);
      try {
        const out = await shippingService.updateShippingSetting({
          key,
          value: body.value,
          companyId: COMPANY_ID,
          updatedBy: body.user_id,
          notes: body.notes,
        });
        writeJson(res, 200, { ok: true, ...out });
      } catch (e) {
        const st = e.status || 500;
        writeJson(res, st, { ok: false, error: e.message, code: e.code });
      }
      return true;
    }

    // ── Quote (antes de /providers/:id para no capturar "quote" como id) ─
    if (req.method === "POST" && url.pathname === "/api/shipping/quote/all") {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const mode = String(body.shipment_mode || "").trim();
      const cbm = parseFloat(body.total_cbm || 0);
      const kg = parseFloat(body.total_kg || 0);
      if (!mode) {
        writeJson(res, 400, { ok: false, error: "shipment_mode obligatorio" });
        return true;
      }
      if (!(cbm > 0) && !(kg > 0)) {
        writeJson(res, 400, { ok: false, error: "total_cbm o total_kg debe ser > 0" });
        return true;
      }
      const quotes = await shippingService.quoteAllProviders({
        categoryId: body.category_id != null ? Number(body.category_id) : null,
        shipmentMode: mode,
        totalCbm: cbm,
        totalKg: kg,
        companyId: COMPANY_ID,
        date: body.date || null,
      });
      if (!quotes.length) {
        writeJson(res, 200, {
          ok: true,
          quotes: [],
          message: "Sin proveedores configurados para este modo",
        });
        return true;
      }
      writeJson(res, 200, { ok: true, quotes });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/quote") {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const pid = Number(body.provider_id);
      const mode = String(body.shipment_mode || "").trim();
      const cbm = parseFloat(body.total_cbm || 0);
      const kg = parseFloat(body.total_kg || 0);
      if (!Number.isFinite(pid) || pid <= 0 || !mode) {
        writeJson(res, 400, { ok: false, error: "provider_id y shipment_mode obligatorios" });
        return true;
      }
      if (!(cbm > 0) && !(kg > 0)) {
        writeJson(res, 400, { ok: false, error: "total_cbm o total_kg debe ser > 0" });
        return true;
      }
      try {
        const row = await shippingService.calculateFreight({
          providerId: pid,
          categoryId: body.category_id != null ? Number(body.category_id) : null,
          shipmentMode: mode,
          totalCbm: cbm,
          totalKg: kg,
          date: body.date || null,
        });
        writeJson(res, 200, { ok: true, data: row });
      } catch (e) {
        if (e.code === "NO_RATE") {
          writeJson(res, 404, { ok: false, error: e.message, code: e.code });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/rates") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const pid = Number(body.provider_id);
      const mode = String(body.shipment_mode || "").trim();
      if (!Number.isFinite(pid) || pid <= 0 || !mode) {
        writeJson(res, 400, { ok: false, error: "provider_id y shipment_mode obligatorios (rate_basis opcional → default_rate_basis)" });
        return true;
      }
      try {
        const out = await shippingService.setRate(body);
        writeJson(res, out.inserted ? 201 : 200, { ok: true, inserted: out.inserted, data: out.rate });
      } catch (e) {
        const st = e.status || 500;
        writeJson(res, st, { ok: false, error: e.message, code: e.code });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/assign-category") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const skus = body.skus;
      const cid = Number(body.category_id);
      if (!Array.isArray(skus) || skus.length === 0 || !Number.isFinite(cid) || cid <= 0) {
        writeJson(res, 400, { ok: false, error: "category_id y skus (array) obligatorios" });
        return true;
      }
      const out = await shippingService.assignCategoryToProducts({ categoryId: cid, skus });
      writeJson(res, 200, { ok: true, updated: out.updated });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/shipping/unassigned-products") {
      if (!ensureAdmin(req, res, url)) return true;
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("page_size") || 500);
      const data = await shippingService.getUnassignedProducts({ page, pageSize });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    // ── Providers ─────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/shipping/providers") {
      if (!ensureAdmin(req, res, url)) return true;
      const scope = url.searchParams.get("scope") || null;
      const ia = url.searchParams.get("is_active");
      const isActive = ia !== undefined && ia !== null && ia !== "" ? ia === "true" : null;
      const rows = await shippingService.listProviders({
        companyId: COMPANY_ID,
        scope,
        isActive,
      });
      writeJson(res, 200, { ok: true, rows });
      return true;
    }

    if (req.method === "GET" && /^\/api\/shipping\/providers\/\d+$/.test(url.pathname)) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = parseIdFromPath(url.pathname, /^\/api\/shipping\/providers\/(\d+)$/);
      if (!id) {
        writeJson(res, 400, { ok: false, error: "id inválido" });
        return true;
      }
      const p = await shippingService.getProvider(id);
      if (!p) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: p });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/providers") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const name = String(body.name || "").trim();
      const scope = String(body.scope || "").trim();
      if (body.transport_mode && !body.scope) {
        if (!name) {
          writeJson(res, 400, { ok: false, error: "name obligatorio" });
          return true;
        }
        const { rows } = await pool.query(
          `INSERT INTO shipping_providers
             (company_id, name, transport_mode, contact_email, contact_phone, notes, scope)
           VALUES ($1,$2,COALESCE($3::transport_mode,'SEA'::transport_mode),$4,$5,$6,COALESCE($7::shipping_scope,'BOTH'::shipping_scope))
           RETURNING *`,
          [
            Number(body.company_id || COMPANY_ID),
            name,
            body.transport_mode || "SEA",
            body.contact_email || null,
            body.contact_phone || null,
            body.notes || null,
            body.scope || null,
          ]
        );
        writeJson(res, 201, { ok: true, data: rows[0] || null });
        return true;
      }
      if (!name || !scope) {
        writeJson(res, 400, { ok: false, error: "name y scope obligatorios (o transport_mode para modo legacy)" });
        return true;
      }
      const allowedScope = new Set(["INTERNATIONAL", "NATIONAL", "BOTH"]);
      if (!allowedScope.has(scope)) {
        writeJson(res, 400, { ok: false, error: "scope inválido" });
        return true;
      }
      try {
        const row = await shippingService.createProvider({
          companyId: COMPANY_ID,
          name,
          scope,
          contactName: body.contact_name,
          contactEmail: body.contact_email,
          contactPhone: body.contact_phone,
          originCountry: body.origin_country,
          destination: body.destination,
          notes: body.notes,
        });
        writeJson(res, 201, { ok: true, data: row });
      } catch (e) {
        if (e.status === 409) {
          writeJson(res, 409, { ok: false, error: e.message, code: e.code });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "PATCH" && /^\/api\/shipping\/providers\/\d+$/.test(url.pathname)) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const id = parseIdFromPath(url.pathname, /^\/api\/shipping\/providers\/(\d+)$/);
      if (!id) {
        writeJson(res, 400, { ok: false, error: "id inválido" });
        return true;
      }
      const body = await parseJsonBody(req);
      const row = await shippingService.updateProvider({
        providerId: id,
        ...body,
      });
      if (!row) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    // ── Categories ───────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/shipping/categories") {
      if (!ensureAdmin(req, res, url)) return true;
      const companyId = Number(url.searchParams.get("company_id") || COMPANY_ID);
      const providerId = url.searchParams.get("provider_id");
      if (providerId) {
        let sql = `SELECT * FROM shipping_categories WHERE company_id = $1 AND provider_id = $2`;
        const { rows } = await pool.query(`${sql} ORDER BY name`, [companyId, Number(providerId)]);
        writeJson(res, 200, { ok: true, rows });
        return true;
      }
      const rows = await shippingService.listCategories(companyId);
      writeJson(res, 200, { ok: true, rows });
      return true;
    }

    if (req.method === "GET" && /^\/api\/shipping\/categories\/\d+$/.test(url.pathname)) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = parseIdFromPath(url.pathname, /^\/api\/shipping\/categories\/(\d+)$/);
      if (!id) {
        writeJson(res, 400, { ok: false, error: "id inválido" });
        return true;
      }
      const c = await shippingService.getCategory(id);
      if (!c) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: c });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/shipping/categories") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const name = String(body.name || "").trim();
      if (!name) {
        writeJson(res, 400, { ok: false, error: "name obligatorio" });
        return true;
      }
      if (body.provider_id != null) {
        const { rows } = await pool.query(
          `INSERT INTO shipping_categories
             (company_id, provider_id, name, transport_mode, rate_per_cbm,
              min_charge_cbm, avg_volume_cbm, valid_from, notes, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date,CURRENT_DATE),$9,$10)
           RETURNING *`,
          [
            Number(body.company_id || COMPANY_ID),
            Number(body.provider_id),
            name,
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
      const vf = body.volumetric_factor != null ? Number(body.volumetric_factor) : undefined;
      if (vf !== undefined && (!Number.isFinite(vf) || vf <= 0)) {
        writeJson(res, 400, { ok: false, error: "volumetric_factor inválido" });
        return true;
      }
      try {
        const row = await shippingService.createCategory({
          companyId: COMPANY_ID,
          name,
          description: body.description,
          volumetricFactor: vf,
          isDefault: body.is_default,
        });
        writeJson(res, 201, { ok: true, data: row });
      } catch (e) {
        if (e.status === 409) {
          writeJson(res, 409, { ok: false, error: e.message });
        } else {
          throw e;
        }
      }
      return true;
    }

    if (req.method === "PATCH" && /^\/api\/shipping\/categories\/\d+\/rate$/.test(url.pathname)) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
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

    if (req.method === "GET" && /^\/api\/shipping\/categories\/\d+\/rate-history$/.test(url.pathname)) {
      if (!ensureAdmin(req, res, url)) return true;
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

    // ── Legacy product assign / unassigned ─────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/shipping/products/assign") {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const result = await shippingService.assignCategoryToProductsLegacy(body);
      writeJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/shipping/products/unassigned") {
      if (!ensureAdmin(req, res, url)) return true;
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("page_size") || 100);
      const data = await shippingService.getUnassignedProducts({ page, pageSize });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && /^\/api\/shipping\/shipments\/\d+\/validate$/.test(url.pathname)) {
      if (!ensureAdmin(req, res, url)) return true;
      const shipmentId = parseIdFromPath(url.pathname, /^\/api\/shipping\/shipments\/(\d+)\/validate$/);
      if (!shipmentId) {
        writeJson(res, 400, { ok: false, error: "shipment id inválido" });
        return true;
      }
      const result = await shippingService.validateShippingData(shipmentId);
      if (!result.valid) {
        writeJson(res, 422, { ok: false, error: "MISSING_SHIPPING_DATA", skus: result.errors });
        return true;
      }
      writeJson(res, 200, { ok: true, valid: true });
      return true;
    }

    if (req.method === "POST" && /^\/api\/shipping\/shipments\/\d+\/refresh-rates$/.test(url.pathname)) {
      if (rejectDuringDowntime(req, res)) return true;
      if (!ensureAdmin(req, res, url)) return true;
      const shipmentId = parseIdFromPath(url.pathname, /^\/api\/shipping\/shipments\/(\d+)\/refresh-rates$/);
      if (!shipmentId) {
        writeJson(res, 400, { ok: false, error: "shipment id inválido" });
        return true;
      }
      const { rows: shipRows } = await pool.query(`SELECT id, status FROM import_shipments WHERE id = $1`, [
        shipmentId,
      ]);
      const shipment = shipRows[0] || null;
      if (!shipment) {
        writeJson(res, 404, { ok: false, error: "shipment no encontrado" });
        return true;
      }
      if (["CLOSED", "CANCELLED"].includes(String(shipment.status || "").toUpperCase())) {
        writeJson(res, 409, { ok: false, error: "Shipment cerrado - no se puede refrescar" });
        return true;
      }

      const { rows: beforeRows } = await pool.query(
        `SELECT rate_snapshot_cbm
         FROM import_shipment_lines
         WHERE shipment_id = $1
           AND rate_snapshot_cbm IS NOT NULL`,
        [shipmentId]
      );
      const previousRates = beforeRows.map((r) => Number(r.rate_snapshot_cbm)).filter((n) => Number.isFinite(n) && n > 0);
      const previousRate =
        previousRates.length > 0
          ? Number((previousRates.reduce((a, b) => a + b, 0) / previousRates.length).toFixed(4))
          : null;

      const out = await shippingService.calculateFreightByCbm(shipmentId);

      const { rows: afterRows } = await pool.query(
        `SELECT rate_snapshot_cbm
         FROM import_shipment_lines
         WHERE shipment_id = $1
           AND rate_snapshot_cbm IS NOT NULL`,
        [shipmentId]
      );
      const newRates = afterRows.map((r) => Number(r.rate_snapshot_cbm)).filter((n) => Number.isFinite(n) && n > 0);
      const newRate =
        newRates.length > 0
          ? Number((newRates.reduce((a, b) => a + b, 0) / newRates.length).toFixed(4))
          : null;

      writeJson(res, 200, { ok: true, ...out, previous_rate: previousRate, new_rate: newRate });
      return true;
    }

    if (isMut) {
      writeJson(res, 405, { ok: false, error: "método o ruta no soportada" });
      return true;
    }
    writeJson(res, 404, { ok: false, error: "no encontrado" });
    return true;
  } catch (e) {
    if (e && e.code === "MISSING_SHIPPING_DATA") {
      writeJson(res, 422, { ok: false, error: "MISSING_SHIPPING_DATA", skus: e.details || [] });
      return true;
    }
    writeJson(res, 500, { ok: false, error: e.message || String(e) });
    return true;
  }
}

module.exports = {
  handleShippingApiRequest,
};
