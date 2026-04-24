"use strict";

/**
 * fbmp_edge — Facebook Marketplace Personal (puente extensión Chrome)
 *
 * Rutas:
 *   POST /api/fbmp-edge/ingest               — extensión envía mensajes scrapeados
 *   GET  /api/fbmp-edge/outbox               — extensión consulta mensajes a enviar
 *   POST /api/fbmp-edge/outbox/:id/ack       — extensión confirma envío
 *   POST /api/fbmp-edge/outbox/:id/fail      — extensión reporta fallo
 *   GET  /api/fbmp-edge/threads              — admin: listado de hilos
 *   POST /api/fbmp-edge/threads/:id/reply    — operador ERP encola respuesta
 *   GET  /api/fbmp-edge/status               — health del módulo
 *
 * Auth:
 *   - Extensión (ingest/outbox/ack/fail): Bearer FBMP_EDGE_INGEST_SECRET
 *   - Admin (threads/reply/status con ?k= o X-Admin-Secret): requireAdminOrPermission
 */

const pino = require("pino");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { rateLimit, getClientIp } = require("../utils/rateLimiter");
const {
  upsertThread,
  ingestMessages,
  getPendingOutbox,
  getAllPendingOutbox,
  ackOutboxMessage,
  failOutboxMessage,
  listThreads,
  enqueueOutbox,
  getStats,
} = require("../services/fbmpEdgeService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "fbmp_edge_handler" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const MAX = 512 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > MAX) throw Object.assign(new Error("body_too_large"), { code: "BODY_TOO_LARGE" });
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

// Rate limiter dedicado: 120 req/min por IP (suficiente para un navegador activo)
const ingestLimiter = rateLimit({ maxRequests: 120, windowMs: 60_000 });

/**
 * Verifica el Bearer de la extensión.
 * Devuelve true si es válido, escribe 401 y devuelve false si no.
 */
function checkExtensionBearer(req, res) {
  const secret = (process.env.FBMP_EDGE_INGEST_SECRET || "").trim();
  if (!secret) {
    writeJson(res, 503, { error: "fbmp_edge_not_configured", message: "FBMP_EDGE_INGEST_SECRET no está definido" });
    return false;
  }
  const auth = (req.headers["authorization"] || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== secret) {
    writeJson(res, 401, { error: "unauthorized", message: "Bearer inválido" });
    return false;
  }
  return true;
}

/**
 * Valida un mensaje del batch de ingest.
 * Devuelve null si válido, string con motivo si inválido.
 */
function validateIngestMessage(msg, idx) {
  if (!msg || typeof msg !== "object") return `messages[${idx}]: no es objeto`;
  if (!["inbound", "outbound"].includes(msg.direction)) return `messages[${idx}]: direction inválido`;
  if (!msg.body || typeof msg.body !== "string" || !msg.body.trim()) return `messages[${idx}]: body vacío`;
  if (!msg.dedupe_key || typeof msg.dedupe_key !== "string") return `messages[${idx}]: dedupe_key requerido`;
  return null;
}

/**
 * Handler principal.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleFbmpEdgeApiRequest(req, res, url) {
  const pathname = url.pathname || "";
  if (!pathname.startsWith("/api/fbmp-edge")) return false;

  const enabled = process.env.FBMP_EDGE_ENABLED === "1";

  // ── GET /api/fbmp-edge/status ─────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/fbmp-edge/status") {
    try {
      const stats = await getStats();
      writeJson(res, 200, { ok: true, ...stats });
    } catch (_) {
      writeJson(res, 200, { ok: true, enabled, stats_unavailable: true });
    }
    return true;
  }

  // ── GET /api/fbmp-edge/threads (admin) ────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/fbmp-edge/threads") {
    const user = await requireAdminOrPermission(req, res, "settings");
    if (!user) return true;
    try {
      const limit  = Math.min(100, parseInt(url.searchParams.get("limit")  || "50", 10) || 50);
      const offset = Math.max(0,   parseInt(url.searchParams.get("offset") || "0",  10) || 0);
      const threads = await listThreads({ limit, offset });
      writeJson(res, 200, { ok: true, items: threads, limit, offset });
    } catch (err) {
      log.error({ err: err.message }, "fbmp_edge: listThreads error");
      writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  }

  // ── POST /api/fbmp-edge/threads/:id/reply (admin, encola mensaje de salida) ──
  const replyMatch = pathname.match(/^\/api\/fbmp-edge\/threads\/(\d+)\/reply$/);
  if (req.method === "POST" && replyMatch) {
    const user = await requireAdminOrPermission(req, res, "settings");
    if (!user) return true;
    if (!enabled) {
      writeJson(res, 503, { error: "fbmp_edge_disabled", message: "FBMP_EDGE_ENABLED != 1" });
      return true;
    }
    let body;
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const threadId = Number(replyMatch[1]);
    const text = body && body.text ? String(body.text).trim() : "";
    if (!text) {
      writeJson(res, 400, { error: "bad_request", message: "text requerido" });
      return true;
    }
    try {
      const outboxId = await enqueueOutbox({
        threadId,
        body: text,
        sentBy:  user.username || user.email || null,
        userId:  user.userId   || null,
      });
      writeJson(res, 200, { ok: true, outbox_id: outboxId });
    } catch (err) {
      log.error({ err: err.message, threadId }, "fbmp_edge: enqueueOutbox error");
      writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  }

  // ── A partir de aquí: rutas de la EXTENSIÓN (Bearer) ──────────────────────

  // Rate limit por IP antes de validar Bearer
  const ip = getClientIp(req);
  const rl = ingestLimiter(ip, "fbmp_edge");
  if (!rl.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rl.retryAfterSec || 60),
    });
    res.end(JSON.stringify({ error: "rate_limited", retry_after: rl.retryAfterSec }));
    return true;
  }

  // ── POST /api/fbmp-edge/ingest ────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/fbmp-edge/ingest") {
    if (!checkExtensionBearer(req, res)) return true;
    if (!enabled) {
      writeJson(res, 503, { error: "fbmp_edge_disabled", message: "FBMP_EDGE_ENABLED != 1" });
      return true;
    }

    let body;
    try { body = await parseJsonBody(req); } catch (_) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }

    const externalThreadId = body && body.thread_external_id ? String(body.thread_external_id).trim() : "";
    if (!externalThreadId) {
      writeJson(res, 400, { error: "bad_request", message: "thread_external_id requerido" });
      return true;
    }

    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    if (!rawMessages.length) {
      writeJson(res, 400, { error: "bad_request", message: "messages[] requerido y no vacío" });
      return true;
    }
    if (rawMessages.length > 100) {
      writeJson(res, 400, { error: "bad_request", message: "máximo 100 mensajes por batch" });
      return true;
    }

    // Validar cada mensaje del batch
    for (let i = 0; i < rawMessages.length; i++) {
      const err = validateIngestMessage(rawMessages[i], i);
      if (err) {
        writeJson(res, 400, { error: "bad_request", message: err });
        return true;
      }
    }

    try {
      const { threadId, chatId, created } = await upsertThread({
        externalThreadId,
        participantName: body.participant_name  ? String(body.participant_name).slice(0, 200)  : undefined,
        participantFbId: body.participant_fb_id ? String(body.participant_fb_id).slice(0, 100) : undefined,
      });

      const result = await ingestMessages({ threadId, chatId, messages: rawMessages });

      log.info({
        threadId, chatId, created,
        inserted:   result.inserted,
        duplicates: result.duplicates,
        errors:     result.errors,
      }, "fbmp_edge: ingest OK");

      writeJson(res, 200, {
        ok:         true,
        thread_id:  threadId,
        chat_id:    chatId,
        created,
        inserted:   result.inserted,
        duplicates: result.duplicates,
        errors:     result.errors,
      });
    } catch (err) {
      log.error({ err: err.message, externalThreadId }, "fbmp_edge: ingest error");
      if (err.code === "42P01") {
        writeJson(res, 503, { error: "schema_missing", message: "Ejecutá npm run db:fbmp-edge" });
      } else {
        writeJson(res, 500, { error: "internal_error" });
      }
    }
    return true;
  }

  // ── GET /api/fbmp-edge/outbox ─────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/fbmp-edge/outbox") {
    if (!checkExtensionBearer(req, res)) return true;
    try {
      const threadExtId = url.searchParams.get("thread_external_id") || "";
      const items = threadExtId
        ? await getPendingOutbox(threadExtId)
        : await getAllPendingOutbox();
      writeJson(res, 200, { ok: true, items });
    } catch (err) {
      log.error({ err: err.message }, "fbmp_edge: outbox error");
      writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  }

  // ── POST /api/fbmp-edge/outbox/:id/ack ────────────────────────────────────
  const ackMatch = pathname.match(/^\/api\/fbmp-edge\/outbox\/(\d+)\/ack$/);
  if (req.method === "POST" && ackMatch) {
    if (!checkExtensionBearer(req, res)) return true;
    const outboxId = Number(ackMatch[1]);
    try {
      const ok = await ackOutboxMessage(outboxId);
      writeJson(res, ok ? 200 : 404, { ok, outbox_id: outboxId });
    } catch (err) {
      log.error({ err: err.message, outboxId }, "fbmp_edge: ack error");
      writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  }

  // ── POST /api/fbmp-edge/outbox/:id/fail ───────────────────────────────────
  const failMatch = pathname.match(/^\/api\/fbmp-edge\/outbox\/(\d+)\/fail$/);
  if (req.method === "POST" && failMatch) {
    if (!checkExtensionBearer(req, res)) return true;
    const outboxId = Number(failMatch[1]);
    let body;
    try { body = await parseJsonBody(req); } catch (_) { body = {}; }
    const errorMsg = body && body.error ? String(body.error).slice(0, 500) : null;
    try {
      await failOutboxMessage(outboxId, errorMsg);
      writeJson(res, 200, { ok: true, outbox_id: outboxId });
    } catch (err) {
      log.error({ err: err.message, outboxId }, "fbmp_edge: fail error");
      writeJson(res, 500, { error: "internal_error" });
    }
    return true;
  }

  return false;
}

module.exports = { handleFbmpEdgeApiRequest };
