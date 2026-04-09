"use strict";

/**
 * Handler SSE — GET /api/events
 *
 * Headers críticos para producción en Render (Nginx):
 *   X-Accel-Buffering: no  → desactiva buffering de Nginx. Sin esto los eventos
 *                            se acumulan y llegan todos juntos en lugar de en tiempo real.
 *                            Funciona perfecto en local pero roto en producción sin este header.
 *
 * Auth vía query param (?token=ADMIN_SECRET):
 *   EventSource del browser NO soporta headers custom — es la única API web con esa limitación.
 *   Token en URL sobre HTTPS es seguro (mismo patrón que ?k= ya usado en este repo).
 *
 * Heartbeat cada 25s:
 *   Render y la mayoría de proxies/load balancers cortan conexiones TCP inactivas a los 30s.
 *   El comentario SSE `: heartbeat\n\n` mantiene el TCP vivo sin disparar eventos en el cliente.
 */

const pino = require("pino");
const log  = pino({ level: process.env.LOG_LEVEL || "info", name: "sse_handler" });

const { addClient, removeClient, getStats } = require("../services/sseService");

const HEARTBEAT_MS = 25_000;

/**
 * GET /api/events — conexión SSE persistente
 * @returns {Promise<boolean>}
 */
async function handleSseApiRequest(req, res, url) {
  if (url.pathname !== "/api/events") return false;

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return true;
  }

  // Auth: query param ?token= (EventSource no admite headers custom)
  const token  = url.searchParams.get("token") || "";
  const userId = url.searchParams.get("user")  || "agent";
  const secret = process.env.ADMIN_SECRET       || "";

  if (!secret || token !== secret) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    return true;
  }

  // Headers SSE obligatorios
  res.writeHead(200, {
    "Content-Type":                "text/event-stream",
    "Cache-Control":               "no-cache, no-transform",
    "Connection":                  "keep-alive",
    "X-Accel-Buffering":           "no",
    "Access-Control-Allow-Origin": process.env.FRONTEND_ORIGIN || "*",
    "Access-Control-Allow-Headers": "X-Admin-Secret, Content-Type",
  });

  // Reconexión automática — si la conexión cae el EventSource reconecta en 3s
  res.write("retry: 3000\n\n");

  // Evento de bienvenida
  const welcome = JSON.stringify({
    message:   "Conectado al stream de eventos Solomotor3k",
    userId,
    timestamp: new Date().toISOString(),
  });
  res.write(`event: connected\ndata: ${welcome}\n\n`);

  const client = addClient(res, userId);
  log.info({ userId }, "sse: nueva conexión establecida");

  // Heartbeat — mantiene la conexión viva en Render
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch (_) {
      clearInterval(heartbeat);
      removeClient(client);
    }
  }, HEARTBEAT_MS);

  // Limpieza al desconectarse (cierre normal)
  req.on("close", () => {
    clearInterval(heartbeat);
    removeClient(client);
  });

  // Limpieza por error de red
  req.on("error", (err) => {
    log.warn({ err: err.message, userId }, "sse: error en conexión");
    clearInterval(heartbeat);
    removeClient(client);
  });

  // No llamar res.end() — la respuesta queda abierta indefinidamente
  return true;
}

/**
 * GET /api/events/stats — estadísticas de clientes SSE conectados
 * Auth por header X-Admin-Secret (este endpoint sí acepta headers — no es EventSource)
 * @returns {Promise<boolean>}
 */
async function handleSseStatsRequest(req, res, url) {
  if (url.pathname !== "/api/events/stats") return false;

  const secret       = process.env.ADMIN_SECRET || "";
  const headerSecret = req.headers["x-admin-secret"] || "";
  const qk           = url.searchParams.get("k") || url.searchParams.get("secret") || "";

  if (!secret || (headerSecret !== secret && qk !== secret)) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    return true;
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    ok:   true,
    data: getStats(),
    meta: { timestamp: new Date().toISOString() },
  }));
  return true;
}

module.exports = { handleSseApiRequest, handleSseStatsRequest };
