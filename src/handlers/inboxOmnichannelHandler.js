"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAuth } = require("../utils/authMiddleware");
const { transition, EVENTS } = require("../services/crmChatStateMachine");
const sseBroker = require("../realtime/sseBroker");
const slaTimerManager = require("../services/slaTimerManager");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  name: "inbox_omnichannel",
});

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  const max = 64 * 1024;
  for await (const c of req) {
    total += c.length;
    if (total > max) throw new Error("body_too_large");
    chunks.push(c);
  }
  const txt = Buffer.concat(chunks).toString("utf8");
  if (!txt.trim()) return {};
  return JSON.parse(txt);
}

/** Cache en memoria: userId → displayName. TTL 5 min para no estancarse tras cambio de nombre. */
const _userNameCache = new Map();
const USER_NAME_TTL_MS = 5 * 60 * 1000;

async function loadUserDisplayName(userId) {
  const cached = _userNameCache.get(userId);
  if (cached && (Date.now() - cached.ts) < USER_NAME_TTL_MS) return cached.name;

  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(full_name), ''), NULLIF(TRIM(username), ''), 'Usuario') AS display_name
     FROM users WHERE id = $1`,
    [userId]
  );
  const name = rows[0] && rows[0].display_name ? String(rows[0].display_name) : "Usuario";
  _userNameCache.set(userId, { name, ts: Date.now() });
  return name;
}

/**
 * @returns {Promise<boolean>}
 */
async function handleInboxOmnichannelRequest(req, res, url) {
  const pathname = (url.pathname || "").replace(/\/+$/, "") || "/";

  const takeM = pathname.match(/^\/api\/inbox\/chats\/(\d+)\/take\/?$/);
  const releaseM = pathname.match(/^\/api\/inbox\/chats\/(\d+)\/release\/?$/);
  const presenceM = pathname.match(/^\/api\/inbox\/chats\/(\d+)\/presence\/?$/);
  const discardM = pathname.match(/^\/api\/inbox\/chats\/(\d+)\/discard\/?$/);
  const streamPath =
    pathname === "/api/realtime/stream" || pathname === "/api/realtime/stream/";

  if (!takeM && !releaseM && !presenceM && !discardM && !streamPath) {
    return false;
  }

  applyCrmApiCorsHeaders(req, res);

  if (streamPath && req.method === "GET") {
    const user = await requireAuth(req, res);
    if (!user) return true;
    const userId = user.userId != null ? Number(user.userId) : NaN;
    if (!Number.isFinite(userId) || userId <= 0) {
      writeJson(res, 401, {
        error: "UNAUTHORIZED",
        message: "Token inválido, expirado o no proporcionado.",
      });
      return true;
    }
    sseBroker.register(userId, res, req);
    try {
      res.write(
        `event: connected\ndata: ${JSON.stringify({ user_id: userId })}\n\n`
      );
    } catch (e) {
      logger.error({ err: e }, "omnichannel_sse_connected");
    }
    return true;
  }

  if (takeM && req.method === "POST") {
    const user = await requireAuth(req, res);
    if (!user) return true;
    const userId = user.userId != null ? Number(user.userId) : NaN;
    if (!Number.isFinite(userId) || userId <= 0) {
      writeJson(res, 401, {
        error: "UNAUTHORIZED",
        message: "Token inválido, expirado o no proporcionado.",
      });
      return true;
    }

    const chatId = Number(takeM[1]);
    let userName;
    try {
      userName = await loadUserDisplayName(userId);
    } catch (e) {
      logger.error({ err: e }, "omnichannel_user_name");
      userName = "Usuario";
    }

    const client = await pool.connect();
    let deadlineOut = null;
    try {
      await client.query("BEGIN");
      const { rows: chatRows } = await client.query(
        `SELECT * FROM crm_chats WHERE id = $1 FOR UPDATE`,
        [chatId]
      );
      if (!chatRows.length) {
        await client.query("ROLLBACK");
        writeJson(res, 404, {
          error: "NOT_FOUND",
          message: "Chat no encontrado.",
        });
        return true;
      }
      const chat = chatRows[0];

      const { rows: cntRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM crm_chats
         WHERE assigned_to = $1 AND status = 'PENDING_RESPONSE' AND id <> $2`,
        [userId, chatId]
      );
      const busy = Number(cntRows[0].n) || 0;
      if (busy >= 1) {
        await client.query("ROLLBACK");
        writeJson(res, 409, {
          error: "PENDING_SLOT_BUSY",
          message:
            "Debes responder o liberar tu conversación actual antes de tomar una nueva.",
        });
        return true;
      }

      let tr;
      try {
        tr = transition(chat, EVENTS.TAKE, { userId });
      } catch (e) {
        await client.query("ROLLBACK");
        if (e && e.message === "INVALID_TRANSITION") {
          writeJson(res, 409, {
            error: "INVALID_TRANSITION",
            message: "Este chat no se puede tomar en su estado actual.",
          });
          return true;
        }
        throw e;
      }

      await client.query(
        `UPDATE crm_chats
         SET status = $1,
             assigned_to = $2,
             sla_deadline_at = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [tr.nextStatus, tr.assignedTo, tr.slaDeadlineAt, chatId]
      );
      deadlineOut = tr.slaDeadlineAt;
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_r) {
        /* ignore */
      }
      logger.error({ err: e }, "inbox_take");
      writeJson(res, 500, { error: "internal_error" });
      return true;
    } finally {
      client.release();
    }

    if (deadlineOut) {
      slaTimerManager.schedule(chatId, deadlineOut);
    }
    sseBroker.broadcast("chat_taken", {
      chat_id: chatId,
      user_id: userId,
      user_name: userName,
    });
    sseBroker.broadcast("clear_notification", { chat_id: chatId });
    sseBroker.broadcast("sla_started", {
      chat_id: chatId,
      deadline_at:
        deadlineOut instanceof Date ? deadlineOut.toISOString() : String(deadlineOut),
    });

    writeJson(res, 200, {
      ok: true,
      status: "PENDING_RESPONSE",
      sla_deadline_at:
        deadlineOut instanceof Date ? deadlineOut.toISOString() : deadlineOut,
    });
    return true;
  }

  if (releaseM && req.method === "POST") {
    const user = await requireAuth(req, res);
    if (!user) return true;
    const userId = user.userId != null ? Number(user.userId) : NaN;
    if (!Number.isFinite(userId) || userId <= 0) {
      writeJson(res, 401, {
        error: "UNAUTHORIZED",
        message: "Token inválido, expirado o no proporcionado.",
      });
      return true;
    }

    const chatId = Number(releaseM[1]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: chatRows } = await client.query(
        `SELECT * FROM crm_chats WHERE id = $1 FOR UPDATE`,
        [chatId]
      );
      if (!chatRows.length) {
        await client.query("ROLLBACK");
        writeJson(res, 404, {
          error: "NOT_FOUND",
          message: "Chat no encontrado.",
        });
        return true;
      }
      const chat = chatRows[0];
      const assigned =
        chat.assigned_to != null ? Number(chat.assigned_to) : null;
      if (assigned !== userId) {
        await client.query("ROLLBACK");
        writeJson(res, 403, {
          error: "FORBIDDEN",
          message: "No tienes permiso para liberar este chat.",
        });
        return true;
      }

      let trRel;
      try {
        trRel = transition(chat, EVENTS.RELEASE, { userId });
      } catch (e) {
        await client.query("ROLLBACK");
        if (e && e.message === "FORBIDDEN") {
          writeJson(res, 403, {
            error: "FORBIDDEN",
            message: "No tienes permiso para liberar este chat.",
          });
          return true;
        }
        if (e && e.message === "INVALID_TRANSITION") {
          writeJson(res, 409, {
            error: "INVALID_TRANSITION",
            message: "Este chat no se puede liberar en su estado actual.",
          });
          return true;
        }
        throw e;
      }

      await client.query(
        `UPDATE crm_chats
         SET status = $1,
             assigned_to = $2,
             sla_deadline_at = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [trRel.nextStatus, trRel.assignedTo, trRel.slaDeadlineAt, chatId]
      );
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_r) {
        /* ignore */
      }
      logger.error({ err: e }, "inbox_release");
      writeJson(res, 500, { error: "internal_error" });
      return true;
    } finally {
      client.release();
    }

    slaTimerManager.cancel(chatId);
    sseBroker.broadcast("chat_released", { chat_id: chatId });

    writeJson(res, 200, { ok: true });
    return true;
  }

  if (presenceM && req.method === "POST") {
    const user = await requireAuth(req, res);
    if (!user) return true;
    const userId = user.userId != null ? Number(user.userId) : NaN;
    if (!Number.isFinite(userId) || userId <= 0) {
      writeJson(res, 401, {
        error: "UNAUTHORIZED",
        message: "Token inválido, expirado o no proporcionado.",
      });
      return true;
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (_e) {
      writeJson(res, 400, { error: "invalid_json" });
      return true;
    }

    const viewing = Boolean(body && body.viewing === true);
    const chatId = Number(presenceM[1]);

    let viewingUserName;
    try {
      viewingUserName = await loadUserDisplayName(userId);
    } catch (e) {
      viewingUserName = "Usuario";
    }

    sseBroker.broadcast("presence_update", {
      chat_id: chatId,
      viewing_user_id: userId,
      viewing_user_name: viewingUserName,
      viewing,
    });

    writeJson(res, 200, { ok: true });
    return true;
  }

  // ─── PATCH /api/inbox/chats/:id/discard (Bloque 4) ──────────────────────────
  // Marca el chat como ruido descartado. Nota obligatoria. No cambia status omnicanal.
  if (discardM && req.method === "PATCH") {
    const user = await requireAuth(req, res);
    if (!user) return true;
    const userId = user.userId != null ? Number(user.userId) : NaN;
    if (!Number.isFinite(userId) || userId <= 0) {
      writeJson(res, 401, { error: "UNAUTHORIZED" }); return true;
    }
    const chatId = Number(discardM[1]);

    let body;
    try { body = await parseJsonBody(req); } catch (_e) {
      writeJson(res, 400, { error: "invalid_json" }); return true;
    }
    const note =
      body && body.note != null && String(body.note).trim() !== ""
        ? String(body.note).trim().slice(0, 2000)
        : null;
    if (!note) {
      writeJson(res, 400, {
        error: "bad_request",
        message: "La nota de descarte es obligatoria. Explicar por qué es ruido.",
      });
      return true;
    }

    const { rows } = await pool.query(
      `SELECT id, discarded_at FROM crm_chats WHERE id = $1`, [chatId]
    );
    if (!rows.length) {
      writeJson(res, 404, { error: "NOT_FOUND", message: "Chat no encontrado." });
      return true;
    }
    if (rows[0].discarded_at != null) {
      writeJson(res, 409, {
        error: "ALREADY_DISCARDED",
        message: "El chat ya fue descartado.",
        discarded_at: rows[0].discarded_at,
      });
      return true;
    }

    await pool.query(
      `UPDATE crm_chats
       SET discarded_at = NOW(),
           discard_note = $1,
           discarded_by = $2,
           updated_at   = NOW()
       WHERE id = $3`,
      [note, userId, chatId]
    );

    sseBroker.broadcast("chat_discarded", { chat_id: chatId, discarded_by: userId });

    writeJson(res, 200, {
      ok: true,
      chat_id: chatId,
      discarded_at: new Date().toISOString(),
      note,
    });
    return true;
  }

  writeJson(res, 405, { error: "method_not_allowed" });
  return true;
}

module.exports = { handleInboxOmnichannelRequest };
