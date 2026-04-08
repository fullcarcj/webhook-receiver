"use strict";

const pino = require("pino");
const { z } = require("zod");
const { timingSafeCompare } = require("../services/currencyService");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { safeParse } = require("../middleware/validateCrm");
const { pool } = require("../../db");
const {
  CustomerModel,
  IdentityModel,
  insertCustomerVehicle,
  deleteCustomerVehicle,
  rowToCustomerApi,
  mapSchemaError,
} = require("../services/crmIdentityService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "customers",
});

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
    writeJson(res, 503, { error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  const provided = req.headers["x-admin-secret"];
  if (!timingSafeCompare(provided, secret)) {
    writeJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

function parsePositiveInt(s) {
  const t = String(s).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

const postCustomerSchema = z.object({
  full_name: z.string().min(2),
  document_id: z.string().optional(),
  email: z.string().email().optional(),
  status: z.enum(["draft", "active", "blocked"]).default("draft"),
});

const putCustomerSchema = postCustomerSchema.partial();

const patchStatusSchema = z.object({
  status: z.enum(["draft", "active", "blocked"]),
});

const postVehicleSchema = z.object({
  generation_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
  plate: z.string().optional(),
  color: z.string().optional(),
  notes: z.string().optional(),
});

function custErrorStatus(err) {
  if (err && err.name === "ZodError") return 422;
  const c = err && err.code;
  if (c === "BAD_REQUEST") return 400;
  if (c === "CRM_SCHEMA_MISSING") return 503;
  if (err && err.code === "23505") return 409;
  return 500;
}

function handleCustError(res, err, isDev) {
  const status = custErrorStatus(err);
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
  if (status === 500) logger.error({ err }, "customers_api_error");
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

function patchToUpdateBody(d) {
  const patch = {};
  if (d.full_name != null) patch.full_name = d.full_name;
  if (d.email !== undefined) patch.email = d.email;
  if (d.document_id !== undefined) patch.document_id = d.document_id;
  if (d.status != null) patch.status = d.status;
  return patch;
}

/**
 * API pública de clientes CRM bajo /api/customers (X-Admin-Secret).
 */
async function handleCustomersApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/customers")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  const isDev = process.env.NODE_ENV !== "production";

  if (!ensureAdmin(req, res)) return true;

  try {
    if (req.method === "GET" && pathname === "/api/customers/search") {
      const q = url.searchParams.get("q");
      const threshold = url.searchParams.get("threshold");
      const limit = url.searchParams.get("limit");
      const data = await CustomerModel.searchFuzzy({
        q,
        threshold: threshold != null ? Number(threshold) : 0.35,
        limit: limit != null ? Number(limit) : 10,
      });
      writeJson(res, 200, { data });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/customers") {
      const search = url.searchParams.get("search") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const { rows, total, limit: lim, offset: off } = await CustomerModel.list({
        search,
        status,
        limit: limit != null ? Number(limit) : 20,
        offset: offset != null ? Number(offset) : 0,
      });
      writeJson(res, 200, {
        data: rows.map((r) => rowToCustomerApi(r)),
        meta: { total, limit: lim, offset: off },
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/customers") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(postCustomerSchema, body);
      if (!parsed.ok) {
        handleCustError(res, parsed.error, isDev);
        return true;
      }
      const d = parsed.data;
      const row = await CustomerModel.create({
        fullName: d.full_name,
        documentId: d.document_id,
        email: d.email,
        status: d.status,
      });
      writeJson(res, 201, rowToCustomerApi(row));
      return true;
    }

    if (req.method === "PATCH" && /^\/api\/customers\/\d+\/status$/.test(pathname)) {
      const m = pathname.match(/^\/api\/customers\/(\d+)\/status$/);
      const id = m ? parsePositiveInt(m[1]) : null;
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const body = await parseJsonBody(req);
      const parsed = safeParse(patchStatusSchema, body);
      if (!parsed.ok) {
        handleCustError(res, parsed.error, isDev);
        return true;
      }
      const row = await CustomerModel.update(id, { status: parsed.data.status });
      if (!row) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }
      writeJson(res, 200, rowToCustomerApi(row));
      return true;
    }

    if (req.method === "GET" && /^\/api\/customers\/\d+\/identities$/.test(pathname)) {
      const m = pathname.match(/^\/api\/customers\/(\d+)\/identities$/);
      const id = m ? parsePositiveInt(m[1]) : null;
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const { rows: ex } = await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [id]);
      if (!ex.length) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }
      const data = await IdentityModel.listByCustomerId(id);
      writeJson(res, 200, { data });
      return true;
    }

    if (req.method === "POST" && /^\/api\/customers\/\d+\/vehicles$/.test(pathname)) {
      const m = pathname.match(/^\/api\/customers\/(\d+)\/vehicles$/);
      const id = m ? parsePositiveInt(m[1]) : null;
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const body = await parseJsonBody(req);
      const parsed = safeParse(postVehicleSchema, body);
      if (!parsed.ok) {
        handleCustError(res, parsed.error, isDev);
        return true;
      }
      const genId =
        typeof parsed.data.generation_id === "number"
          ? parsed.data.generation_id
          : Number(parsed.data.generation_id);
      try {
        const row = await insertCustomerVehicle(id, {
          ...parsed.data,
          generation_id: genId,
        });
        writeJson(res, 201, row);
      } catch (e) {
        if (e && e.code === "23505") {
          writeJson(res, 409, { error: "conflict" });
          return true;
        }
        throw e;
      }
      return true;
    }

    if (req.method === "DELETE" && /^\/api\/customers\/\d+\/vehicles\/\d+$/.test(pathname)) {
      const m = pathname.match(/^\/api\/customers\/(\d+)\/vehicles\/(\d+)$/);
      const cid = m ? parsePositiveInt(m[1]) : null;
      const vid = m ? parsePositiveInt(m[2]) : null;
      if (cid == null || vid == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const ok = await deleteCustomerVehicle(cid, vid);
      if (!ok) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      res.writeHead(204);
      res.end();
      return true;
    }

    if (req.method === "GET" && /^\/api\/customers\/\d+$/.test(pathname)) {
      const id = parsePositiveInt(pathname.replace("/api/customers/", ""));
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const row = await CustomerModel.getWithVehicles(id);
      if (!row) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }
      writeJson(res, 200, rowToCustomerApi(row));
      return true;
    }

    if (req.method === "PUT" && /^\/api\/customers\/\d+$/.test(pathname)) {
      const id = parsePositiveInt(pathname.replace("/api/customers/", ""));
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const body = await parseJsonBody(req);
      const parsed = safeParse(putCustomerSchema, body);
      if (!parsed.ok) {
        handleCustError(res, parsed.error, isDev);
        return true;
      }
      const d = parsed.data;
      const keys = Object.keys(d);
      if (keys.length === 0) {
        writeJson(res, 400, { error: "body_vacío" });
        return true;
      }
      const patch = patchToUpdateBody(d);
      const row = await CustomerModel.update(id, patch);
      if (!row) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }
      writeJson(res, 200, rowToCustomerApi(row));
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    if (e && e.code === "23505") {
      handleCustError(res, e, isDev);
      return true;
    }
    const mapped = mapSchemaError(e);
    handleCustError(res, mapped, isDev);
    return true;
  }
}

module.exports = { handleCustomersApiRequest };
