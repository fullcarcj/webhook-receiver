"use strict";

const {
  getSettings,
  updateSetting,
  openPeriod,
  closePeriod,
  recordRetention,
  getPeriod,
  listPeriods,
  markFiled,
  markPaid,
} = require("../services/fiscalService");
const { requireAdminOrPermission } = require("../utils/authMiddleware");

const COMPANY_ID = 1;

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

function schemaMissing(res, e) {
  const msg = (e && e.message) || String(e);
  if (
    e &&
    (e.code === "42P01" ||
      /settings_tax/.test(msg) ||
      /fiscal_periods/.test(msg) ||
      /get_tax_setting/.test(msg) ||
      /open_fiscal_period/.test(msg))
  ) {
    writeJson(res, 503, {
      ok: false,
      error:
        "Esquema fiscal no migrado. Ejecutá: npm run db:fiscal-periods (requiere exchange-rates + igtf).",
      code: "SCHEMA_MISSING",
    });
    return true;
  }
  return false;
}

/**
 * @returns {Promise<boolean>}
 */
async function handleFiscalApiRequest(req, res, url) {
  const path = (url.pathname || "").replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/fiscal-panel" || path === "/fiscal-panel/")) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><meta charset=\"utf-8\"><p>Define ADMIN_SECRET.</p>");
      return true;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><p>Acceso denegado. Usá <code>/fiscal-panel?k=TU_SECRETO</code>.</p>"
      );
      return true;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Fiscal — pruebas</title>
