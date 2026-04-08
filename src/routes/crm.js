"use strict";

const pino = require("pino");
const { listWhatsappLogs, mapSchemaError } = require("../services/crmIdentityService");
const { routeWebhook } = require("../whatsapp/hookRouter");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { ensureAdmin } = require("../middleware/adminAuth");
const { pool } = require("../../db");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "crm",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
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

function crmErrorStatus(err) {
  if (err && err.name === "ZodError") return 422;
  const c = err && err.code;
  if (c === "BAD_REQUEST") return 400;
  if (c === "CRM_SCHEMA_MISSING") return 503;
  if (err && err.code === "23505") return 409;
  return 500;
}

function handleCrmError(res, err, isDev) {
  const status = crmErrorStatus(err);
  if (err && err.name === "ZodError") {
    writeJson(res, 422, {
      error: "validation_error",
      details: err.issues,
    });
    return;
  }
  if (err && err.code === "23505") {
    writeJson(res, 409, { error: "conflict", detail: err.message });
    return;
  }
  if (err && err.code === "CRM_SCHEMA_MISSING") {
    writeJson(res, 503, {
      error: "crm_schema_missing",
      detail: "Ejecutar migración sql/crm-solomotor3k.sql",
    });
    return;
  }
  if (status === 500) logger.error({ err }, "crm_error");
  writeJson(res, status, {
    error: err && err.code ? String(err.code) : "error",
    message:
      status === 500 && !isDev
        ? "Internal server error"
        : err && err.message
          ? String(err.message)
          : "error",
  });
}

async function handleCrmApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  const isDev = process.env.NODE_ENV !== "production";

  if (pathname === "/webhook/whatsapp" && req.method === "GET") {
    try {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      const expected = process.env.WA_VERIFY_TOKEN;
      if (mode === "subscribe" && expected && token === expected && challenge) {
        writeText(res, 200, challenge);
        return true;
      }
      writeJson(res, 403, { error: "forbidden" });
      return true;
    } catch (e) {
      handleCrmError(res, e, isDev);
      return true;
    }
  }

  if (pathname === "/webhook/whatsapp" && req.method === "POST") {
    try {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (_e) {
        body = {};
      }
      writeJson(res, 200, { status: "ok" });
      setImmediate(() => {
        routeWebhook(body).catch((err) => {
          logger.error({ err }, "whatsapp_hub_route");
        });
      });
      return true;
    } catch (e) {
      try {
        writeJson(res, 200, { status: "ok" });
      } catch (_e2) {
        /* ignore */
      }
      logger.error({ err: e }, "whatsapp_webhook_error");
      return true;
    }
  }

  if (!pathname.startsWith("/api/crm")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (!ensureAdmin(req, res, url)) return true;

  try {
    if (req.method === "GET" && pathname === "/api/crm/logs") {
      const customerId = url.searchParams.get("customer_id") || undefined;
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const data = await listWhatsappLogs({
        customerId,
        limit: limit != null ? Number(limit) : 50,
        offset: offset != null ? Number(offset) : 0,
      });
      writeJson(res, 200, data);
      return true;
    }

    writeJson(res, 404, { error: "not_found" });
    return true;
  } catch (e) {
    if (e && e.code === "23505") {
      handleCrmError(res, e, isDev);
      return true;
    }
    const mapped = mapSchemaError(e);
    handleCrmError(res, mapped, isDev);
    return true;
  }
}

module.exports = { handleCrmApiRequest, logger: logger };
