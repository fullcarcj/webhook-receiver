"use strict";

/** @type {Map<number, Set<import('http').ServerResponse>>} */
const userSockets = new Map();

const HEARTBEAT_MS = 25000;

function setSseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

function writeEvent(res, eventName, payload) {
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
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

function broadcast(eventName, payload) {
  for (const set of userSockets.values()) {
    for (const res of set) {
      try {
        writeEvent(res, eventName, payload);
      } catch (_e) {
        /* ignore broken pipe */
      }
    }
  }
}

/**
 * @param {number} userId
 * @param {string} eventName
 * @param {object} payload
 */
function sendToUser(userId, eventName, payload) {
  const uid = Number(userId);
  const set = userSockets.get(uid);
  if (!set) return;
  for (const res of set) {
    try {
      writeEvent(res, eventName, payload);
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
