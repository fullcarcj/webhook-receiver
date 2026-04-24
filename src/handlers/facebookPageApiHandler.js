"use strict";

/**
 * API de gestión de la página Facebook desde el ERP.
 *
 * Rutas (auth: requireAdminOrPermission 'settings' o 'inbox'):
 *   GET /api/facebook/status   — info de la página + estado de conexión
 *   GET /api/facebook/stats    — estadísticas de crm_chats source_type='fb_page'
 *   GET /api/facebook/posts    — publicaciones recientes de la Fan Page
 */

const pino = require("pino");
const { applyCrmApiCorsHeaders } = require("../middleware/crmApiCors");
const { requireAdminOrPermission } = require("../utils/authMiddleware");
const { pool } = require("../../db");
const { graphGet } = require("../services/fbPageClient");

const logger = pino({ level: process.env.LOG_LEVEL || "info", name: "fb_page_api" });

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Llama a la Graph API y devuelve { ok, data, error? }.
 * No lanza excepciones: errores de red quedan en `error`.
 */
async function safeGraphGet(path) {
  const hasToken = Boolean(process.env.FB_PAGE_ACCESS_TOKEN);
  if (!hasToken) {
    return { ok: false, data: null, error: "FB_PAGE_ACCESS_TOKEN no configurado" };
  }
  try {
    const result = await graphGet(path);
    if (!result.ok) {
      const msg = result.data?.error?.message || `HTTP ${result.status}`;
      return { ok: false, data: result.data, error: msg };
    }
    return { ok: true, data: result.data };
  } catch (e) {
    return { ok: false, data: null, error: e.message };
  }
}

// ── Handlers por ruta ──────────────────────────────────────────────────────

/**
 * GET /api/facebook/status
 * Verifica el token y obtiene el perfil de la página.
 */
async function handleStatus(res) {
  const hasToken = Boolean(process.env.FB_PAGE_ACCESS_TOKEN);
  const pageId = process.env.FB_PAGE_ID || null;

  const result = await safeGraphGet("/me?fields=id,name,fan_count,picture,about,category,link,verification_status");

  // Contar chats activos en la BD
  let dbStats = { total_chats: 0, unread_chats: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                                   AS total_chats,
         COUNT(*) FILTER (WHERE unread_count > 0)                  AS unread_chats
       FROM crm_chats
       WHERE source_type = 'fb_page'`
    );
    if (rows.length) {
      dbStats.total_chats = Number(rows[0].total_chats);
      dbStats.unread_chats = Number(rows[0].unread_chats);
    }
  } catch (_) {}

  writeJson(res, 200, {
    connected: result.ok,
    token_configured: hasToken,
    page_id_env: pageId,
    page: result.ok ? result.data : null,
    error: result.error ?? null,
    crm: dbStats,
    webhook_url_hint: "/webhook/facebook",
    verify_token_configured: Boolean(process.env.FB_WEBHOOK_VERIFY_TOKEN),
    app_secret_configured: Boolean(process.env.FB_APP_SECRET),
  });
}

/**
 * GET /api/facebook/stats?days=7
 * Estadísticas de conversaciones FB en crm_chats / crm_messages.
 */
async function handleStats(req, res, url) {
  const days = Math.min(Math.max(Number(url.searchParams.get("days") || "7"), 1), 90);

  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(DISTINCT cc.id)                                          AS total_chats,
         COUNT(DISTINCT cc.id) FILTER (WHERE cc.unread_count > 0)      AS unread_chats,
         COUNT(DISTINCT cc.id) FILTER (WHERE cc.status = 'ATTENDED')   AS attended_chats,
         COUNT(DISTINCT cc.id) FILTER (WHERE cc.status = 'RE_OPENED')  AS reopened_chats,
         COUNT(cm.id)                                                   AS total_messages,
         COUNT(cm.id) FILTER (WHERE cm.direction = 'inbound')          AS inbound_messages,
         COUNT(cm.id) FILTER (WHERE cm.direction = 'outbound')         AS outbound_messages,
         COUNT(DISTINCT cc.id) FILTER (
           WHERE cc.created_at >= NOW() - ($1 || ' days')::interval
         )                                                              AS new_chats_period,
         COUNT(cm.id) FILTER (
           WHERE cm.created_at >= NOW() - ($1 || ' days')::interval
         )                                                              AS messages_period
       FROM crm_chats cc
       LEFT JOIN crm_messages cm ON cm.chat_id = cc.id
       WHERE cc.source_type = 'fb_page'`,
      [days]
    );

    const row = rows[0] || {};
    const inbound = Number(row.inbound_messages || 0);
    const outbound = Number(row.outbound_messages || 0);
    const total = inbound + outbound;
    const responseRate = total > 0 ? Math.round((outbound / total) * 100) : null;

    writeJson(res, 200, {
      period_days: days,
      total_chats: Number(row.total_chats || 0),
      unread_chats: Number(row.unread_chats || 0),
      attended_chats: Number(row.attended_chats || 0),
      reopened_chats: Number(row.reopened_chats || 0),
      total_messages: total,
      inbound_messages: inbound,
      outbound_messages: outbound,
      response_rate_pct: responseRate,
      new_chats_period: Number(row.new_chats_period || 0),
      messages_period: Number(row.messages_period || 0),
    });
  } catch (e) {
    logger.error({ err: e }, "[fb_api] error en stats");
    writeJson(res, 500, { error: "Error al obtener estadísticas" });
  }
}

/**
 * GET /api/facebook/posts?limit=10
 * Publicaciones recientes de la Fan Page (Graph API).
 */
async function handlePosts(req, res, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "10"), 1), 25);
  const pageId = process.env.FB_PAGE_ID || "me";

  const result = await safeGraphGet(
    `/${pageId}/posts?fields=id,message,story,created_time,permalink_url,full_picture,likes.summary(true),comments.summary(true),shares&limit=${limit}`
  );

  if (!result.ok) {
    writeJson(res, 200, { posts: [], error: result.error, connected: false });
    return;
  }

  const posts = (result.data?.data || []).map((p) => ({
    id: p.id,
    message: p.message || p.story || null,
    created_time: p.created_time,
    permalink_url: p.permalink_url || null,
    picture: p.full_picture || null,
    likes: p.likes?.summary?.total_count ?? 0,
    comments: p.comments?.summary?.total_count ?? 0,
    shares: p.shares?.count ?? 0,
  }));

  writeJson(res, 200, { posts, connected: true, paging: result.data?.paging ?? null });
}

// ── Router ─────────────────────────────────────────────────────────────────

const ROUTES = {
  "/api/facebook/status": handleStatus,
  "/api/facebook/stats": handleStats,
  "/api/facebook/posts": handlePosts,
};

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleFacebookPageApiRequest(req, res, url) {
  applyCrmApiCorsHeaders(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }

  const pathname = String(url.pathname || "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";

  const handler = ROUTES[pathname];
  if (!handler) return false;

  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "usa GET" });
    return true;
  }

  if (await requireAdminOrPermission(req, res, "settings")) return true;

  await handler(req, res, url);
  return true;
}

module.exports = { handleFacebookPageApiRequest };
