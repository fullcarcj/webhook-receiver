"use strict";

const { ensureAdmin } = require("../middleware/adminAuth");
const {
  createPosSale,
  createPosPurchase,
  getPosSaleById,
  getPosPurchaseById,
  listPosPurchases,
} = require("../services/posSalesService");

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

/**
 * Ventas POS (`sales` / `sale_lines`) con snapshot de tasa desde `daily_exchange_rates`.
 * Prefijo `/api/pos` para no colisionar con `/api/sales` (sales_orders).
 * @returns {Promise<boolean>}
 */
async function handlePosSalesApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/pos")) return false;

  const rest = pathname.replace(/\/+$/, "");

  try {
    const mGet = rest.match(/^\/api\/pos\/sales\/(\d+)$/);
    if (req.method === "GET" && mGet) {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await getPosSaleById(mGet[1]);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "POST" && (rest === "/api/pos/sales" || rest === "/api/pos/sales/")) {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const data = await createPosSale({
        companyId: body.company_id,
        customerId: body.customer_id,
        mlOrderId: body.ml_order_id,
        saleDate: body.sale_date,
        notes: body.notes,
        status: body.status,
        igtfUsd: body.igtf_usd,
        lines: body.lines,
        payments: body.payments,
        rateSnapshot: body.rate_snapshot,
      });
      writeJson(res, 201, {
        ok: true,
        data: {
          sale: data.sale,
          lines: data.lines,
          rate_snapshot: data.rate_snapshot,
          total_igtf_usd: data.totalIgtfUsd,
          total_net_usd: data.totalNetUsd,
          igtf_absorbed: data.igtfAbsorbed,
          total_iva_retention_usd: data.totalIvaRetentionUsd,
          total_islr_retention_usd: data.totalIslrRetentionUsd,
          fiscal_document: data.fiscalDocument || null,
        },
      });
      return true;
    }

    const mPurGet = rest.match(/^\/api\/pos\/purchases\/(\d+)$/);
    if (req.method === "GET" && mPurGet) {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await getPosPurchaseById(mPurGet[1]);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "GET" && (rest === "/api/pos/purchases" || rest === "/api/pos/purchases/")) {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await listPosPurchases({
        companyId: url.searchParams.get("company_id") ? Number(url.searchParams.get("company_id")) : 1,
        from:      url.searchParams.get("from")    || null,
        to:        url.searchParams.get("to")      || null,
        status:    url.searchParams.get("status")  || null,
        limit:     url.searchParams.get("limit")   ? Number(url.searchParams.get("limit"))  : 50,
        offset:    url.searchParams.get("offset")  ? Number(url.searchParams.get("offset")) : 0,
      });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && (rest === "/api/pos/purchases" || rest === "/api/pos/purchases/")) {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      if (!Array.isArray(body.lines) || body.lines.length === 0) {
        writeJson(res, 400, { success: false, error: "Se requiere lines: array no vacío" });
        return true;
      }
      for (let i = 0; i < body.lines.length; i++) {
        const row = body.lines[i] || {};
        const sku = row.product_sku;
        const q = row.quantity;
        const c = row.unit_cost_usd;
        if (sku == null || String(sku).trim() === "") {
          writeJson(res, 400, {
            success: false,
            error: `Línea ${i + 1}: falta product_sku`,
          });
          return true;
        }
        if (q == null || !Number.isFinite(Number(q)) || Number(q) <= 0) {
          writeJson(res, 400, {
            success: false,
            error: `Línea ${i + 1}: quantity debe ser un número > 0`,
          });
          return true;
        }
        if (c == null || !Number.isFinite(Number(c)) || Number(c) <= 0) {
          writeJson(res, 400, {
            success: false,
            error: `Línea ${i + 1}: unit_cost_usd debe ser un número > 0`,
          });
          return true;
        }
      }
      const result = await createPosPurchase({
        companyId:        body.company_id || 1,
        purchaseDate:     body.purchase_date || null,
        importShipmentId: body.import_shipment_id != null ? body.import_shipment_id : null,
        lines:            body.lines,
        notes:            body.notes || null,
        userId:           body.user_id != null ? body.user_id : null,
        rateSnapshot:     body.rate_snapshot || null,
      });
      writeJson(res, 201, {
        success: true,
        purchase_id: result.purchaseId,
        purchase_date: result.purchaseDate,
        rate_applied: result.rateApplied,
        rate_type: result.rateType,
        rate_date: result.rateDate,
        subtotal_usd: result.subtotalUsd,
        total_usd: result.totalUsd,
        total_bs: result.totalBs,
        lines_inserted: result.linesInserted,
        import_shipment_id: result.importShipmentId,
      });
      return true;
    }
  } catch (e) {
    const code = e && e.code;
    const msg = (e && e.message) || String(e);
    if (e instanceof SyntaxError) {
      writeJson(res, 400, { ok: false, error: "invalid_json" });
      return true;
    }
    if (e && e.message === "body_too_large") {
      writeJson(res, 413, { ok: false, error: "body_too_large" });
      return true;
    }
    if (
      code === "42P01" ||
      /relation.*sales/.test(msg) ||
      /relation.*purchases/.test(msg) ||
      /relation.*purchase_lines/.test(msg) ||
      /relation.*sale_payments/.test(msg) ||
      /relation.*payment_methods/.test(msg) ||
      /relation.*product_lots/.test(msg) ||
      /relation.*lot_bin_stock/.test(msg) ||
      /relation.*lot_movements/.test(msg) ||
      /relation.*bin_stock/.test(msg) ||
      /relation.*warehouse_bins/.test(msg) ||
      /column.*total_igtf_usd/.test(msg) ||
      /column.*total_net_usd/.test(msg) ||
      /tax_retention_globals/.test(msg) ||
      /calculate_payment_tax_retentions/.test(msg) ||
      /iva_retention_usd/.test(msg) ||
      /islr_retention_usd/.test(msg)
    ) {
      writeJson(res, 503, {
        ok: false,
        error:
          "Tablas POS / IGTF no migradas. Ejecutá npm run db:exchange-rates y npm run db:igtf (sql/igtf.sql).",
        code: "SCHEMA_MISSING",
      });
      return true;
    }
    if (
      code === "NO_ACTIVE_RATE" ||
      code === "NO_RATE_DATE" ||
      code === "EMPTY_LINES" ||
      code === "INVALID_STATUS" ||
      code === "INVALID_IGTF" ||
      code === "INVALID_LINE_SKU" ||
      code === "INVALID_LINE_QTY" ||
      code === "INVALID_LINE_PRICE" ||
      code === "INVALID_LINE_COST" ||
      code === "INVALID_LANDED" ||
      code === "INVALID_SUBTOTAL" ||
      code === "INVALID_TOTAL" ||
      code === "INVALID_RATE" ||
      code === "INVALID_RATE_TYPE" ||
      code === "INVALID_RATE_DATE" ||
      code === "INVALID_ID" ||
      code === "INVALID_LOT" ||
      code === "INVALID_BIN" ||
      code === "INVALID_QTY" ||
      code === "LOT_SKU_MISMATCH" ||
      code === "LOT_BAD_STATUS" ||
      code === "LOT_ID_REQUIRED" ||
      code === "BIN_REQUIRED" ||
      code === "BIN_NOT_FOUND" ||
      code === "NEGATIVE_STOCK" ||
      code === "INVALID_ADJUSTMENT" ||
      code === "IGTF_EXCEEDS_TOTAL" ||
      code === "NO_IGTF_RATE"
    ) {
      writeJson(res, 400, { ok: false, error: msg, code });
      return true;
    }
    if (code === "SKU_NOT_FOUND" || code === "CUSTOMER_NOT_FOUND" || code === "SHIPMENT_NOT_FOUND") {
      writeJson(res, 404, { ok: false, error: msg, code, sku: e.sku });
      return true;
    }
    if (code === "LOT_NOT_FOUND") {
      writeJson(res, 404, { ok: false, error: msg, code });
      return true;
    }
    if (code === "NOT_FOUND") {
      writeJson(res, 404, { ok: false, error: msg, code });
      return true;
    }
    if (code === "23503" || code === "23514" || code === "22P02") {
      writeJson(res, 400, { ok: false, error: msg, code });
      return true;
    }
    console.error("[pos-sales]", e);
    writeJson(res, 500, { ok: false, error: msg });
    return true;
  }

  return false;
}

module.exports = { handlePosSalesApiRequest };
