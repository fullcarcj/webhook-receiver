const {
  fetchAndSaveDailyRates,
  manualOverride,
  getTodayRate,
  getRateHistory,
  getProductPrices,
  timingSafeCompare,
} = require("../services/currencyService");
const { getClientIp, adminRequestLimiter, adminAuthFailLimiter } = require("../utils/rateLimiter");

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
  const provided = req.headers["x-admin-secret"];
  return timingSafeCompare(provided, s);
}

function validCronToken(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+/i.test(String(auth))) return false;
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  return timingSafeCompare(token, secret);
}

function ensureAdminAuth(req, res) {
  if (!process.env.ADMIN_SECRET) {
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  if (!validAdminSecret(req)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

/**
 * Handler integrado al server HTTP actual.
 * @returns {Promise<boolean>} true si la ruta fue atendida
 */
async function handleCurrencyApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/currency")) return false;

  try {
    if (req.method === "GET" && url.pathname === "/api/currency/today") {
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const rate = await getTodayRate(companyId);
      writeJson(res, 200, { ok: true, data: rate });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/currency/history") {
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const fromDate = url.searchParams.get("from");
      const toDate = url.searchParams.get("to");
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("page_size") || 50);
      const rows = await getRateHistory({ companyId, fromDate, toDate, page, pageSize });
      writeJson(res, 200, { ok: true, rows });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/currency/products") {
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const page = Number(url.searchParams.get("page") || 1);
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const search = url.searchParams.get("search");
      const rows = await getProductPrices({ companyId, page, limit, search });
      writeJson(res, 200, { ok: true, page, limit, rows });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/currency/override") {
      if (!ensureAdminAuth(req, res)) return true;
      const ip = getClientIp(req);
      const lim = adminRequestLimiter(ip, "currency_override");
      if (!lim.allowed) {
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(lim.retryAfterSec),
        });
        res.end(JSON.stringify({ ok: false, error: "rate_limit_exceeded", retryAfterSeconds: lim.retryAfterSec }));
        return true;
      }
      let body;
      try {
        body = await parseJsonBody(req);
      } catch {
        writeJson(res, 400, { ok: false, error: "body debe ser JSON" });
        return true;
      }
      const row = await manualOverride({
        userId: Number(body.user_id || 0),
        companyId: Number(body.company_id || 1),
        rateDate: body.rate_date,
        field: body.field,
        value: body.value,
        reason: body.reason,
      });
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/currency/fetch") {
      const ip = getClientIp(req);
      const lim = adminRequestLimiter(ip, "currency_fetch");
      if (!lim.allowed) {
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(lim.retryAfterSec),
        });
        res.end(JSON.stringify({ ok: false, error: "rate_limit_exceeded", retryAfterSeconds: lim.retryAfterSec }));
        return true;
      }
      const byAdmin = validAdminSecret(req);
      const byCron = validCronToken(req);
      if (!byAdmin && !byCron) {
        writeJson(res, 403, { ok: false, error: "forbidden" });
        return true;
      }
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const result = await fetchAndSaveDailyRates(companyId);
      writeJson(res, 200, result);
      return true;
    }

    writeJson(res, 405, { ok: false, error: "método no permitido" });
    return true;
  } catch (e) {
    writeJson(res, 500, { ok: false, error: e.message || String(e) });
    return true;
  }
}

module.exports = {
  handleCurrencyApiRequest,
};

