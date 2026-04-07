#!/usr/bin/env node
/**
 * Pruebas del módulo Customer Wallet.
 *
 * Uso:
 *   node scripts/test-wallet.js              — smoke contra BD (walletService), sin HTTP
 *   node scripts/test-wallet.js --http       — mismo flujo vía API (servidor debe estar arriba)
 *
 * Requiere: DATABASE_URL, migración sql/customer-wallet.sql aplicada.
 * Modo --http además: ADMIN_SECRET, BASE_URL (default http://127.0.0.1:$PORT con PORT=3001 si no está definido)
 */

"use strict";

require("../load-env-local");

const assert = require("assert");
const http = require("http");
const { URL } = require("url");

const walletService = require("../src/services/walletService");

/** Mismo criterio que server.js: PORT || 3001 */
const SERVER_PORT = String(process.env.PORT != null && process.env.PORT !== "" ? process.env.PORT : 3001);
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${SERVER_PORT}`;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

function printConnRefusedHelp(err) {
  const u = new URL(BASE_URL);
  console.error(
    "\n[wallet http] No hay servidor escuchando en %s (%s).\n\n" +
      "  • Levantá el receptor en otra terminal:  npm start\n" +
      "  • El script usa BASE_URL=%s (ajustá PORT o BASE_URL si el servidor no está en ese puerto).\n" +
      "  • Prueba solo contra la base (sin HTTP):  npm run test-wallet\n\n",
    BASE_URL,
    err && err.message ? err.message : "ECONNREFUSED",
    BASE_URL
  );
}

function httpJson(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, BASE_URL);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Secret": ADMIN_SECRET,
      },
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = txt ? JSON.parse(txt) : {};
        } catch (e) {
          return reject(new Error(`JSON inválido: ${txt.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (body != null) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runServiceSmoke() {
  let customer;
  try {
    customer = await walletService.createCustomer({
      full_name: `Wallet smoke ${Date.now()}`,
      notes: "scripts/test-wallet.js",
    });
  } catch (e) {
    if (e.code === "WALLET_SCHEMA_MISSING") {
      console.log("[omitido] Esquema wallet no instalado (aplicar sql/customer-wallet.sql)");
      return;
    }
    throw e;
  }

  const customerId = customer.id;
  const wallet = await walletService.ensureWallet(customerId, "USD");
  assert(wallet && wallet.id, "wallet ensure");

  const tx1 = await walletService.createTransaction({
    wallet_id: wallet.id,
    customer_id: customerId,
    tx_type: "CREDIT_RETURN",
    status: "CONFIRMED",
    currency: "USD",
    amount: 100,
    approved_by: 1,
    reference_type: "manual",
    reference_id: `smoke-${Date.now()}`,
  });
  assert.strictEqual(Number(tx1.amount), 100);

  const sum1 = await walletService.getWalletSummaryByCustomerId(customerId, "USD");
  assert(sum1.length >= 1, "summary rows");
  assert.strictEqual(Number(sum1[0].balance_current), 100);

  const tx2 = await walletService.createTransaction({
    wallet_id: wallet.id,
    customer_id: customerId,
    tx_type: "DEBIT_PURCHASE",
    status: "CONFIRMED",
    currency: "USD",
    amount: -60,
    reference_type: "purchase",
  });
  assert.strictEqual(Number(tx2.amount), -60);

  const sum2 = await walletService.getWalletSummaryByCustomerId(customerId, "USD");
  assert.strictEqual(Number(sum2[0].balance_current), 40);

  let negErr;
  try {
    await walletService.createTransaction({
      wallet_id: wallet.id,
      customer_id: customerId,
      tx_type: "DEBIT_PURCHASE",
      status: "CONFIRMED",
      currency: "USD",
      amount: -50,
      reference_type: "purchase",
    });
  } catch (e) {
    negErr = e;
  }
  assert(negErr && negErr.code === "NEGATIVE_BALANCE", "debe rechazar saldo negativo");

  const pending = await walletService.createTransaction({
    wallet_id: wallet.id,
    customer_id: customerId,
    tx_type: "CREDIT_ADJUSTMENT",
    status: "PENDING",
    currency: "USD",
    amount: 5,
    reference_type: "manual",
  });
  const confirmed = await walletService.confirmTransaction(pending.id, { approved_by: 1 });
  assert.strictEqual(confirmed.status, "CONFIRMED");

  const sum3 = await walletService.getWalletSummaryByCustomerId(customerId, "USD");
  assert.strictEqual(Number(sum3[0].balance_current), 45);

  console.log("OK smoke walletService (customer_id=%s)", customerId);
}

async function runHttpSmoke() {
  if (!ADMIN_SECRET) {
    console.error("ADMIN_SECRET requerido para --http");
    process.exit(1);
  }

  const drift = await httpJson("GET", "/api/wallet/drift", null);
  if (drift.status === 503 && drift.json.error === "WALLET_SCHEMA_MISSING") {
    console.warn(
      "\n[omitido] La base de datos no tiene el esquema customer wallet (API 503).\n\n" +
        "  Aplicá la migración (misma DATABASE_URL que usa el servidor):\n" +
        '    psql "$env:DATABASE_URL" -f sql/customer-wallet.sql\n' +
        "  (PowerShell; en bash: psql \"$DATABASE_URL\" -f sql/customer-wallet.sql)\n\n" +
        "  Luego: npm run test-wallet-http\n"
    );
    return;
  }
  assert.strictEqual(drift.status, 200, `drift: ${JSON.stringify(drift.json)}`);

  const name = `HTTP wallet ${Date.now()}`;
  const c = await httpJson("POST", "/api/wallet/customers", { full_name: name, notes: "test-wallet http" });
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  const customerId = c.json.data.id;

  const w = await httpJson("POST", "/api/wallet/wallets/ensure", { customer_id: customerId, currency: "USD" });
  assert.strictEqual(w.status, 200, JSON.stringify(w.json));

  const t1 = await httpJson("POST", "/api/wallet/transactions", {
    wallet_id: w.json.data.id,
    customer_id: customerId,
    tx_type: "CREDIT_RETURN",
    status: "CONFIRMED",
    currency: "USD",
    amount: 100,
    approved_by: 1,
    reference_type: "manual",
    reference_id: `http-${Date.now()}`,
  });
  assert.strictEqual(t1.status, 201, JSON.stringify(t1.json));

  const s = await httpJson("GET", `/api/wallet/summary?customer_id=${customerId}&currency=USD`, null);
  assert.strictEqual(s.status, 200, JSON.stringify(s.json));
  assert.strictEqual(Number(s.json.items[0].balance_current), 100);

  const t2 = await httpJson("POST", "/api/wallet/transactions", {
    wallet_id: w.json.data.id,
    customer_id: customerId,
    tx_type: "DEBIT_PURCHASE",
    status: "CONFIRMED",
    currency: "USD",
    amount: -100,
    reference_type: "purchase",
  });
  assert.strictEqual(t2.status, 201, JSON.stringify(t2.json));

  const t3 = await httpJson("POST", "/api/wallet/transactions", {
    wallet_id: w.json.data.id,
    customer_id: customerId,
    tx_type: "DEBIT_PURCHASE",
    status: "CONFIRMED",
    currency: "USD",
    amount: -1,
    reference_type: "purchase",
  });
  assert.strictEqual(t3.status, 409, "debe fallar 409 saldo insuficiente");

  console.log("OK smoke HTTP /api/wallet (customer_id=%s)", customerId);
}

async function main() {
  const httpMode = process.argv.includes("--http");
  if (httpMode) {
    await runHttpSmoke();
  } else {
    await runServiceSmoke();
  }
}

main().catch((e) => {
  if (e && (e.code === "ECONNREFUSED" || e.errno === -4078)) {
    printConnRefusedHelp(e);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
