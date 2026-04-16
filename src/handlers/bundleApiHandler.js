"use strict";

const { z } = require("zod");
const pino = require("pino");
const { pool } = require("../../db");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { safeParse } = require("../middleware/validateCrm");
const bundleService = require("../services/bundleService");
const priceReviewService = require("../services/priceReviewService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "bundle_api" });

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

const createBundleSchema = z.object({
  kit_product_id: z.number().int().positive(),
  components: z
    .array(
      z.object({
        component_product_id: z.number().int().positive(),
        quantity: z.number().positive(),
        notes: z.string().max(500).optional(),
      })
    )
    .min(1),
});

const addAlternativeSchema = z.object({
  alternative_product_id: z.number().int().positive(),
  brand_name: z.string().min(1).max(100),
  is_preferred: z.boolean().optional().default(false),
});

const resolveReviewSchema = z.object({
  status: z.enum(["reviewed", "dismissed", "applied"]),
  reviewed_by: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
});

async function handleBundleApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/bundles") && !pathname.startsWith("/api/price-review")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    if (pathname.startsWith("/api/price-review")) {
      if (!await requireAdminOrPermission(req, res, 'ventas')) return true;
      if (!(await bundleService.tableExists(pool))) {
        writeJson(res, 503, { error: "price_review_schema_missing", message: "Ejecutá npm run db:kits-bundles" });
        return true;
      }

      const resolveMatch = pathname.match(/^\/api\/price-review\/(\d+)\/resolve$/);
      if (req.method === "GET" && (pathname === "/api/price-review" || pathname === "/api/price-review/")) {
        const type = url.searchParams.get("type") || null;
        const rows = await priceReviewService.getPendingReviews(type || null);
        writeJson(res, 200, { data: rows, meta: { timestamp: new Date().toISOString() } });
        return true;
      }

      if (req.method === "POST" && resolveMatch) {
        const id = Number(resolveMatch[1]);
        const body = await parseJsonBody(req);
        const parsed = safeParse(resolveReviewSchema, body);
        if (!parsed.ok) {
          writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
          return true;
        }
        const row = await priceReviewService.resolveReview({
          reviewId: id,
          status: parsed.data.status,
          reviewedBy: parsed.data.reviewed_by,
          notes: parsed.data.notes,
        });
        writeJson(res, 200, { data: row });
        return true;
      }

      writeJson(res, 404, { error: "not_found" });
      return true;
    }

    /* ─── /api/bundles ─── */
    if (!await requireAdminOrPermission(req, res, 'ventas')) return true;

    if (!(await bundleService.tableExists(pool))) {
      writeJson(res, 503, { error: "bundles_schema_missing", message: "Ejecutá npm run db:kits-bundles" });
      return true;
    }

    const availMatch = pathname.match(/^\/api\/bundles\/(\d+)\/availability$/);
    const detailMatch = pathname.match(/^\/api\/bundles\/(\d+)$/);

    if (req.method === "GET" && (pathname === "/api/bundles" || pathname === "/api/bundles/")) {
      const { rows } = await pool.query(
        `SELECT p.id, p.sku, p.descripcion, p.precio_usd, p.is_kit, p.kit_components_count
         FROM productos p
         WHERE EXISTS (
           SELECT 1 FROM product_bundles pb WHERE pb.parent_product_id = p.id AND pb.is_active = TRUE
         )
         OR p.is_kit = TRUE
         ORDER BY p.sku ASC
         LIMIT 500`
      );
      writeJson(res, 200, { data: rows, meta: { count: rows.length } });
      return true;
    }

    if (req.method === "GET" && availMatch) {
      const pid = Number(availMatch[1]);
      const data = await bundleService.getAvailabilityPayload(pid);
      if (!data) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      writeJson(res, 200, { data });
      return true;
    }

    if (req.method === "GET" && detailMatch && !pathname.endsWith("/availability")) {
      const pid = Number(detailMatch[1]);
      const { rows: pr } = await pool.query(`SELECT id, sku, descripcion, precio_usd, is_kit FROM productos WHERE id = $1`, [
        pid,
      ]);
      if (!pr.length) {
        writeJson(res, 404, { error: "not_found" });
        return true;
      }
      const components = await bundleService.getKitComponents(pid);
      writeJson(res, 200, { data: { product: pr[0], components } });
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/bundles" || pathname === "/api/bundles/")) {
      const body = await parseJsonBody(req);
      const parsed = safeParse(createBundleSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const { kit_product_id, components } = parsed.data;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: k } = await client.query(`SELECT id FROM productos WHERE id = $1`, [kit_product_id]);
        if (!k.length) {
          await client.query("ROLLBACK");
          writeJson(res, 404, { error: "kit_product_not_found" });
          return true;
        }
        for (const c of components) {
          const { rows: cp } = await client.query(`SELECT id FROM productos WHERE id = $1`, [c.component_product_id]);
          if (!cp.length) {
            await client.query("ROLLBACK");
            writeJson(res, 404, { error: "component_not_found", component_product_id: c.component_product_id });
            return true;
          }
          await client.query(
            `INSERT INTO product_bundles (parent_product_id, component_product_id, quantity, notes, is_active)
             VALUES ($1, $2, $3, $4, TRUE)
             ON CONFLICT (parent_product_id, component_product_id) DO UPDATE
             SET quantity = EXCLUDED.quantity, notes = EXCLUDED.notes, is_active = TRUE`,
            [kit_product_id, c.component_product_id, c.quantity, c.notes ?? null]
          );
        }
        await client.query(
          `UPDATE productos SET is_kit = TRUE,
            kit_components_count = (SELECT COUNT(*)::INT FROM product_bundles WHERE parent_product_id = $1 AND is_active = TRUE),
            updated_at = NOW()
           WHERE id = $1`,
          [kit_product_id]
        );
        await client.query("COMMIT");
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_r) {
          /* */
        }
        log.error(e, "bundle create failed");
        writeJson(res, 500, { error: "bundle_create_failed", message: e.message });
        return true;
      } finally {
        client.release();
      }
      const componentsOut = await bundleService.getKitComponents(kit_product_id);
      writeJson(res, 201, { data: { kit_product_id, components: componentsOut } });
      return true;
    }

    const altMatch = pathname.match(
      /^\/api\/bundles\/(\d+)\/components\/(\d+)\/alternatives$/
    );
    if (req.method === "POST" && altMatch) {
      const bundleId = Number(altMatch[2]);
      const body = await parseJsonBody(req);
      const parsed = safeParse(addAlternativeSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const { rows: b } = await pool.query(`SELECT id FROM product_bundles WHERE id = $1`, [bundleId]);
      if (!b.length) {
        writeJson(res, 404, { error: "bundle_row_not_found" });
        return true;
      }
      await pool.query(
        `INSERT INTO bundle_component_alternatives (bundle_id, alternative_product_id, brand_name, is_preferred)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bundle_id, alternative_product_id) DO UPDATE
         SET brand_name = EXCLUDED.brand_name, is_preferred = EXCLUDED.is_preferred`,
        [bundleId, parsed.data.alternative_product_id, parsed.data.brand_name, parsed.data.is_preferred]
      );
      writeJson(res, 201, { ok: true });
      return true;
    }

    const delAlt = pathname.match(/^\/api\/bundles\/alternatives\/(\d+)$/);
    if (req.method === "DELETE" && delAlt) {
      await pool.query(`DELETE FROM bundle_component_alternatives WHERE id = $1`, [Number(delAlt[1])]);
      writeJson(res, 200, { ok: true });
      return true;
    }

    const delComp = pathname.match(/^\/api\/bundles\/(\d+)\/components\/(\d+)$/);
    if (req.method === "DELETE" && delComp) {
      const parentId = Number(delComp[1]);
      const bundleRowId = Number(delComp[2]);
      await pool.query(`DELETE FROM product_bundles WHERE id = $1 AND parent_product_id = $2`, [bundleRowId, parentId]);
      await pool.query(
        `UPDATE productos SET kit_components_count = (
           SELECT COUNT(*)::INT FROM product_bundles WHERE parent_product_id = $1 AND is_active = TRUE
         ), updated_at = NOW() WHERE id = $1`,
        [parentId]
      );
      writeJson(res, 200, { ok: true });
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    log.error(e, "bundleApi");
    writeJson(res, 500, { error: "internal_error", message: e.message });
    return true;
  }
}

module.exports = { handleBundleApiRequest };
