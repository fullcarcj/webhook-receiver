"use strict";

const { z } = require("zod");
const { pool } = require("../../db");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { authAdminOrFrontend, authAdminOnly } = require("../middleware/authFlex");
const { safeParse } = require("../middleware/validateCrm");
const {
  CustomerModel,
  IdentityModel,
  rowToCustomerApi,
  mapSchemaError,
} = require("../services/crmIdentityService");
const loyaltyService = require("../services/loyaltyService");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function parsePositiveInt(s) {
  const t = String(s).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const adjustSchema = z.object({
  points: z.number().int().min(-99999).max(99999).refine((n) => n !== 0),
  reason: z.string().min(3).max(255),
});

const earnSchema = z.object({
  customer_id: z.number().int().positive(),
  order_id: z.union([z.string().min(1), z.number()]),
  amount_usd: z.number().positive(),
  source: z.enum(["mercadolibre", "mostrador"]).default("mercadolibre"),
});

/**
 * GET /api/customers/:id/loyalty
 * POST /api/customers/:id/loyalty/adjust
 * GET /api/customers/:id/profile
 */
async function handleCustomerLoyaltyRoutes(req, res, url) {
  const pathname = url.pathname || "";

  const mLoyalty = pathname.match(/^\/api\/customers\/(\d+)\/loyalty$/);
  const mAdjust = pathname.match(/^\/api\/customers\/(\d+)\/loyalty\/adjust$/);
  const mProfile = pathname.match(/^\/api\/customers\/(\d+)\/profile$/);

  if (!mLoyalty && !mAdjust && !mProfile) return false;

  applyCrmApiCorsHeaders(req, res);

  if (req.method === "GET" && mLoyalty) {
    const id = parsePositiveInt(mLoyalty[1]);
    if (id == null) {
      writeJson(res, 400, { error: "invalid_id" });
      return true;
    }
    const auth = authAdminOrFrontend(req);
    if (!auth.ok) {
      writeJson(res, auth.status, auth.body);
      return true;
    }
    try {
      const { rows: ex } = await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [id]);
      if (!ex.length) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }
      const summary = await loyaltyService.getLoyaltySummary(id);
      writeJson(res, 200, {
        data: {
          customer_id: id,
          points_balance: summary.points_balance,
          level: summary.level,
          points_to_next_level: summary.points_to_next_level,
          next_level: summary.next_level,
          movements: summary.movements,
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    } catch (e) {
      if (e && e.code === "LOYALTY_SCHEMA_MISSING") {
        writeJson(res, 503, { error: "loyalty_schema_missing", detail: "Ejecutar sql/20260408_loyalty.sql" });
        return true;
      }
      writeJson(res, 500, { error: "error", message: String(e.message) });
      return true;
    }
  }

  if (req.method === "POST" && mAdjust) {
    const id = parsePositiveInt(mAdjust[1]);
    if (id == null) {
      writeJson(res, 400, { error: "invalid_id" });
      return true;
    }
    const auth = authAdminOnly(req);
    if (!auth.ok) {
      writeJson(res, auth.status, auth.body);
      return true;
    }
    let body = {};
    try {
      body = await parseJsonBody(req);
    } catch (_e) {
      writeJson(res, 400, { error: "invalid_json" });
      return true;
    }
    const parsed = safeParse(adjustSchema, body);
    if (!parsed.ok) {
      writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
      return true;
    }
    try {
      const summary = await loyaltyService.adjustPoints(id, parsed.data.points, parsed.data.reason);
      writeJson(res, 200, {
        data: {
          customer_id: id,
          points_balance: summary.points_balance,
          level: summary.level,
          points_to_next_level: summary.points_to_next_level,
          next_level: summary.next_level,
          movements: summary.movements,
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    } catch (e) {
      if (e && e.code === "INSUFFICIENT_POINTS") {
        writeJson(res, 422, { error: "INSUFFICIENT_POINTS", message: String(e.message) });
        return true;
      }
      if (e && e.code === "LOYALTY_SCHEMA_MISSING") {
        writeJson(res, 503, { error: "loyalty_schema_missing", detail: "Ejecutar sql/20260408_loyalty.sql" });
        return true;
      }
      writeJson(res, 500, { error: "error", message: String(e.message) });
      return true;
    }
  }

  if (req.method === "GET" && mProfile) {
    const id = parsePositiveInt(mProfile[1]);
    if (id == null) {
      writeJson(res, 400, { error: "invalid_id" });
      return true;
    }
    const auth = authAdminOrFrontend(req);
    if (!auth.ok) {
      writeJson(res, auth.status, auth.body);
      return true;
    }
    try {
      const withV = await CustomerModel.getWithVehicles(id);
      if (!withV) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }
      const identities = await IdentityModel.listByCustomerId(id);
      let loyalty;
      try {
        loyalty = await loyaltyService.getLoyaltySummary(id);
      } catch (le) {
        if (le && le.code === "LOYALTY_SCHEMA_MISSING") {
          loyalty = null;
        } else {
          throw le;
        }
      }
      const base = rowToCustomerApi(withV);
      const vehicles = (withV.vehicles || []).map((v) => ({
        label: v.label,
        plate: v.plate,
      }));
      writeJson(res, 200, {
        data: {
          id: base.id,
          full_name: base.full_name,
          crm_status: base.crm_status,
          status: base.status,
          document_id: base.document_id,
          email: base.email,
          phone: base.phone,
          identities: identities.map((i) => ({
            source: i.source,
            external_id: i.external_id,
            is_primary: i.is_primary,
          })),
          vehicles,
          loyalty: loyalty
            ? {
                points_balance: loyalty.points_balance,
                level: loyalty.level,
                points_to_next_level: loyalty.points_to_next_level,
                next_level: loyalty.next_level,
              }
            : null,
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return true;
    } catch (e) {
      const mapped = mapSchemaError(e);
      if (mapped.code === "CRM_SCHEMA_MISSING") {
        writeJson(res, 503, { error: "crm_schema_missing", detail: String(e.message) });
        return true;
      }
      writeJson(res, 500, { error: "error", message: String(e.message) });
      return true;
    }
  }

  return false;
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

/** POST /api/crm/loyalty/earn — solo admin; llamado desde jobs/sync, no desde front. */
async function handleCrmLoyaltyEarnRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (req.method !== "POST" || pathname !== "/api/crm/loyalty/earn") {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  const auth = authAdminOnly(req);
  if (!auth.ok) {
    writeJson(res, auth.status, auth.body);
    return true;
  }

  let body = {};
  try {
    body = await parseJsonBody(req);
  } catch (_e) {
    writeJson(res, 400, { error: "invalid_json" });
    return true;
  }
  const parsed = safeParse(earnSchema, body);
  if (!parsed.ok) {
    writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
    return true;
  }
  const d = parsed.data;
  try {
    const out = await loyaltyService.earnFromMlOrder({
      customerId: d.customer_id,
      orderId: d.order_id,
      amountUsd: d.amount_usd,
      source: d.source,
    });
    writeJson(res, 200, {
      data: out,
      meta: { timestamp: new Date().toISOString() },
    });
    return true;
  } catch (e) {
    if (e && e.code === "LOYALTY_SCHEMA_MISSING") {
      writeJson(res, 503, { error: "loyalty_schema_missing", detail: "Ejecutar sql/20260408_loyalty.sql" });
      return true;
    }
    if (e && e.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: String(e.message) });
      return true;
    }
    writeJson(res, 500, { error: "error", message: String(e.message) });
    return true;
  }
}

module.exports = {
  handleCustomerLoyaltyRoutes,
  handleCrmLoyaltyEarnRequest,
};
