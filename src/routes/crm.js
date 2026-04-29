"use strict";

const pino = require("pino");
const { listWhatsappLogs, mapSchemaError } = require("../services/crmIdentityService");
const { routeWebhook } = require("../whatsapp/hookRouter");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");
const crmService = require("../services/crmService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "crm",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Campos extra (no BD): primera palabra de `full_name` y el resto — útil para FileMaker / Insert from URL. */
function customerRowWithNombreApellido(row) {
  const full = row && row.full_name != null ? String(row.full_name).trim() : "";
  const parts = full.split(/\s+/).filter(Boolean);
  return {
    ...row,
    nombre: parts.length ? parts[0] : "",
    apellido: parts.length > 1 ? parts.slice(1).join(" ") : "",
  };
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

function crmErrorStatus(err) {
  if (err && err.name === "ZodError") return 422;
  const c = err && err.code;
  if (c === "BAD_REQUEST") return 400;
  if (c === "CRM_SCHEMA_MISSING") return 503;
  if (err && err.code === "23505") return 409;
  return 500;
}

function handleCrmError(res, err, isDev) {
  const status = crmErrorStatus(err);
  if (err && err.name === "ZodError") {
    writeJson(res, 422, {
      error: "validation_error",
      details: err.issues,
    });
    return;
  }
  if (err && err.code === "23505") {
    writeJson(res, 409, { error: "conflict", detail: err.message });
    return;
  }
  if (err && err.code === "CRM_SCHEMA_MISSING") {
    writeJson(res, 503, {
      error: "crm_schema_missing",
      detail: "Ejecutar migración sql/crm-solomotor3k.sql",
    });
    return;
  }
  if (status === 500) logger.error({ err }, "crm_error");
  writeJson(res, status, {
    error: err && err.code ? String(err.code) : "error",
    message:
      status === 500 && !isDev
        ? "Internal server error"
        : err && err.message
          ? String(err.message)
          : "error",
  });
}

async function handleCrmApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  const isDev = process.env.NODE_ENV !== "production";

  if (pathname === "/webhook/whatsapp" && req.method === "GET") {
    try {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      const expected = process.env.WA_VERIFY_TOKEN;
      if (mode === "subscribe" && expected && token === expected && challenge) {
        writeText(res, 200, challenge);
        return true;
      }
      writeJson(res, 403, { error: "forbidden" });
      return true;
    } catch (e) {
      handleCrmError(res, e, isDev);
      return true;
    }
  }

  if (pathname === "/webhook/whatsapp" && req.method === "POST") {
    try {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        body = {};
      }
      writeJson(res, 200, { status: "ok" });
      setImmediate(() => {
        routeWebhook(body).catch((err) => {
          logger.error({ err }, "whatsapp_hub_route");
        });
      });
      return true;
    } catch (e) {
      try {
        writeJson(res, 200, { status: "ok" });
      } catch (_e2) {
        /* ignore */
      }
      logger.error({ err: e }, "whatsapp_webhook_error");
      return true;
    }
  }

  if (!pathname.startsWith("/api/crm")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (!await requireAdminOrPermission(req, res, 'crm')) return true;

  try {
    if (req.method === "GET" && pathname === "/api/crm/logs") {
      const customerId = url.searchParams.get("customer_id") || undefined;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const data = await listWhatsappLogs({
        customerId,
        limit: limit != null ? Number(limit) : 50,
        offset: offset != null ? Number(offset) : 0,
      });
      writeJson(res, 200, data);
      return true;
    }

    // ── Migración masiva ml_buyers → customers ──────────────────────────────
    if (req.method === "POST" && pathname === "/api/crm/migrate") {
      const result = await crmService.runMigration(1);
      writeJson(res, 200, { ok: true, ...result });
      return true;
    }

    // ── Buyer ML → customer CRM ─────────────────────────────────────────────
    // GET  /api/crm/buyers/:mlBuyerId/customer
    // POST /api/crm/buyers/:mlBuyerId/customer  → find-or-create (sin cuerpo o ignorado)
    // POST …/customer?update=1  → mismo cuerpo que PUT/PATCH (Insert from URL suele fallar con PUT → error 10)
    // PUT|PATCH …/customer  → actualizar cliente vinculado al buyer
    const buyerCustomerMatch = pathname.match(/^\/api\/crm\/buyers\/(\d+)\/customer$/);
    if (buyerCustomerMatch) {
      const mlBuyerId = Number(buyerCustomerMatch[1]);
      if (req.method === "GET") {
        const row = await crmService.getCustomerByMlBuyerId(mlBuyerId);
        if (!row) {
          writeJson(res, 404, { ok: false, error: "not_found", detail: "no_customer_for_ml_buyer" });
          return true;
        }
        writeJson(res, 200, { ok: true, data: customerRowWithNombreApellido(row) });
        return true;
      }
      if (req.method === "POST") {
        const wantsUpdate =
          url.searchParams.get("update") === "1" ||
          url.searchParams.get("update") === "true" ||
          url.searchParams.get("save") === "1";
        if (wantsUpdate) {
          const body = await parseJsonBody(req);
          try {
            const row = await crmService.updateCustomerByMlBuyerId(mlBuyerId, body);
            writeJson(res, 200, { ok: true, data: row, method: "POST", query: "update=1" });
          } catch (e) {
            if (e && e.code === "NOT_FOUND") {
              writeJson(res, 404, { ok: false, error: "not_found", detail: "no_customer_for_ml_buyer" });
              return true;
            }
            if (e && e.code === "BAD_REQUEST" && String(e.message) === "no_updatable_fields") {
              writeJson(res, 400, { ok: false, error: "no_updatable_fields", detail: "body_sin_campos_editables" });
              return true;
            }
            throw e;
          }
          return true;
        }
        const result = await crmService.findOrCreateFromBuyer(mlBuyerId);
        writeJson(res, result.created ? 201 : 200, { ok: true, ...result });
        return true;
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const body = await parseJsonBody(req);
        try {
          const row = await crmService.updateCustomerByMlBuyerId(mlBuyerId, body);
          writeJson(res, 200, { ok: true, data: row });
        } catch (e) {
          if (e && e.code === "NOT_FOUND") {
            writeJson(res, 404, { ok: false, error: "not_found", detail: "no_customer_for_ml_buyer" });
            return true;
          }
          if (e && e.code === "BAD_REQUEST" && String(e.message) === "no_updatable_fields") {
            writeJson(res, 400, { ok: false, error: "no_updatable_fields", detail: "body_sin_campos_editables" });
            return true;
          }
          throw e;
        }
        return true;
      }
    }

    // ── /api/crm/customers ──────────────────────────────────────────────────

    // GET /api/crm/customers
    if (req.method === "GET" && pathname === "/api/crm/customers") {
      const data = await crmService.searchCustomers({
        q:            url.searchParams.get("q")             || undefined,
        customerType: url.searchParams.get("customer_type") || undefined,
        isActive:     url.searchParams.has("is_active")
                        ? url.searchParams.get("is_active")
                        : undefined,
        limit:        url.searchParams.get("limit"),
        offset:       url.searchParams.get("offset"),
      });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    // POST /api/crm/customers
    if (req.method === "POST" && pathname === "/api/crm/customers") {
      const body = await parseJsonBody(req);
      if (!body.full_name && !body.fullName) {
        writeJson(res, 400, { ok: false, error: "full_name es obligatorio" });
        return true;
      }
      const row = await crmService.createCustomer(body);
      writeJson(res, 201, { ok: true, data: row });
      return true;
    }

    // Rutas con /:id
    const custIdMatch = pathname.match(/^\/api\/crm\/customers\/(\d+)(\/.*)?$/);
    if (custIdMatch) {
      const customerId = Number(custIdMatch[1]);
      const subpath    = custIdMatch[2] || "";

      // GET /api/crm/customers/:id
      if (req.method === "GET" && subpath === "") {
        const row = await crmService.getCustomer(customerId);
        if (!row) {
          writeJson(res, 404, { ok: false, error: "not_found" });
          return true;
        }
        writeJson(res, 200, { ok: true, data: row });
        return true;
      }

      // PATCH /api/crm/customers/:id
      if (req.method === "PATCH" && subpath === "") {
        const body = await parseJsonBody(req);
        const row = await crmService.updateCustomer({ customerId, ...body });
        writeJson(res, 200, { ok: true, data: row });
        return true;
      }

      // POST /api/crm/customers/:id/sync-wa-chats-by-phone
      if (req.method === "POST" && subpath === "/sync-wa-chats-by-phone") {
        let body = {};
        try {
          body = await parseJsonBody(req);
        } catch (_e) {
          body = {};
        }
        const sid =
          body.sales_order_id != null && body.sales_order_id !== ""
            ? Number(body.sales_order_id)
            : NaN;
        const salesOrderInternalId = Number.isFinite(sid) && sid > 0 ? sid : null;
        const data = await crmService.syncWaChatsByPhoneForCustomer(customerId, {
          salesOrderInternalId,
        });
        writeJson(res, 200, { ok: true, data });
        return true;
      }

      // GET /api/crm/customers/:id/ml-buyers
      if (req.method === "GET" && subpath === "/ml-buyers") {
        const rows = await crmService.getMlBuyersForCustomer(customerId);
        writeJson(res, 200, { ok: true, items: rows });
        return true;
      }

      // POST /api/crm/customers/:id/ml-buyers
      if (req.method === "POST" && subpath === "/ml-buyers") {
        const body = await parseJsonBody(req);
        if (!body.ml_buyer_id) {
          writeJson(res, 400, { ok: false, error: "ml_buyer_id es obligatorio" });
          return true;
        }
        const row = await crmService.linkMlBuyer({
          customerId,
          mlBuyerId:  body.ml_buyer_id,
          isPrimary:  body.is_primary === true || body.is_primary === "true",
          notes:      body.notes    || null,
          linkedBy:   body.linked_by || null,
        });
        writeJson(res, 200, { ok: true, data: row });
        return true;
      }

      // GET /api/crm/customers/:id/wallet
      if (req.method === "GET" && subpath === "/wallet") {
        const data = await crmService.getWalletBalance(customerId);
        writeJson(res, 200, { ok: true, ...data });
        return true;
      }

      // GET /api/crm/customers/:id/wallet/summary
      if (req.method === "GET" && subpath === "/wallet/summary") {
        const data = await crmService.getWalletSummary(customerId);
        writeJson(res, 200, { ok: true, ...data });
        return true;
      }

      // GET /api/crm/customers/:id/wallet/history
      if (req.method === "GET" && subpath === "/wallet/history") {
        const data = await crmService.getWalletHistory({
          customerId,
          limit:  url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
        });
        writeJson(res, 200, { ok: true, ...data });
        return true;
      }

      // POST /api/crm/customers/:id/wallet
      if (req.method === "POST" && subpath === "/wallet") {
        const body = await parseJsonBody(req);
        const amt = Number(body.amount_usd);
        if (!Number.isFinite(amt) || amt === 0) {
          writeJson(res, 400, { ok: false, error: "amount_usd debe ser distinto de cero" });
          return true;
        }
        if (!body.tx_type) {
          writeJson(res, 400, {
            ok: false,
            error: `tx_type requerido: ${crmService.VALID_CRM_TX_TYPES.join("|")}`,
          });
          return true;
        }
        const result = await crmService.addWalletTransaction({
          customerId,
          amountUsd:     amt,
          txType:        body.tx_type,
          referenceType: body.reference_type || null,
          referenceId:   body.reference_id   || null,
          notes:         body.notes          || null,
          createdBy:     body.created_by     || null,
        });
        writeJson(res, 201, { ok: true, ...result });
        return true;
      }
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    if (e && e.code === "23505") {
      handleCrmError(res, e, isDev);
      return true;
    }
    const mapped = mapSchemaError(e);
    handleCrmError(res, mapped, isDev);
    return true;
  }
}

module.exports = { handleCrmApiRequest, logger: logger };
