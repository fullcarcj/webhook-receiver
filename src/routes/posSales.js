"use strict";

const { ensureAdmin } = require("../middleware/adminAuth");
const { createPosSale, getPosSaleById } = require("../services/posSalesService");

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
        rateSnapshot: body.rate_snapshot,
      });
      writeJson(res, 201, { ok: true, data });
      return true;
    }
  } catch (e) {
    const code = e && e.code;
    const msg = (e && e.message) || String(e);
    if (code === "42P01" || /relation.*sales/.test(msg)) {
      writeJson(res, 503, {
        ok: false,
        error: "Tablas POS no migradas. Ejecutá npm run db:exchange-rates (o sql/exchange-rates.sql).",
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
      code === "INVALID_LANDED" ||
      code === "INVALID_SUBTOTAL" ||
      code === "INVALID_TOTAL" ||
      code === "INVALID_RATE" ||
      code === "INVALID_RATE_TYPE" ||
      code === "INVALID_RATE_DATE" ||
      code === "INVALID_ID"
    ) {
      writeJson(res, 400, { ok: false, error: msg, code });
      return true;
    }
    if (code === "SKU_NOT_FOUND" || code === "CUSTOMER_NOT_FOUND") {
      writeJson(res, 404, { ok: false, error: msg, code, sku: e.sku });
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
