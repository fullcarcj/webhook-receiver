"use strict";

const { timingSafeCompare } = require("../services/currencyService");
const { getPublicStatus, NEXT_STEPS_ES } = require("../config/banesco");
const { getBanescoConnectionSnapshot } = require("../services/banescoStatus");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ensureAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    writeJson(res, 503, { ok: false, error: "define ADMIN_SECRET en el servidor" });
    return false;
  }
  const provided = req.headers["x-admin-secret"];
  if (!timingSafeCompare(provided, secret)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

function ensureAdminHtml(req, res, url) {
  const secret = process.env.ADMIN_SECRET;
  const k = url.searchParams.get("k") || url.searchParams.get("secret");
  if (!secret) {
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!DOCTYPE html><meta charset=\"utf-8\"><title>Banesco</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
    );
    return false;
  }
  if (k !== secret) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!DOCTYPE html><meta charset=\"utf-8\"><title>Banesco</title><p>Acceso denegado. Usá <code>/banesco?k=TU_ADMIN_SECRET</code>.</p>"
    );
    return false;
  }
  return true;
}

/**
 * Página HTML en la raíz del sitio: /banesco?k=ADMIN_SECRET
 */
async function handleBanescoHtmlPage(req, res, url) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return true;
  }

  if (!ensureAdminHtml(req, res, url)) {
    return true;
  }

  if (url.searchParams.get("format") === "json") {
    const snap = await getBanescoConnectionSnapshot();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(snap));
    return true;
  }

  let snap;
  try {
    snap = await getBanescoConnectionSnapshot();
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
    return true;
  }

  const ok = snap.ok === true && snap.connected === true;
  const badge = ok
    ? `<span class="ok">Conectado</span>`
    : `<span class="bad">No conectado</span>`;
  const stateLabel = escapeHtml(snap.state || "unknown");
  const last = snap.last_cycle;
  const lastLine = last
    ? `${last.ok ? "OK" : "Error"} · ${escapeHtml(last.at || "")}${
        last.error ? ` · ${escapeHtml(last.error)}` : ""
      }${last.inserted != null ? ` · insertados:${last.inserted}` : ""}`
    : "Aún sin ciclo desde el arranque del proceso";

  const sessionHtml =
    snap.ok && snap.session
      ? `
    <p><strong>Sesión en BD:</strong> ${snap.session.present ? "sí" : "no"}
    ${snap.session.saved_at ? ` · guardada: ${escapeHtml(String(snap.session.saved_at))}` : ""}
    ${snap.session.age_hours != null ? ` · antigüedad: ${snap.session.age_hours.toFixed(2)} h` : ""}
    · válida: ${snap.session.valid ? "sí" : "no"} (máx. ${snap.session_max_hours ?? 8} h)</p>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Banesco — estado</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; padding: 1.5rem; max-width: 42rem; margin: 0 auto; line-height: 1.45; }
    h1 { font-size: 1.25rem; }
    .ok { background: #14532d; color: #dcfce7; padding: .2rem .5rem; border-radius: 6px; }
    .bad { background: #7f1d1d; color: #fecaca; padding: .2rem .5rem; border-radius: 6px; }
    .muted { color: #64748b; font-size: .9rem; }
    code { background: #f1f5f9; padding: .1rem .4rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Banesco — conexión</h1>
  <p>${badge} <span class="muted">(estado: <code>${stateLabel}</code>)</span></p>
  ${snap.ok === false ? `<p class="muted">Error: ${escapeHtml(snap.message || snap.error || "")}</p>` : ""}
  ${sessionHtml}
  <p><strong>Monitor:</strong> ${snap.monitor_enabled ? "activado" : "desactivado"} · <strong>Credenciales:</strong> ${
    snap.credentials_configured ? "configuradas" : "faltan"
  }</p>
  <p><strong>Último ciclo:</strong> ${escapeHtml(lastLine)}</p>
  <p class="muted">JSON: <code>GET /api/bank/banesco/connection</code> con cabecera <code>X-Admin-Secret</code>, o esta misma URL con <code>?format=json&amp;k=…</code></p>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

/**
 * Rutas bajo /api/bank/banesco — diagnóstico y estado de conexión.
 */
function isBanescoRootPath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/banesco" || p === "/banesco-status";
}

async function handleBankBanescoRequest(req, res, url) {
  if (req.method === "GET" && isBanescoRootPath(url.pathname)) {
    return handleBanescoHtmlPage(req, res, url);
  }

  if (!url.pathname.startsWith("/api/bank/banesco")) return false;

  try {
    if (req.method === "GET" && url.pathname === "/api/bank/banesco/connection") {
      if (!ensureAdmin(req, res)) return true;
      const snap = await getBanescoConnectionSnapshot();
      writeJson(res, 200, { ok: true, ...snap });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/bank/banesco/status") {
      if (!ensureAdmin(req, res)) return true;
      const status = getPublicStatus();
      const configured =
        status.statement_csv_dir_configured || (status.has_api_user && status.has_api_password);
      writeJson(res, 200, {
        ok: true,
        bank: "Banesco",
        configured,
        available_endpoints: [
          "GET /api/bank/banesco/status",
          "GET /api/bank/banesco/connection",
          "GET /banesco?k=ADMIN_SECRET",
        ],
        status,
        next_steps_es: NEXT_STEPS_ES,
        note:
          "GET /api/bank/banesco/connection y GET /banesco?k=… muestran si hay sesión válida en BD y el último ciclo del monitor. " +
          "No hay POST al banco desde estos endpoints.",
      });
      return true;
    }

    writeJson(res, 404, { ok: false, error: "not_found" });
    return true;
  } catch (e) {
    console.error("[bank banesco]", e);
    writeJson(res, 500, { ok: false, error: e.message || String(e) });
    return true;
  }
}

module.exports = { handleBankBanescoRequest };
