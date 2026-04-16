"use strict";

const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { listInbox, getInboxCounts, FILTERS, SRCS } = require("../services/inboxService");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_api",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Inbox unificado CRM + órdenes: GET /api/inbox, GET /api/inbox/counts
 * @returns {Promise<boolean>}
 */
async function handleInboxApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/inbox")) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (!(await requireAdminOrPermission(req, res, "crm"))) {
    return true;
  }

  try {
    if (req.method === "GET" && pathname === "/api/inbox/counts") {
      const data = await getInboxCounts();
      writeJson(res, 200, data);
      return true;
    }

    if (req.method === "GET" && pathname === "/api/inbox") {
      const filter = url.searchParams.get("filter");
      const src = url.searchParams.get("src");
      const search = url.searchParams.get("search");
      const cursor = url.searchParams.get("cursor");
      const limit = url.searchParams.get("limit");

      if (filter != null && filter !== "" && !FILTERS.has(filter)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `filter inválido. Valores: ${[...FILTERS].join(", ")} o vacío`,
        });
        return true;
      }
      if (src != null && src !== "" && !SRCS.has(src)) {
        writeJson(res, 400, {
          error: "bad_request",
          message: `src inválido. Valores: ${[...SRCS].join(", ")} o vacío`,
        });
        return true;
      }

      const data = await listInbox({
        filter: filter || null,
        src: src || null,
        search: search || null,
        cursor: cursor || null,
        limit,
      });
      writeJson(res, 200, data);
      return true;
    }

    writeJson(res, 405, { error: "method_not_allowed" });
    return true;
  } catch (err) {
    if (err && err.code === "BAD_REQUEST") {
      writeJson(res, 400, { error: "bad_request", message: err.message });
      return true;
    }
    if (err && err.code === "CRM_SCHEMA_MISSING") {
      writeJson(res, 503, {
        error: "crm_schema_missing",
        message: err.message || String(err),
      });
      return true;
    }
    logger.error({ err: err.message }, "inbox_api");
    writeJson(res, 500, { error: "internal_error" });
    return true;
  }
}

module.exports = { handleInboxApiRequest };
