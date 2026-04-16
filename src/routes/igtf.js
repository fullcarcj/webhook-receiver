"use strict";

const { requireAdminOrPermission } = require("../utils/authMiddleware");
const {
  calculateMultiPaymentIgtf,
  closePeriod,
  getPeriodSummary,
  getDeclarations,
  getPaymentMethods,
} = require("../services/igtfService");

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
 * IGTF: métodos de pago, cálculo preview, declaraciones (admin).
 * @returns {Promise<boolean>}
 */
async function handleIgtfApiRequest(req, res, url) {
  const path = url.pathname || "";

  if (path === "/igtf-panel") {
    if (req.method !== "GET") return false;
    if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
    const k = url.searchParams.get("k") || url.searchParams.get("secret") || "";
    const kEnc = encodeURIComponent(k);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>IGTF</title>
<style>body{font-family:system-ui;max-width:48rem;margin:1.5rem auto;padding:0 1rem}code{background:#eee;padding:.1rem .35rem}</style></head><body>
<h1>IGTF — pruebas</h1>
<p>Usa la misma clave que <code>ADMIN_SECRET</code> en <code>?k=</code> (esta página ya la validó).</p>
<ul>
<li><code>GET /api/igtf/payment-methods</code> — sin auth</li>
<li><code>POST /api/igtf/calculate</code> — JSON <code>{"payments":[{"payment_method_code":"ZELLE","amount_usd":80},…]}</code> — sin auth</li>
<li><code>GET /api/igtf/declarations?k=${kEnc}</code> — admin</li>
<li><code>GET /api/igtf/declarations/2026/4?k=${kEnc}</code> — admin</li>
<li><code>POST /api/igtf/declarations/2026/4/close</code> — cabecera <code>X-Admin-Secret</code></li>
<li><code>POST /api/tax/calculate-retentions</code> — solo IVA (75% del IVA devengado) + ISLR por método (sin auth)</li>
<li><code>POST /api/tax/payments-preview</code> — IGTF + retenciones combinadas (sin auth)</li>
<li><code>GET /api/tax/retention-globals?k=…</code> — parámetros globales (admin)</li>
</ul>
<p>Migración IGTF: <code>npm run db:igtf</code> · Retenciones: <code>npm run db:tax-retentions</code></p>
</body></html>`);
    return true;
  }

  if (!path.startsWith("/api/igtf")) return false;

  const rest = path.replace(/\/+$/, "");

  try {
    if (req.method === "GET" && rest === "/api/igtf/payment-methods") {
      const rows = await getPaymentMethods();
      writeJson(res, 200, rows);
      return true;
    }

    if (req.method === "POST" && rest === "/api/igtf/calculate") {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body.payments) || body.payments.length === 0) {
        writeJson(res, 400, { error: "Se requiere payments: array no vacío" });
        return true;
      }
      const calc = await calculateMultiPaymentIgtf(body.payments, body.as_of_date || body.asOfDate || null);
      writeJson(res, 200, {
        payments: calc.payments,
        total_taxable_usd: calc.total_taxable_usd,
        total_igtf_usd: calc.total_igtf_usd,
        total_usd: calc.total_usd,
        total_net_usd: calc.total_net_usd,
        igtf_absorbed: calc.igtf_absorbed,
      });
      return true;
    }

    if (req.method === "GET" && rest === "/api/igtf/declarations") {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const st = url.searchParams.get("status");
      const rows = await getDeclarations({ companyId: 1, status: st || null });
      writeJson(res, 200, { ok: true, data: rows });
      return true;
    }

    const mPeriodGet = rest.match(/^\/api\/igtf\/declarations\/(\d{4})\/(\d{1,2})$/);
    if (req.method === "GET" && mPeriodGet) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const year = Number(mPeriodGet[1]);
      const month = Number(mPeriodGet[2]);
      const row = await getPeriodSummary({ year, month, companyId: 1 });
      if (!row) {
        writeJson(res, 404, { ok: false, error: "Declaración no encontrada" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    const mClose = rest.match(/^\/api\/igtf\/declarations\/(\d{4})\/(\d{1,2})\/close$/);
    if (req.method === "POST" && mClose) {
      if (!await requireAdminOrPermission(req, res, 'fiscal')) return true;
      const year = Number(mClose[1]);
      const month = Number(mClose[2]);
      const data = await closePeriod({ year, month, companyId: 1 });
      writeJson(res, 200, { ok: true, data });
      return true;
    }
  } catch (e) {
    const code = e && e.code;
    const msg = (e && e.message) || String(e);
    if (e instanceof SyntaxError) {
      writeJson(res, 400, { error: "invalid_json" });
      return true;
    }
    if (e && e.message === "body_too_large") {
      writeJson(res, 413, { error: "body_too_large" });
      return true;
    }
    if (
      code === "42P01" ||
      /relation.*payment_methods/.test(msg) ||
      /relation.*sale_payments/.test(msg) ||
      /relation.*igtf_declarations/.test(msg) ||
      /calculate_igtf/.test(msg) ||
      /get_igtf_rate/.test(msg)
    ) {
      writeJson(res, 503, {
        ok: false,
        error: "Esquema IGTF no migrado. Ejecutá npm run db:igtf (o sql/igtf.sql).",
        code: "SCHEMA_MISSING",
      });
      return true;
    }
    if (code === "NO_IGTF_RATE" || code === "INVALID_AMOUNT" || code === "INVALID_METHOD" || code === "INVALID_PAYMENT") {
      writeJson(res, 400, { error: msg, code });
      return true;
    }
    console.error("[igtf]", e);
    writeJson(res, 500, { error: msg });
    return true;
  }

  return false;
}

module.exports = { handleIgtfApiRequest };
