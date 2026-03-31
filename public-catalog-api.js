/**
 * API pública de catálogo (solo lectura) para el frontend Vite.
 * Requiere FRONTEND_API_KEY en cabecera X-API-KEY. No usa ADMIN_SECRET.
 * CORS restringido con FRONTEND_CORS_ORIGINS (incluye localhost:5173 por defecto).
 */

const { listProductosCatalogPublic } = require("./db");

function parseOrigins() {
  const raw = process.env.FRONTEND_CORS_ORIGINS;
  const fromEnv =
    raw != null && String(raw).trim() !== ""
      ? String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const defaults = ["http://localhost:5173"];
  return [...new Set([...defaults, ...fromEnv])];
}

function originAllowed(origin) {
  if (!origin) return true;
  return parseOrigins().some((o) => o === origin);
}

function applyCatalogCors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "X-API-KEY, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function validatePublicAccess(req) {
  const expected = process.env.FRONTEND_API_KEY;
  if (!expected || String(expected).trim() === "") {
    return {
      ok: false,
      status: 503,
      json: { ok: false, error: "catalog_unavailable", detail: "FRONTEND_API_KEY no configurada" },
    };
  }
  const provided = req.headers["x-api-key"];
  if (provided == null || String(provided).trim() !== String(expected).trim()) {
    return { ok: false, status: 403, json: { ok: false, error: "forbidden" } };
  }
  return { ok: true };
}

function isPublicCatalogPath(pathname) {
  return pathname === "/api/v1/catalog" || pathname === "/api/v1/catalog/";
}

/**
 * @returns {Promise<boolean>} true si la petición fue manejada (catálogo o OPTIONS)
 */
async function handlePublicCatalogRequest(req, res, url) {
  if (!isPublicCatalogPath(url.pathname)) return false;

  applyCatalogCors(req, res);

  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "origin_not_allowed" }));
    return true;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    return true;
  }

  const auth = validatePublicAccess(req);
  if (!auth.ok) {
    res.writeHead(auth.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(auth.json));
    return true;
  }

  const search = url.searchParams.get("search") || "";
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  try {
    const result = await listProductosCatalogPublic({ search, limit, offset });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        items: result.items,
      })
    );
  } catch (e) {
    console.error("[catalog public]", e);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "internal_error" }));
  }
  return true;
}

module.exports = {
  handlePublicCatalogRequest,
  isPublicCatalogPath,
  validatePublicAccess,
  originAllowed,
};
