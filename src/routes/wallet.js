"use strict";

const { timingSafeCompare } = require("../services/currencyService");
const walletService = require("../services/walletService");

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

function ensureAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  const provided = req.headers["x-admin-secret"];
  if (!timingSafeCompare(provided, secret)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

function walletErrorStatus(err) {
  const c = err && err.code;
  if (c === "BAD_REQUEST") return 400;
  if (c === "NOT_FOUND") return 404;
  if (c === "CONFLICT") return 409;
  if (c === "NEGATIVE_BALANCE") return 409;
  if (c === "WALLET_SCHEMA_MISSING") return 503;
  return 500;
}

async function handleWalletApiRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/wallet")) return false;

  try {
    if (!ensureAdmin(req, res)) return true;

    if (req.method === "GET" && url.pathname === "/api/wallet/summary") {
      const customerId = url.searchParams.get("customer_id");
      const mlBuyerId = url.searchParams.get("ml_buyer_id");
      const currency = url.searchParams.get("currency") || undefined;
      if (customerId && mlBuyerId) {
        writeJson(res, 400, { ok: false, error: "usar solo customer_id o ml_buyer_id" });
        return true;
      }
      if (customerId) {
        const rows = await walletService.getWalletSummaryByCustomerId(customerId, currency);
        writeJson(res, 200, { ok: true, items: rows });
        return true;
      }
      if (mlBuyerId) {
        const rows = await walletService.getWalletSummaryByMlBuyerId(mlBuyerId, currency);
        writeJson(res, 200, { ok: true, items: rows });
        return true;
      }
      writeJson(res, 400, { ok: false, error: "customer_id o ml_buyer_id requerido" });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wallet/drift") {
      const rows = await walletService.listDriftRows();
      writeJson(res, 200, { ok: true, items: rows, count: rows.length });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wallet/customers") {
      const data = await walletService.listCustomers({
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wallet/customer") {
      const id = url.searchParams.get("id");
      if (!id) {
        writeJson(res, 400, { ok: false, error: "id requerido" });
        return true;
      }
      const row = await walletService.getCustomer(id);
      if (!row) {
        writeJson(res, 404, { ok: false, error: "not_found" });
        return true;
      }
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/wallet/transactions") {
      const customerId = url.searchParams.get("customer_id");
      if (!customerId) {
        writeJson(res, 400, { ok: false, error: "customer_id requerido" });
        return true;
      }
      const data = await walletService.listTransactions(customerId, {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      });
      writeJson(res, 200, { ok: true, ...data });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/customers") {
      const body = await parseJsonBody(req);
      const row = await walletService.createCustomer(body);
      writeJson(res, 201, { ok: true, data: row });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/link-ml-buyer") {
      const body = await parseJsonBody(req);
      const row = await walletService.linkMlBuyer(body);
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/wallets/ensure") {
      const body = await parseJsonBody(req);
      const row = await walletService.ensureWallet(body.customer_id, body.currency);
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/transactions") {
      const body = await parseJsonBody(req);
      const row = await walletService.createTransaction(body);
      writeJson(res, 201, { ok: true, data: row });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/transactions/confirm") {
      const body = await parseJsonBody(req);
      const id = body.id != null ? body.id : body.transaction_id;
      const row = await walletService.confirmTransaction(id, body);
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/wallet/transactions/cancel") {
      const body = await parseJsonBody(req);
      const id = body.id != null ? body.id : body.transaction_id;
      const row = await walletService.cancelTransaction(id, body);
      writeJson(res, 200, { ok: true, data: row });
      return true;
    }

    writeJson(res, 404, { ok: false, error: "not_found" });
    return true;
  } catch (e) {
    const code = e && e.code;
    const status = walletErrorStatus(e);
    if (status === 500) console.error("[wallet]", e);
    const body = {
      ok: false,
      error: code || "error",
      detail: e && e.message ? String(e.message) : "error",
    };
    if (code === "WALLET_SCHEMA_MISSING") {
      body.detail = "Ejecutar migración sql/customer-wallet.sql";
    }
    writeJson(res, status, body);
    return true;
  }
}

module.exports = { handleWalletApiRequest };
