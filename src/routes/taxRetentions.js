"use strict";

const { calculateMultiPaymentIgtf } = require("../services/igtfService");
const {
  calculateMultiPaymentRetentions,
  enrichPaymentsWithTaxRetentions,
  getGlobals,
} = require("../services/taxRetentionService");
const { ensureAdmin } = require("../middleware/adminAuth");

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
 * Retenciones IVA/ISLR + preview combinado con IGTF.
 * @returns {Promise<boolean>}
 */
async function handleTaxRetentionsApiRequest(req, res, url) {
  const path = url.pathname || "";
  if (!path.startsWith("/api/tax")) return false;

  const rest = path.replace(/\/+$/, "");

  try {
    if (req.method === "POST" && rest === "/api/tax/calculate-retentions") {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body.payments) || body.payments.length === 0) {
        writeJson(res, 400, { error: "Se requiere payments: array no vacío" });
        return true;
      }
      const out = await calculateMultiPaymentRetentions(body.payments, body.as_of_date || body.asOfDate || null);
      writeJson(res, 200, {
        payments: out.payments,
        total_iva_retention_usd: out.total_iva_retention_usd,
        total_islr_retention_usd: out.total_islr_retention_usd,
      });
      return true;
    }

    if (req.method === "POST" && rest === "/api/tax/payments-preview") {
      const body = await parseJsonBody(req);
      if (!Array.isArray(body.payments) || body.payments.length === 0) {
        writeJson(res, 400, { error: "Se requiere payments: array no vacío" });
        return true;
      }
      const date = body.as_of_date || body.asOfDate || null;
      const igtf = await calculateMultiPaymentIgtf(body.payments, date);
      const tax = await enrichPaymentsWithTaxRetentions(igtf.payments, date);
      writeJson(res, 200, {
        payments: tax.payments,
        igtf: {
          total_taxable_usd: igtf.total_taxable_usd,
          total_igtf_usd: igtf.total_igtf_usd,
          total_usd: igtf.total_usd,
          total_net_usd: igtf.total_net_usd,
          igtf_absorbed: igtf.igtf_absorbed,
        },
        retentions: {
          total_iva_retention_usd: tax.total_iva_retention_usd,
          total_islr_retention_usd: tax.total_islr_retention_usd,
        },
      });
      return true;
    }

    if (req.method === "GET" && rest === "/api/tax/retention-globals") {
      if (!ensureAdmin(req, res, url)) return true;
      const d = url.searchParams.get("as_of") || url.searchParams.get("date");
      const row = await getGlobals(d);
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const code = e && e.code;
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
      /tax_retention_globals/.test(msg) ||
      /calculate_payment_tax_retentions/.test(msg) ||
      /iva_retention/.test(msg) ||
      /islr_retention/.test(msg)
    ) {
      writeJson(res, 503, {
        ok: false,
        error: "Esquema de retenciones no migrado. Ejecutá npm run db:tax-retentions (sql/tax-retentions.sql).",
        code: "SCHEMA_MISSING",
      });
      return true;
    }
    console.error("[tax-retentions]", e);
    writeJson(res, 500, { error: msg });
    return true;
  }

  return false;
}

module.exports = { handleTaxRetentionsApiRequest };
