"use strict";

const crypto = require("crypto");
const { timingSafeCompare } = require("../services/currencyService");

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) {
    const pad = Buffer.alloc(32);
    crypto.timingSafeEqual(pad, pad);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Admin (X-Admin-Secret) o front (X-API-Key = FRONTEND_API_KEY).
 * @returns {{ ok: true, isAdmin: boolean } | { ok: false, status: number, body: object }}
 */
function authAdminOrFrontend(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  const frontendKey = process.env.FRONTEND_API_KEY;

  const providedAdmin = req.headers["x-admin-secret"];
  if (adminSecret && timingSafeCompare(providedAdmin, adminSecret)) {
    return { ok: true, isAdmin: true };
  }

  if (!frontendKey || String(frontendKey).trim() === "") {
    return {
      ok: false,
      status: 503,
      body: {
        error: "frontend_auth_unavailable",
        detail: "FRONTEND_API_KEY no configurada; usar X-Admin-Secret o definir FRONTEND_API_KEY",
      },
    };
  }

  const providedKey = req.headers["x-api-key"];
  if (providedKey != null && timingSafeEqualStr(providedKey, frontendKey)) {
    return { ok: true, isAdmin: false };
  }

  return { ok: false, status: 403, body: { error: "forbidden" } };
}

function authAdminOnly(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return { ok: false, status: 503, body: { error: "define ADMIN_SECRET en el servidor" } };
  }
  const provided = req.headers["x-admin-secret"];
  if (timingSafeCompare(provided, adminSecret)) {
    return { ok: true, isAdmin: true };
  }
  return { ok: false, status: 403, body: { error: "forbidden" } };
}

module.exports = {
  authAdminOrFrontend,
  authAdminOnly,
};
