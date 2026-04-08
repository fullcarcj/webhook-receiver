#!/usr/bin/env node
/**
 * Llama POST /api/sales/import/ml en un servidor remoto (p. ej. Render) con admin por cabecera o ?k=.
 *
 * Requiere: SALES_ML_IMPORT_ENABLED=1 en el servidor destino.
 *
 * Variables (o oauth-env.json vía load-env-local):
 *   SALES_IMPORT_BASE_URL — base sin barra final, ej. https://webhook-receiver-xxx.onrender.com
 *   ADMIN_SECRET — cabecera X-Admin-Secret (o usar ?k= con IMPORT_USE_QUERY_K=1)
 *   ML_USER_ID — cuenta ML (ml_accounts.ml_user_id); no hace falta si usás --all-accounts
 * Opcionales: LIMIT, OFFSET, ML_FEEDBACK_FILTER, ORDER_ID (una orden), IMPORT_USE_QUERY_K=1
 *   --all-accounts o ML_IMPORT_ALL_ACCOUNTS=1 — lote sobre todas las cuentas en ml_accounts
 */
"use strict";

require("../load-env-local");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { parseCliOption } = require("./parseCliOption");

function parseArg(name) {
  return parseCliOption(process.argv, name);
}

function requestJson(urlStr, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: opts.method || "GET",
        headers: opts.headers || {},
        timeout: Number(process.env.SALES_IMPORT_TIMEOUT_MS || 120000),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          let body;
          try {
            body = txt ? JSON.parse(txt) : {};
          } catch {
            body = { raw: txt };
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  const base =
    parseArg("base-url") ||
    process.env.SALES_IMPORT_BASE_URL ||
    process.env.RENDER_URL ||
    "";
  const secret = process.env.ADMIN_SECRET;
  const allAccounts =
    process.argv.includes("--all-accounts") ||
    String(process.env.ML_IMPORT_ALL_ACCOUNTS || "").trim() === "1";
  const mlUserId = Number(parseArg("ml-user-id") || process.env.ML_USER_ID);
  const orderIdRaw = parseArg("order-id") || process.env.ORDER_ID;
  const limit = parseArg("limit") != null ? Number(parseArg("limit")) : Number(process.env.LIMIT || "50");
  const offset = parseArg("offset") != null ? Number(parseArg("offset")) : Number(process.env.OFFSET || "0");
  const fb =
    parseArg("ml-feedback-filter") ||
    process.env.ML_FEEDBACK_FILTER ||
    undefined;
  const useQueryK = String(process.env.IMPORT_USE_QUERY_K || "").trim() === "1";

  if (!base || !String(base).trim()) {
    console.error("Definir SALES_IMPORT_BASE_URL o RENDER_URL (o --base-url=https://...)");
    process.exit(1);
  }
  if (!secret || !String(secret).trim()) {
    console.error("Definir ADMIN_SECRET");
    process.exit(1);
  }
  const hasOrder = orderIdRaw != null && String(orderIdRaw).trim() !== "";
  if (hasOrder && (!Number.isFinite(mlUserId) || mlUserId <= 0)) {
    console.error("Con ORDER_ID hace falta ML_USER_ID o --ml-user-id=");
    process.exit(1);
  }
  if (!hasOrder && !allAccounts && (!Number.isFinite(mlUserId) || mlUserId <= 0)) {
    console.error("Definir ML_USER_ID / --ml-user-id= o --all-accounts (lote todas las cuentas)");
    process.exit(1);
  }

  const baseTrim = String(base).replace(/\/+$/, "");
  let path = "/api/sales/import/ml";
  const payload = {};
  if (allAccounts && !hasOrder) {
    payload.all_accounts = true;
  } else {
    payload.ml_user_id = mlUserId;
  }
  if (hasOrder) {
    payload.order_id = Number(orderIdRaw);
  } else {
    payload.limit = limit;
    payload.offset = offset;
    if (fb && String(fb).trim() !== "" && fb !== "none") {
      payload.ml_feedback_filter = String(fb).trim();
    }
  }

  let url = `${baseTrim}${path}`;
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (useQueryK) {
    const u = new URL(url);
    u.searchParams.set("k", secret);
    url = u.toString();
  } else {
    headers["X-Admin-Secret"] = secret;
  }

  const { status, body } = await requestJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  console.log(JSON.stringify({ http_status: status, body }, null, 2));
  if (status < 200 || status >= 300) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}
