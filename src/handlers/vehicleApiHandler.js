"use strict";

const pino = require("pino");
const { z } = require("zod");
const { timingSafeCompare } = require("../services/currencyService");
const { safeParse } = require("../middleware/validateCrm");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const vehicleService = require("../services/vehicleService");
const skuPrefixService = require("../services/skuPrefixService");
const { pool } = require("../../db");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "vehicleApi" });

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
  if (!timingSafeCompare(req.headers["x-admin-secret"], secret)) {
    writeJson(res, 403, { error: "forbidden" });
    return false;
  }
  return true;
}

function metaTs() {
  return { timestamp: new Date().toISOString() };
}

const postBrandSchema = z.object({
  name: z.string().min(2).max(100),
  sku_prefix: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : String(v).toUpperCase().trim()), z.string().length(3).regex(/^[A-Z]{3}$/).optional()),
});
const postModelSchema = z.object({
  brand_id: z.number().int().positive(),
  name: z.string().min(2).max(100),
});
const postGenerationSchema = z.object({
  model_id: z.number().int().positive(),
  year_start: z.number().int().min(1950).max(2100),
  year_end: z.number().int().min(1950).max(2100).nullable().optional(),
  engine_info: z.string().max(100).optional(),
  body_type: z.string().max(50).optional(),
  is_verified: z.boolean().default(false),
});
const postCompatSchema = z.object({
  generation_id: z.number().int().positive(),
  sku: z.string().min(1).max(100),
  part_name: z.string().min(2).max(255),
  notes: z.string().max(500).optional(),
});