<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:1.5rem auto;padding:0 1rem}
code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px}</style></head>
<body>
<h1>Períodos fiscales y settings_tax</h1>
<p>La clave va en la URL (<code>?k=…</code>) o en cabecera <code>X-Admin-Secret</code> en curl.</p>
<ul>
<li><a href="/api/settings/tax?k=${encodeURIComponent(k)}">GET /api/settings/tax</a> — JSON de configuración vigente.</li>
<li><a href="/api/fiscal/periods?k=${encodeURIComponent(k)}">GET /api/fiscal/periods</a> — listado de períodos.</li>
</ul>
<p><strong>PATCH</strong> frecuencia IVA (consola F12; reutiliza <code>k</code> de la barra de direcciones):</p>
<pre>const k=new URLSearchParams(location.search).get('k');
fetch('/api/settings/tax/iva_frequency?k='+encodeURIComponent(k), {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 'BIMONTHLY' })
}).then(r=>r.json()).then(console.log)</pre>
<p><strong>POST</strong> abrir período IVA:</p>
<pre>const k=new URLSearchParams(location.search).get('k');
fetch('/api/fiscal/periods?k='+encodeURIComponent(k), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tax_type: 'IVA', year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 })
}).then(r=>r.json()).then(console.log)</pre>
</body></html>`);
    return true;
  }

  if (!path.startsWith("/api/fiscal") && !(path.startsWith("/api/settings/tax"))) {
    return false;
  }

  try {
    if (path === "/api/settings/tax" && req.method === "GET") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const data = await getSettings(COMPANY_ID);
      writeJson(res, 200, { ok: true, settings: data });
      return true;
    }

    const patchTax = req.method === "PATCH" && /^\/api\/settings\/tax\/[^/]+$/.test(path);
    if (patchTax) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const key = decodeURIComponent(path.replace(/^\/api\/settings\/tax\//, ""));
      const body = await parseJsonBody(req);
      if (body.value === undefined && body.value !== 0 && body.value !== false) {
        writeJson(res, 400, { ok: false, error: "Se requiere body.value" });
        return true;
      }
      const out = await updateSetting({
        key,
        value: body.value === false ? "0" : body.value === true ? "1" : String(body.value),
        companyId: COMPANY_ID,
        userId: body.user_id != null ? body.user_id : null,
        notes: body.notes,
      });
      writeJson(res, 200, { ok: true, ...out });
      return true;
    }

    if (path === "/api/fiscal/periods" && req.method === "GET") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const taxType = url.searchParams.get("tax_type") || url.searchParams.get("taxType");
      const status = url.searchParams.get("status");
      const rows = await listPeriods({ companyId: COMPANY_ID, taxType, status });
      writeJson(res, 200, { ok: true, periods: rows });
      return true;
    }

    const getOne = req.method === "GET" && /^\/api\/fiscal\/periods\/[^/]+\/\d{4}(?:\/\d{1,2})?$/.test(path);
    if (getOne) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const m = path.match(/^\/api\/fiscal\/periods\/([^/]+)\/(\d{4})(?:\/(\d{1,2}))?$/);
      const taxType = m[1];
      const year = Number(m[2]);
      const month = m[3] != null && m[3] !== "" ? Number(m[3]) : null;
      const row = await getPeriod({
        taxType,
        year,
        month: Number.isFinite(month) ? month : null,
        companyId: COMPANY_ID,
      });
      if (!row) {
        writeJson(res, 404, { ok: false, error: "Período no encontrado" });
        return true;
      }
      writeJson(res, 200, { ok: true, period: row });
      return true;
    }

    if (path === "/api/fiscal/periods" && req.method === "POST") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      const tax_type = body.tax_type || body.taxType;
      const year = body.year;
      const month = body.month != null ? body.month : null;
      if (!tax_type || year == null) {
        writeJson(res, 400, { ok: false, error: "tax_type y year son obligatorios" });
        return true;
      }
      const row = await openPeriod({
        taxType: String(tax_type),
        year: Number(year),
        month: month != null && month !== "" ? Number(month) : null,
        companyId: COMPANY_ID,
      });
      writeJson(res, 200, { ok: true, period: row });
      return true;
    }

    const closeM = req.method === "POST" && /^\/api\/fiscal\/periods\/\d+\/close$/.test(path);
    if (closeM) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const id = path.match(/\/periods\/(\d+)\/close$/)[1];
      const body = await parseJsonBody(req);
      const doc = await closePeriod({ periodId: id, userId: body.user_id != null ? body.user_id : null });
      writeJson(res, 200, { ok: true, result: doc });
      return true;
    }

    const fileM = req.method === "POST" && /^\/api\/fiscal\/periods\/\d+\/file$/.test(path);
    if (fileM) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const id = path.match(/\/periods\/(\d+)\/file$/)[1];
      const body = await parseJsonBody(req);
      if (!body.filed_ref) {
        writeJson(res, 400, { ok: false, error: "filed_ref requerido" });
        return true;
      }
      const row = await markFiled({
        periodId: id,
        filedRef: body.filed_ref,
        userId: body.user_id != null ? body.user_id : null,
      });
      writeJson(res, 200, { ok: true, period: row });
      return true;
    }

    const payM = req.method === "POST" && /^\/api\/fiscal\/periods\/\d+\/pay$/.test(path);
    if (payM) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const id = path.match(/\/periods\/(\d+)\/pay$/)[1];
      const body = await parseJsonBody(req);
      const row = await markPaid({
        periodId: id,
        paidAmountUsd: body.paid_amount_usd,
        userId: body.user_id != null ? body.user_id : null,
      });
      writeJson(res, 200, { ok: true, period: row });
      return true;
    }

    if (path === "/api/fiscal/retentions" && req.method === "POST") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const body = await parseJsonBody(req);
      const row = await recordRetention({
        companyId: COMPANY_ID,
        fiscalPeriodId: body.fiscal_period_id,
        retentionRole: body.retention_role,
        counterpartName: body.counterpart_name,
        counterpartRif: body.counterpart_rif,
        comprobante: body.comprobante,
        retentionDate: body.retention_date,
        taxType: body.tax_type,
        baseAmountUsd: body.base_amount_usd,
        rateApplied: body.rate_applied,
        purchaseId: body.purchase_id,
        saleId: body.sale_id,
      });
      writeJson(res, 200, { ok: true, retention: row });
      return true;
    }
  } catch (e) {
    if (schemaMissing(res, e)) return true;
    const status = e && e.status ? Number(e.status) : 500;
    const code = e && e.code;
    if (e instanceof SyntaxError) {
      writeJson(res, 400, { ok: false, error: "invalid_json" });
      return true;
    }
    if (e && e.message === "body_too_large") {
      writeJson(res, 413, { ok: false, error: "body_too_large" });
      return true;
    }
    if (status >= 400 && status < 500) {
      writeJson(res, status, { ok: false, error: e.message || String(e), code });
      return true;
    }
    console.error("[fiscal]", e);
    writeJson(res, 500, { ok: false, error: (e && e.message) || String(e) });
    return true;
  }

  return false;
}

module.exports = {
  handleFiscalApiRequest,
};
