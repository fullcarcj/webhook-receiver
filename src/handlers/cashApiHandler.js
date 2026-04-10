"use strict";

const { z } = require("zod");
const pino = require("pino");
const { ensureAdmin } = require("../middleware/adminAuth");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { safeParse } = require("../middleware/validateCrm");
const cashApprovalService = require("../services/cashApprovalService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "cash_api" });

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

const submitSchema = z.object({
  currency: z.string().min(1).max(40),
  amount: z.number().positive(),
  submitted_by: z.string().min(1).max(100),
  exchange_rate: z.number().positive().optional(),
  proof_url: z.string().url().optional(),
  description: z.string().max(500).optional(),
});

const approveSchema = z.object({
  approved_by: z.string().min(1).max(100),
  notes: z.string().max(500).optional(),
});

const rejectSchema = z.object({
  rejected_by: z.string().min(1).max(100),
  reason: z.string().min(5).max(500),
});

const resubmitSchema = z.object({
  submitted_by: z.string().min(1).max(100),
  new_amount: z.number().positive().optional(),
  new_proof_url: z.string().url().optional(),
  notes: z.string().max(500).optional(),
});

const financeSettingSchema = z.object({
  value: z.string().min(1).max(500),
  updated_by: z.string().min(1).max(100).optional(),
});

function mapErr(e, res) {
  const code = e && e.code;
  const status = e && e.status;
  if (code && typeof status === "number") {
    writeJson(res, status, { error: code, message: e.message || String(code) });
    return true;
  }
  return false;
}

async function handleCashApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/cash") && !pathname.startsWith("/api/finance-settings")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const norm = pathname.replace(/\/+$/, "") || "/";

  try {
    if (req.method === "GET" && norm === "/api/finance-settings") {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await cashApprovalService.getFinanceSettings();
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const finPatch = norm.match(/^\/api\/finance-settings\/([^/]+)$/);
    if (req.method === "PATCH" && finPatch) {
      if (!ensureAdmin(req, res, url)) return true;
      const key = decodeURIComponent(finPatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(financeSettingSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const row = await cashApprovalService.updateFinanceSetting({
        key,
        value: parsed.data.value,
        updatedBy: parsed.data.updated_by,
      });
      writeJson(res, 200, { data: row, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "GET" && norm === "/api/cash/pending") {
      if (!ensureAdmin(req, res, url)) return true;
      const currency = url.searchParams.get("currency") || undefined;
      const submittedBy = url.searchParams.get("submitted_by") || undefined;
      const disc = url.searchParams.get("discrepancy");
      const onlyDiscrepancies = disc === "true" || disc === "1";
      const data = await cashApprovalService.getPendingPayments({
        currency,
        submittedBy,
        onlyDiscrepancies,
      });
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    if (req.method === "GET" && norm === "/api/cash/my-pending") {
      if (!ensureAdmin(req, res, url)) return true;
      const submittedBy = url.searchParams.get("submitted_by");
      if (!submittedBy || !String(submittedBy).trim()) {
        writeJson(res, 400, { error: "submitted_by query requerido" });
        return true;
      }
      const data = await cashApprovalService.getMyPending(String(submittedBy).trim());
      writeJson(res, 200, { data, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const logMatch = norm.match(/^\/api\/cash\/log\/(\d+)$/);
    if (req.method === "GET" && logMatch) {
      if (!ensureAdmin(req, res, url)) return true;
      const orderId = Number(logMatch[1]);
      const rows = await cashApprovalService.getCashLogByOrderId(orderId);
      writeJson(res, 200, { data: rows, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const submitMatch = norm.match(/^\/api\/cash\/submit\/(\d+)$/);
    if (req.method === "POST" && submitMatch) {
      if (!ensureAdmin(req, res, url)) return true;
      const orderId = Number(submitMatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(submitSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      const out = await cashApprovalService.submitPayment({
        orderId,
        currency: d.currency,
        amount: d.amount,
        submittedBy: d.submitted_by,
        exchangeRate: d.exchange_rate,
        proofUrl: d.proof_url,
        description: d.description,
      });
      writeJson(res, 201, { data: out, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const resubmitMatch = norm.match(/^\/api\/cash\/resubmit\/(\d+)$/);
    if (req.method === "POST" && resubmitMatch) {
      if (!ensureAdmin(req, res, url)) return true;
      const txId = Number(resubmitMatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(resubmitSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      const out = await cashApprovalService.resubmitPayment({
        txId,
        submittedBy: d.submitted_by,
        newAmount: d.new_amount,
        newProofUrl: d.new_proof_url,
        notes: d.notes,
      });
      writeJson(res, 200, { data: out, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const approveMatch = norm.match(/^\/api\/cash\/approve\/(\d+)$/);
    if (req.method === "POST" && approveMatch) {
      if (!ensureAdmin(req, res, url)) return true;
      const txId = Number(approveMatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(approveSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      const out = await cashApprovalService.approvePayment({
        txId,
        approvedBy: d.approved_by,
        notes: d.notes,
      });
      writeJson(res, 200, { data: out, meta: { timestamp: new Date().toISOString() } });
      return true;
    }

    const rejectMatch = norm.match(/^\/api\/cash\/reject\/(\d+)$/);
    if (req.method === "POST" && rejectMatch) {
      if (!ensureAdmin(req, res, url)) return true;
      const txId = Number(rejectMatch[1]);
      let body = {};
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      const parsed = safeParse(rejectSchema, body);
      if (!parsed.ok) {
        writeJson(res, 422, { error: "validation_error", details: parsed.error.issues });
        return true;
      }
      const d = parsed.data;
      const out = await cashApprovalService.rejectPayment({
        txId,
        rejectedBy: d.rejected_by,
        reason: d.reason,
      });
      writeJson(res, 200, { data: out, meta: { timestamp: new Date().toISOString() } });
      return true;
    }
  } catch (e) {
    if (mapErr(e, res)) return true;
    log.error({ err: e }, "cash_api_error");
    writeJson(res, 500, { error: "error", message: String(e && e.message) });
    return true;
  }

  writeJson(res, 404, { error: "not_found" });
  return true;
}

module.exports = { handleCashApiRequest };
