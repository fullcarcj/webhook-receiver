"use strict";

const { ensureAdmin } = require("../middleware/adminAuth");
const {
  createShipment,
  setExpenses,
  addLine,
  removeLine,
  previewLandedCost,
  closeShipment,
  reopenShipment,
  getShipmentDetail,
  listShipments,
} = require("../services/landedCostService");

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

function mapServiceError(res, e) {
  if (e && typeof e.status === "number" && e.code) {
    writeJson(res, e.status, { ok: false, error: e.code, message: e.message || String(e) });
    return true;
  }
  return false;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {URL} url
 */
async function handleShipmentsApiRequest(req, res, url) {
  const path = url.pathname;

  if (path === "/embarques-landed") {
    if (req.method !== "GET") return false;
    if (!ensureAdmin(req, res, url)) return true;
    const k = url.searchParams.get("k") || url.searchParams.get("secret") || "";
    const kEnc = encodeURIComponent(k);
    const base = ""; /* mismo origen */
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Landed cost — embarques</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:1.5rem auto;padding:0 1rem;line-height:1.45}
code{background:#f4f4f4;padding:.1rem .35rem;border-radius:4px} pre{overflow:auto;background:#111;color:#eee;padding:1rem;border-radius:8px;font-size:.85rem}</style></head><body>
<h1>Embarques / landed cost</h1>
<p>Esta página solo documenta los endpoints. Cambia <code>TU_SECRETO</code> por el mismo valor que <code>ADMIN_SECRET</code> (o usa la clave que ya pusiste en la URL).</p>
<ul>
<li><strong>Listar</strong> — <code>GET ${base}/api/shipments?k=${kEnc}</code> · opcional <code>&amp;status=OPEN|CLOSED|CANCELLED</code></li>
<li><strong>Crear</strong> — <code>POST ${base}/api/shipments</code> + JSON + cabecera <code>X-Admin-Secret</code> (o <code>?k=</code> en GET no aplica a POST; usa cabecera o una herramienta que envíe el secreto).</li>
<li><strong>Detalle</strong> — <code>GET ${base}/api/shipments/ID?k=${kEnc}</code></li>
<li><strong>Preview cálculo</strong> — <code>GET ${base}/api/shipments/ID/preview?k=${kEnc}</code></li>
<li><strong>Gastos totales</strong> — <code>PATCH ${base}/api/shipments/ID/expenses</code> body <code>{"total_expenses_usd":1250}</code></li>
<li><strong>Agregar línea</strong> — <code>POST ${base}/api/shipments/ID/lines</code> body <code>{"product_sku":"…","quantity":500,"unit_fob_usd":2.5,"unit_volume_cbm":0.0008}</code></li>
<li><strong>Quitar línea</strong> — <code>DELETE ${base}/api/shipments/ID/lines/SKU</code> (SKU URL-encoded si tiene caracteres especiales)</li>
<li><strong>Cerrar</strong> — <code>POST ${base}/api/shipments/ID/close</code> body <code>{"user_id":1}</code> (requiere tasas en <code>daily_exchange_rates</code>)</li>
<li><strong>Reabrir</strong> — <code>POST ${base}/api/shipments/ID/reopen</code> body <code>{"user_id":1}</code> (solo si estaba CLOSED; no revierte <code>products.landed_cost_usd</code>)</li>
</ul>
<p>Migración SQL: <code>npm run db:landed-cost</code> o <code>psql $DATABASE_URL -f sql/landed-cost.sql</code></p>
<pre>curl -s "${base}/api/shipments?k=TU_SECRETO"
curl -s -X POST "${base}/api/shipments" -H "X-Admin-Secret: TU_SECRETO" -H "Content-Type: application/json" -d "{\\"shipment_ref\\":\\"IMP-2026-001\\",\\"total_expenses_usd\\":1250}"</pre>
<p><a href="/health">/health</a></p>
</body></html>`);
    return true;
  }

  if (!path.startsWith("/api/shipments")) return false;

  try {
    if (req.method === "GET" && path === "/api/shipments") {
      if (!ensureAdmin(req, res, url)) return true;
      const st = url.searchParams.get("status");
      const rows = await listShipments({ companyId: 1, status: st || null });
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }

    if (req.method === "POST" && path === "/api/shipments") {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const row = await createShipment({
        companyId: 1,
        shipmentRef: body.shipment_ref,
        supplierName: body.supplier_name,
        originCountry: body.origin_country,
        incoterm: body.incoterm,
        totalExpensesUsd: body.total_expenses_usd,
        notes: body.notes,
      });
      writeJson(res, 201, { ok: true, data: row });
      return true;
    }

    const mPreview = path.match(/^\/api\/shipments\/(\d+)\/preview$/);
    if (req.method === "GET" && mPreview) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mPreview[1]);
      const data = await previewLandedCost(id);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    const mClose = path.match(/^\/api\/shipments\/(\d+)\/close$/);
    if (req.method === "POST" && mClose) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mClose[1]);
      const body = await parseJsonBody(req);
      const data = await closeShipment({ shipmentId: id, userId: body.user_id });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    const mReopen = path.match(/^\/api\/shipments\/(\d+)\/reopen$/);
    if (req.method === "POST" && mReopen) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mReopen[1]);
      await parseJsonBody(req);
      const data = await reopenShipment({ shipmentId: id });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    const mExp = path.match(/^\/api\/shipments\/(\d+)\/expenses$/);
    if (req.method === "PATCH" && mExp) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mExp[1]);
      const body = await parseJsonBody(req);
      const row = await setExpenses({ shipmentId: id, totalExpensesUsd: body.total_expenses_usd });
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    const mLines = path.match(/^\/api\/shipments\/(\d+)\/lines$/);
    if (req.method === "POST" && mLines) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mLines[1]);
      const body = await parseJsonBody(req);
      const row = await addLine({
        shipmentId: id,
        productSku: body.product_sku,
        quantity: body.quantity,
        unitFobUsd: body.unit_fob_usd,
        unitVolumeCbm: body.unit_volume_cbm,
      });
      writeJson(res, 201, { ok: true, data: row });
      return true;
    }

    const mDelLine = path.match(/^\/api\/shipments\/(\d+)\/lines\/(.+)$/);
    if (req.method === "DELETE" && mDelLine) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mDelLine[1]);
      let sku = mDelLine[2];
      try {
        sku = decodeURIComponent(sku);
      } catch (_) {}
      const out = await removeLine({ shipmentId: id, productSku: sku });
      writeJson(res, 200, { ok: true, data: out });
      return true;
    }

    const mDetail = path.match(/^\/api\/shipments\/(\d+)$/);
    if (req.method === "GET" && mDetail) {
      if (!ensureAdmin(req, res, url)) return true;
      const id = Number(mDetail[1]);
      const data = await getShipmentDetail(id);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    return false;
  } catch (e) {
    if (mapServiceError(res, e)) return true;
    if (e instanceof SyntaxError) {
      writeJson(res, 400, { ok: false, error: "invalid_json" });
      return true;
    }
    if (e && e.message === "body_too_large") {
      writeJson(res, 413, { ok: false, error: "body_too_large" });
      return true;
    }
    const msg = e && e.message ? String(e.message) : String(e);
    writeJson(res, 500, { ok: false, error: "internal_error", message: msg });
    return true;
  }
}

module.exports = { handleShipmentsApiRequest };
