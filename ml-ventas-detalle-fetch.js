/**
 * GET HTML detalle de venta ML (.ve) con cookies Netscape por cuenta (equivalente curl -b archivo).
 * Guarda snapshot en ml_ventas_detalle_web si ML_WEBHOOK_FETCH_VENTAS_DETALLE=1.
 */
const fs = require("fs");
const { getMlAccountCookiesFilePath } = require("./ml-cookies-path");
const { buildCookieHeaderFromNetscapeFile } = require("./ml-netscape-cookies");
const { extractCelularFromVentasHtml } = require("./ml-ventas-detalle-celular");
const { insertMlVentasDetalleWeb } = require("./db");

const DEFAULT_BASE = "https://www.mercadolibre.com.ve/ventas/";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function maxBodyChars() {
  const n = Number(process.env.ML_VENTAS_DETALLE_MAX_BODY_CHARS || 6_000_000);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20_000_000) : 6_000_000;
}

/**
 * @param {{ mlUserId: number, orderId: number }} args
 */
async function fetchVentasDetalleAndStore(args) {
  const mlUserId = Number(args.mlUserId);
  const orderId = Number(args.orderId);
  if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
    return { ok: false, skip: "bad_ids" };
  }

  const cookiePath = getMlAccountCookiesFilePath(mlUserId);
  if (!cookiePath || !fs.existsSync(cookiePath)) {
    try {
      insertMlVentasDetalleWeb({
        ml_user_id: mlUserId,
        order_id: orderId,
        request_url: "(sin archivo cookies)",
        http_status: null,
        raw: null,
        celular: null,
        error: `no_cookie_file:${cookiePath || "null"}`,
      });
    } catch (e) {
      console.error("[ventas-detalle] log sin cookies:", e.message);
    }
    return { ok: false, skip: "no_cookie_file", path: cookiePath };
  }

  let cookieHeader;
  try {
    const raw = fs.readFileSync(cookiePath, "utf8");
    cookieHeader = buildCookieHeaderFromNetscapeFile(raw);
  } catch (e) {
    try {
      insertMlVentasDetalleWeb({
        ml_user_id: mlUserId,
        order_id: orderId,
        request_url: cookiePath,
        http_status: null,
        raw: null,
        celular: null,
        error: `cookie_read:${e.message || String(e)}`,
      });
    } catch (err2) {
      console.error("[ventas-detalle] log read error:", err2.message);
    }
    return { ok: false, skip: "cookie_read_error" };
  }

  if (!cookieHeader || !String(cookieHeader).trim()) {
    try {
      insertMlVentasDetalleWeb({
        ml_user_id: mlUserId,
        order_id: orderId,
        request_url: cookiePath,
        http_status: null,
        raw: null,
        celular: null,
        error: "cookie_header_vacio_mercadolibre",
      });
    } catch (e) {
      console.error("[ventas-detalle] log vacío:", e.message);
    }
    return { ok: false, skip: "empty_cookie_header" };
  }

  const base = (process.env.ML_VENTAS_DETALLE_BASE || DEFAULT_BASE).trim();
  const baseNorm = base.endsWith("/") ? base : `${base}/`;
  const url = `${baseNorm}${orderId}/detalle?`;

  let httpStatus = null;
  let bodyText = "";
  let errMsg = null;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Cookie: cookieHeader,
        "User-Agent": process.env.ML_VENTAS_DETALLE_UA || DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": process.env.ML_VENTAS_DETALLE_ACCEPT_LANG || "es-VE,es;q=0.9",
      },
    });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch (e) {
    errMsg = e.message || String(e);
  }

  const maxC = maxBodyChars();
  let bodyStore = bodyText;
  if (bodyStore.length > maxC) {
    bodyStore = bodyStore.slice(0, maxC);
    errMsg = (errMsg ? `${errMsg}; ` : "") + `body_truncado_a_${maxC}_chars`;
  }

  const celular = bodyStore ? extractCelularFromVentasHtml(bodyStore) : null;

  try {
    insertMlVentasDetalleWeb({
      ml_user_id: mlUserId,
      order_id: orderId,
      request_url: url,
      http_status: httpStatus,
      raw: errMsg && !bodyStore ? null : bodyStore,
      celular,
      error: errMsg,
    });
  } catch (e) {
    console.error("[ventas-detalle] insert DB:", e.message);
    return { ok: false, error: e.message };
  }

  console.log(
    "[ventas-detalle] guardado order_id=%s ml_user_id=%s http=%s bytes≈%s celular=%s",
    orderId,
    mlUserId,
    httpStatus,
    bodyStore ? bodyStore.length : 0,
    celular || "—"
  );
  return {
    ok: true,
    http_status: httpStatus,
    url,
    bytes: bodyStore.length,
    celular: celular || null,
  };
}

module.exports = { fetchVentasDetalleAndStore, DEFAULT_BASE };
