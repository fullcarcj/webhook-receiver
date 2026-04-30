"use strict";

const { pool } = require("../../db");
const { traceMlQuestion } = require("../utils/mlQuestionTrace");

/** @type {Map<number, Set<import('http').ServerResponse>>} */
const userSockets = new Map();

const HEARTBEAT_MS = 25000;

function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

/**
 * Obtiene el siguiente valor de la sequence Postgres crm_events_seq.
 * Retorna el seq como string, o null si la DB falla (el evento se emite sin id:).
 * @returns {Promise<string|null>}
 */
async function getNextSeq() {
  try {
    const { rows } = await pool.query("SELECT nextval('crm_events_seq') AS seq");
    return String(rows[0].seq);
  } catch (err) {
    console.warn("[sseBroker] getNextSeq failed, emitting without id:", err.message);
    return null;
  }
}

/**
 * Escribe un frame SSE en una respuesta HTTP.
 * Si se proporciona seq, prepende la línea id: para habilitar gap detection en el cliente.
 * @param {import('http').ServerResponse} res
 * @param {string} eventName
 * @param {object} payload
 * @param {string|null} [seq]
 */
function writeEvent(res, eventName, payload, seq) {
  const idLine = seq != null ? `id: ${seq}\n` : "";
  const line = `${idLine}event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  res.write(line);
}

/**
 * @param {number} userId
 * @param {import('http').ServerResponse} res
 * @param {import('http').IncomingMessage} [req]
 */
function register(userId, res, req) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;

  setSseHeaders(res);
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let set = userSockets.get(uid);
  if (!set) {
    set = new Set();
    userSockets.set(uid, set);
  }
  set.add(res);

  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (_e) {
      unregister(uid, res);
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(hb);
    unregister(uid, res);
  };

  if (req) {
    req.on("close", cleanup);
    req.on("aborted", cleanup);
  }
  res.on("close", cleanup);
  res.on("error", cleanup);
}

/**
 * @param {number} userId
 * @param {import('http').ServerResponse} res
 */
function unregister(userId, res) {
  const uid = Number(userId);
  const set = userSockets.get(uid);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    userSockets.delete(uid);
  }
}

/**
 * Emite un evento a TODOS los usuarios conectados.
 * El nextval se obtiene UNA sola vez por evento lógico: todos los sockets
 * reciben el mismo id:, lo que permite dedup multi-pestaña en el cliente.
 * @param {string} eventName
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function broadcast(eventName, payload) {
  if (
    payload &&
    typeof payload === "object" &&
    payload.source_type === "ml_question" &&
    (eventName === "new_message" || eventName === "chat_reopened")
  ) {
    traceMlQuestion("sseBroker_broadcast", {
      event: eventName,
      chat_id: payload.chat_id != null ? Number(payload.chat_id) : null,
      source_type: payload.source_type,
      preview: payload.preview != null ? String(payload.preview) : "",
      sockets_user_count: userSockets.size,
    });
  }

  const seq = await getNextSeq();

  for (const set of userSockets.values()) {
    for (const res of set) {
      try {
        writeEvent(res, eventName, payload, seq);
      } catch (_e) {
        /* ignore broken pipe */
      }
    }
  }
}

/**
 * Emite un evento solo al usuario indicado.
 * El nextval se obtiene UNA sola vez: todas las pestañas del mismo usuario
 * reciben el mismo id:.
 * @param {number} userId
 * @param {string} eventName
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function sendToUser(userId, eventName, payload) {
  const uid = Number(userId);
  const set = userSockets.get(uid);
  if (!set) return;

  const seq = await getNextSeq();

  for (const res of set) {
    try {
      writeEvent(res, eventName, payload, seq);
    } catch (_e) {
      /* ignore */
    }
  }
}

module.exports = {
  register,
  unregister,
  broadcast,
  sendToUser,
};
