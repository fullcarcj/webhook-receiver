"use strict";

const { ensureAdmin } = require("../middleware/adminAuth");
const {
  createSession,
  startSession,
  submitLine,
  getSessionDetail,
  getSessionsPending,
  approveSession,
  getConfig,
  updateConfig,
} = require("../services/cycleCountService");

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

function validAdminSecret(req) {
  const s = process.env.ADMIN_SECRET;
  if (!s) return false;
  return timingSafeCompare(req.headers["x-admin-secret"], s);
}

/**
 * @returns {Promise<boolean>}
 */
async function handleCycleCountApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/count")) return false;

  try {
    if (req.method === "GET" && pathname === "/api/count/sessions/pending") {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await getSessionsPending();
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    const mStart = pathname.match(/^\/api\/count\/sessions\/(\d+)\/start$/);
    if (req.method === "POST" && mStart) {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await startSession(mStart[1]);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    const mApprove = pathname.match(/^\/api\/count\/sessions\/(\d+)\/approve$/);
    if (req.method === "POST" && mApprove) {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const data = await approveSession({
        sessionId: mApprove[1],
        userId: body.user_id,
        notes: body.notes,
      });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    const mSessionGet = pathname.match(/^\/api\/count\/sessions\/(\d+)$/);
    if (req.method === "GET" && mSessionGet) {
      const data = await getSessionDetail(mSessionGet[1]);
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "POST" && (pathname === "/api/count/sessions" || pathname === "/api/count/sessions/")) {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const data = await createSession({
        mode: body.mode,
        referenceName: body.reference_name,
        aisleId: body.aisle_id,
        filterSku: body.filter_sku,
        filterBinId: body.filter_bin_id,
        createdBy: body.created_by,
      });
      writeJson(res, 201, { ok: true, data });
      return true;
    }

    const mSubmit = pathname.match(/^\/api\/count\/lines\/(\d+)\/submit$/);
    if (req.method === "POST" && mSubmit) {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const data = await submitLine({
        lineId: mSubmit[1],
        qtyCounted: body.qty_counted,
        userId: body.user_id,
      });
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/count/config") {
      if (!ensureAdmin(req, res, url)) return true;
      const data = await getConfig();
      writeJson(res, 200, { ok: true, data });
      return true;
    }

    if (req.method === "PATCH" && pathname === "/api/count/config") {
      if (!ensureAdmin(req, res, url)) return true;
      const body = await parseJsonBody(req);
      const data = await updateConfig(body);
      writeJson(res, 200, { ok: true, data });
      return true;
    }
  } catch (e) {
    const code = e && e.code;
    const msg = (e && e.message) || String(e);
    if (code === "23503" || code === "23514" || code === "22P02" || code === "23505") {
      writeJson(res, 400, { ok: false, error: msg, code: code || "BAD_REQUEST" });
      return true;
    }
    if (code === "P0001") {
      writeJson(res, 422, { ok: false, error: msg });
      return true;
    }
    if (
      code === "INVALID_MODE" ||
      code === "INVALID_REFERENCE" ||
      code === "MISSING_AISLE" ||
      code === "MISSING_SKU" ||
      code === "MISSING_BIN" ||
      code === "INVALID_SESSION" ||
      code === "INVALID_LINE" ||
      code === "INVALID_QTY" ||
      code === "SESSION_NOT_FOUND" ||
      code === "INVALID_BODY"
    ) {
      writeJson(res, 400, { ok: false, error: msg, code });
      return true;
    }
    console.error("[cycle-count]", e);
    writeJson(res, 500, { ok: false, error: msg });
    return true;
  }

  return false;
}

module.exports = { handleCycleCountApiRequest };
