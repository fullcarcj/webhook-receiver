const {
  fetchAndSaveDailyRates,
  manualOverride,
  getTodayRate,
  getRateHistory,
  getProductPrices,
} = require("../services/currencyService");

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
  return req.headers["x-admin-secret"] === s;
}

function validCronToken(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+/i.test(String(auth))) return false;
  const token = String(auth).replace(/^Bearer\s+/i, "").trim();
  return token === secret;
}

function ensureAdminAuth(req, res) {
  if (!process.env.ADMIN_SECRET) {
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  if (!validAdminSecret(req)) {
    writeJson(res, 401, { ok: false, error: "no autorizado" });
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
      const history = await getRateHistory({ companyId, fromDate, toDate, page, pageSize });
      writeJson(res, 200, { ok: true, ...history });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/currency/products") {
      const companyId = Number(url.searchParams.get("company_id") || 1);
      const page = Number(url.searchParams.get("page") || 1);
      const limit = Number(url.searchParams.get("limit") || 50);
      const search = url.searchParams.get("search");
      const data = await getProductPrices({ companyId, page, limit, search });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/currency/override") {
      if (!ensureAdminAuth(req, res)) return true;
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
      const byAdmin = validAdminSecret(req);
      const byCron = validCronToken(req);
      if (!byAdmin && !byCron) {
        writeJson(res, 401, { ok: false, error: "no autorizado" });
        return true;
      }
      const result = await fetchAndSaveDailyRates();
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