async function handleVehicleApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (
    pathname !== "/api/crm/brands" &&
    pathname !== "/api/crm/models" &&
    pathname !== "/api/crm/generations" &&
    pathname !== "/api/crm/compatibility"
  ) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);
  if (!ensureAdmin(req, res)) return true;

  const isDev = process.env.NODE_ENV !== "production";

  try {
    if (req.method === "GET" && pathname === "/api/crm/brands") {
      const data = await vehicleService.listBrandsWithCounts();
      writeJson(res, 200, { data, meta: metaTs() });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/crm/brands") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(postBrandSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let resolved;
        try {
          resolved = await skuPrefixService.resolveSkuPrefixForSave({
            table: "crm_vehicle_brands",
            name: parsed.data.name.trim(),
            manualPrefix: parsed.data.sku_prefix,
            client,
          });
        } catch (pe) {
          await client.query("ROLLBACK");
          if (pe && pe.code === "SKU_PREFIX_CONFLICT") {
            writeJson(res, 409, {
              error: "SKU_PREFIX_CONFLICT",
              message: pe.message,
              suggested_prefix: pe.suggested_prefix,
            });
            return true;
          }
          if (pe && pe.code === "INVALID_SKU_PREFIX_FORMAT") {
            writeJson(res, 422, { error: "invalid_sku_prefix", message: pe.message });
            return true;
          }
          throw pe;
        }
        const { rows } = await client.query(
          `INSERT INTO crm_vehicle_brands (name, sku_prefix) VALUES ($1, $2) RETURNING id, name, sku_prefix`,
          [parsed.data.name.trim(), resolved.sku_prefix]
        );
        await client.query("COMMIT");
        writeJson(res, 201, {
          data: {
            ...rows[0],
            prefix_meta: {
              source: resolved.source,
              suggested_mnemonic: resolved.suggested_mnemonic,
            },
          },
          meta: metaTs(),
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e && e.code === "23505") {
          writeJson(res, 409, { error: "BRAND_EXISTS" });
          return true;
        }
        if (e && e.code === "42703") {
          writeJson(res, 503, { error: "schema_missing", detail: "Columna sku_prefix: npm run db:sku-prefixes" });
          return true;
        }
        throw e;
      } finally {
        client.release();
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/api/crm/models") {
      const bid = url.searchParams.get("brand_id");
      if (bid == null || String(bid).trim() === "") {
        writeJson(res, 400, { error: "brand_id requerido" });
        return true;
      }
      const brandId = Number(bid);
      if (!Number.isFinite(brandId) || brandId <= 0) {
        writeJson(res, 400, { error: "brand_id inválido" });
        return true;
      }
      const data = await vehicleService.listModelsByBrand(brandId);
      writeJson(res, 200, { data, meta: metaTs() });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/crm/models") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(postModelSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      try {
        const { rows } = await pool.query(
          `INSERT INTO crm_vehicle_models (brand_id, name) VALUES ($1, $2) RETURNING *`,
          [parsed.data.brand_id, parsed.data.name.trim()]
        );
        writeJson(res, 201, { data: rows[0], meta: metaTs() });
      } catch (e) {
        if (e && e.code === "23505") {
          writeJson(res, 409, { error: "conflict" });
          return true;
        }
        throw e;
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/api/crm/generations") {
      const mid = url.searchParams.get("model_id");
      if (mid == null || String(mid).trim() === "") {
        writeJson(res, 400, { error: "model_id requerido" });
        return true;
      }
      const modelId = Number(mid);
      if (!Number.isFinite(modelId) || modelId <= 0) {
        writeJson(res, 400, { error: "model_id inválido" });
        return true;
      }
      const data = await vehicleService.listGenerationsByModel(modelId);
      writeJson(res, 200, { data, meta: metaTs() });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/crm/generations") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(postGenerationSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      if (d.year_end != null && d.year_end < d.year_start) {
        writeJson(res, 400, { error: "year_end_before_year_start" });
        return true;
      }
      const { rows } = await pool.query(
        `INSERT INTO crm_vehicle_generations (
           model_id, year_start, year_end, engine_info, body_type, is_verified
         ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          d.model_id,
          d.year_start,
          d.year_end ?? null,
          d.engine_info ?? null,
          d.body_type ?? null,
          d.is_verified,
        ]
      );
      const row = rows[0];
      writeJson(res, 201, {
        data: { ...row, year_range: vehicleService.yearRange(row) },
        meta: metaTs(),
      });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/crm/compatibility") {
      const brandId = url.searchParams.get("brand_id");
      const modelId = url.searchParams.get("model_id");
      const year = url.searchParams.get("year");
      const engine = url.searchParams.get("engine");
      if (year == null || String(year).trim() === "") {
        writeJson(res, 400, { error: "year requerido" });
        return true;
      }
      const y = Number(year);
      if (!Number.isFinite(y)) {
        writeJson(res, 400, { error: "year inválido" });
        return true;
      }
      const bid = brandId != null && String(brandId).trim() !== "" ? Number(brandId) : null;
      const mid = modelId != null && String(modelId).trim() !== "" ? Number(modelId) : null;
      if (bid != null && !Number.isFinite(bid)) {
        writeJson(res, 400, { error: "brand_id inválido" });
        return true;
      }
      if (mid != null && !Number.isFinite(mid)) {
        writeJson(res, 400, { error: "model_id inválido" });
        return true;
      }
      try {
        const { generations, total_parts } = await vehicleService.searchCompatibility({
          brandId: bid,
          modelId: mid,
          year: y,
          engine: engine || null,
        });
        writeJson(res, 200, {
          data: { generations, total_parts },
          meta: metaTs(),
        });
      } catch (e) {
        if (e && e.code === "42P01") {
          writeJson(res, 503, { error: "schema_missing", detail: "Ejecutar sql/20260408_vehicles_catalog.sql" });
          return true;
        }
        throw e;
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/api/crm/compatibility") {
      const body = await parseJsonBody(req);
      const parsed = safeParse(postCompatSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      try {
        const row = await vehicleService.insertCompatibility({
          generationId: d.generation_id,
          sku: d.sku.trim(),
          partName: d.part_name.trim(),
          notes: d.notes,
        });
        writeJson(res, 201, { data: row, meta: metaTs() });
      } catch (e) {
        if (e && e.code === "23505") {
          writeJson(res, 409, { error: "COMPATIBILITY_EXISTS" });
          return true;
        }
        if (e && e.code === "42P01") {
          writeJson(res, 503, { error: "schema_missing", detail: "Ejecutar sql/20260408_vehicles_catalog.sql" });
          return true;
        }
        throw e;
      }
      return true;
    }

    return false;
  } catch (e) {
    logger.error({ err: e }, "vehicle_api");
    writeJson(res, 500, {
      error: "error",
      message: isDev ? String(e.message) : "Internal server error",
    });
    return true;
  }
}

module.exports = { handleVehicleApiRequest };
