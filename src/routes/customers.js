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

const postIdentitySchema = z.object({
  source: z.enum(["whatsapp", "mercadolibre", "mostrador"]),
  external_id: z.string().min(1).max(255),
  is_primary: z.boolean().default(false),
});

const mergeIdentitiesSchema = z
  .object({
    source_customer_id: z.number().int().positive(),
    target_customer_id: z.number().int().positive(),
  })
  .refine((data) => data.source_customer_id !== data.target_customer_id, {
    message: "source y target no pueden ser el mismo cliente",
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
  if (/^\/api\/customers\/\d+\/history$/.test(pathname)) {
    // DECISIÓN: dejar que lo maneje src/handlers/customerHistory.js
    return false;
  }
  if (!pathname.startsWith("/api/customers") && !pathname.startsWith("/api/identities")) {
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

    if (req.method === "POST" && /^\/api\/customers\/\d+\/identities$/.test(pathname)) {
      const m = pathname.match(/^\/api\/customers\/(\d+)\/identities$/);
      const id = m ? parsePositiveInt(m[1]) : null;
      if (id == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }
      const body = await parseJsonBody(req);
      const parsed = safeParse(postIdentitySchema, body);
      if (!parsed.ok) {
        handleCustError(res, parsed.error, isDev);
        return true;
      }
      const { rows: ex } = await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [id]);
      if (!ex.length) {
        writeJson(res, 404, { error: "Customer not found" });
        return true;
      }

      const d = parsed.data;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (d.is_primary) {
          await client.query(
            `UPDATE crm_customer_identities SET is_primary = FALSE WHERE customer_id = $1`,
            [id]
          );
        }
        const { rows } = await client.query(
          `INSERT INTO crm_customer_identities
            (customer_id, source, external_id, is_primary)
           VALUES ($1, $2::crm_identity_source, $3, $4)
           ON CONFLICT (source, external_id)
           DO UPDATE SET customer_id = EXCLUDED.customer_id, is_primary = EXCLUDED.is_primary
           RETURNING *`,
          [id, d.source, d.external_id.trim(), !!d.is_primary]
        );
        await client.query("COMMIT");
        writeJson(res, 201, rows[0]);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
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

    if (req.method === "DELETE" && /^\/api\/identities\/\d+$/.test(pathname)) {
      const m = pathname.match(/^\/api\/identities\/(\d+)$/);
      const identityId = m ? parsePositiveInt(m[1]) : null;
      if (identityId == null) {
        writeJson(res, 400, { error: "invalid_id" });
        return true;
      }

      const { rows: idRows } = await pool.query(
        `SELECT id, customer_id FROM crm_customer_identities WHERE id = $1`,
        [identityId]
      );
      if (!idRows.length) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }

      const customerId = Number(idRows[0].customer_id);
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM crm_customer_identities WHERE customer_id = $1`,
        [customerId]
      );
      if (Number(countRows[0]?.n || 0) <= 1) {
        writeJson(res, 409, { error: "LAST_IDENTITY", code: "LAST_IDENTITY" });
        return true;
      }

      await pool.query(`DELETE FROM crm_customer_identities WHERE id = $1`, [identityId]);
      writeJson(res, 200, { deleted: true, id: identityId });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/identities/merge") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(mergeIdentitiesSchema, body);
      if (!parsed.ok) {
        handleCustError(res, parsed.error, isDev);
        return true;
      }
      const { source_customer_id: sourceId, target_customer_id: targetId } = parsed.data;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: both } = await client.query(
          `SELECT id FROM customers WHERE id = ANY($1::bigint[]) ORDER BY id`,
          [[sourceId, targetId]]
        );
        if (both.length !== 2) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { error: "customer_not_found" });
          return true;
        }

        await client.query(
          `UPDATE crm_customer_identities
           SET customer_id = $1,
               is_primary = FALSE
           WHERE customer_id = $2`,
          [targetId, sourceId]
        );

        await client.query(
          `INSERT INTO crm_customer_vehicles (customer_id, generation_id, plate, color, notes, added_at)
           SELECT $1, v.generation_id, v.plate, v.color, v.notes, COALESCE(v.added_at, NOW())
           FROM crm_customer_vehicles v
           WHERE v.customer_id = $2
             AND NOT EXISTS (
               SELECT 1
               FROM crm_customer_vehicles x
               WHERE x.customer_id = $1
                 AND x.generation_id = v.generation_id
                 AND COALESCE(x.plate, '') = COALESCE(v.plate, '')
             )`,
          [targetId, sourceId]
        );
        await client.query(`DELETE FROM crm_customer_vehicles WHERE customer_id = $1`, [sourceId]);

        await client.query(`UPDATE crm_messages SET customer_id = $1 WHERE customer_id = $2`, [targetId, sourceId]);
        await client.query(`UPDATE crm_chats SET customer_id = $1 WHERE customer_id = $2`, [targetId, sourceId]);

        try {
          await client.query(`UPDATE sales_orders SET customer_id = $1 WHERE customer_id = $2`, [targetId, sourceId]);
        } catch (e) {
          if (e && (e.code === "23503" || e.code === "23505")) {
            const err = new Error("No se pudieron reasignar ventas del cliente origen");
            err.code = "SALES_REASSIGN_CONFLICT";
            throw err;
          }
          throw e;
        }

        const { rows: loyTable } = await client.query(
          `SELECT to_regclass('public.loyalty_accounts') AS t`
        );
        if (loyTable[0] && loyTable[0].t) {
          const { rows: srcL } = await client.query(
            `SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`,
            [sourceId]
          );
          if (srcL.length) {
            const srcPoints = Number(srcL[0].points_balance || 0);
            const { rowCount: updTarget } = await client.query(
              `UPDATE loyalty_accounts
               SET points_balance = COALESCE(points_balance, 0) + $2
               WHERE customer_id = $1`,
              [targetId, srcPoints]
            );
            if (updTarget === 0) {
              await client.query(
                `UPDATE loyalty_accounts SET customer_id = $1 WHERE customer_id = $2`,
                [targetId, sourceId]
              );
            } else {
              await client.query(`DELETE FROM loyalty_accounts WHERE customer_id = $1`, [sourceId]);
            }
          }
        }

        await client.query(`DELETE FROM customers WHERE id = $1`, [sourceId]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        if (e && e.code === "SALES_REASSIGN_CONFLICT") {
          writeJson(res, 409, { error: e.code, message: e.message });
          return true;
        }
        throw e;
      } finally {
        client.release();
      }

      const merged = await CustomerModel.getWithVehicles(targetId);
      writeJson(res, 200, merged ? rowToCustomerApi(merged) : { id: targetId });
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
