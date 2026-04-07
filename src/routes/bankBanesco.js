"use strict";

const { timingSafeCompare } = require("../services/currencyService");
const { getPublicStatus, NEXT_STEPS_ES } = require("../config/banesco");

function writeJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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

/**
 * Rutas bajo /api/bank/banesco — diagnóstico de configuración (sin llamadas al banco).
 * El estado de cuenta operativo suele obtenerse por CSV desde el portal, no por API aquí.
 */
async function handleBankBanescoRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/bank/banesco")) return false;

  try {
    if (req.method === "GET" && url.pathname === "/api/bank/banesco/status") {
      if (!ensureAdmin(req, res)) return true;
      const status = getPublicStatus();
      const configured =
        status.statement_csv_dir_configured || (status.has_api_user && status.has_api_password);
      writeJson(res, 200, {
        ok: true,
        bank: "Banesco",
        configured,
        available_endpoints: ["GET /api/bank/banesco/status"],
        status,
        next_steps_es: NEXT_STEPS_ES,
        note:
          "Este endpoint no conecta con Banesco. La ruta habitual del estado de cuenta es " +
          "descarga CSV desde la banca en línea; BANESCO_STATEMENT_CSV_DIR es la carpeta destino " +
          "para un futuro import. Credenciales API son opcionales si existiera otro canal. " +
          "No hay POST de descarga ni listado de CSV aún.",
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
