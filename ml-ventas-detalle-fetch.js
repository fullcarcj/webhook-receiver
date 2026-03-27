/**
 * GET HTML detalle de venta ML (.ve) con cookies Netscape por cuenta (equivalente curl -b archivo).
 * Guarda snapshot en ml_ventas_detalle_web si ML_WEBHOOK_FETCH_VENTAS_DETALLE=1.
 *
 * El `mlUserId` debe ser el **mismo** `user_id` del webhook (vendedor): las cookies en BD/archivo/env
 * deben corresponder a esa cuenta (`POST /admin/ml-web-cookies` con ese `ml_user_id`).
 */
const fs = require("fs");
const path = require("path");
const { getMlAccountCookiesFilePath } = require("./ml-cookies-path");
const { buildCookieHeaderFromNetscapeFile } = require("./ml-netscape-cookies");
const {
  extractCelularFromVentasHtml,
  extractNombreApellidoFromVentasHtml,
  computeVentasDetalleAnchorPositions,
} = require("./ml-ventas-detalle-celular");
const { insertMlVentasDetalleWeb, getMlAccountCookiesNetscape } = require("./db");
const { mergeNombreApellidoFromVentasDetalle } = require("./ml-buyer-order-sync");

const DEFAULT_BASE = "https://www.mercadolibre.com.ve/ventas/";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function maxBodyChars() {
  const n = Number(process.env.ML_VENTAS_DETALLE_MAX_BODY_CHARS || 6_000_000);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20_000_000) : 6_000_000;
}

/**
 * Volcado del HTML del GET (DOCTYPE + HTML; mismo cuerpo que `raw`).
 * Activa si ML_VENTAS_DETALLE_LOG_FILE=1 o si `force` (POST retry con write_log: true).
 * Siempre escribe `log.txt` en la carpeta del proyecto; si ML_VENTAS_DETALLE_LOG_PATH apunta a otro
 * archivo, duplica el contenido ahí (así no buscás el HTML en un .html distinto sin ver log.txt).
 * @param {{ url: string, orderId: number, mlUserId: number, httpStatus: number|null, bodyStore: string, errMsg: string|null, force?: boolean }} p
 * @returns {{ written: boolean, path: string|null }}
 */
function writeVentasDetalleGetLogFile(p) {
  const want = process.env.ML_VENTAS_DETALLE_LOG_FILE === "1" || p.force === true;
  if (!want) return { written: false, path: null };
  const defaultPath = path.join(__dirname, "log.txt");
  const customRaw = process.env.ML_VENTAS_DETALLE_LOG_PATH;
  const customPath =
    customRaw != null && String(customRaw).trim() !== ""
      ? path.resolve(String(customRaw).trim())
      : null;
  const head = [
    `# ventas detalle GET — ${new Date().toISOString()}`,
    `# url: ${p.url}`,
    `# order_id: ${p.orderId} ml_user_id: ${p.mlUserId}`,
    `# http_status: ${p.httpStatus ?? "—"} bytes: ${p.bodyStore ? p.bodyStore.length : 0}`,
    p.errMsg ? `# error: ${p.errMsg}` : "# error: —",
    "",
  ].join("\n");
  const body = p.bodyStore != null && String(p.bodyStore).length > 0 ? String(p.bodyStore) : "";
  const content = head + body;
  try {
    fs.writeFileSync(defaultPath, content, "utf8");
    const extra =
      customPath && path.resolve(customPath) !== path.resolve(defaultPath)
        ? (() => {
            fs.mkdirSync(path.dirname(customPath), { recursive: true });
            fs.writeFileSync(customPath, content, "utf8");
            return customPath;
          })()
        : null;
    console.log(
      "[ventas-detalle] GET volcado → %s (%s bytes cuerpo)%s",
      defaultPath,
      body.length,
      extra ? ` · copia: ${extra}` : ""
    );
    return { written: true, path: defaultPath };
  } catch (e) {
    console.error("[ventas-detalle] no se pudo escribir log GET:", e.message);
    return { written: false, path: null };
  }
}

/**
 * @param {{ mlUserId: number, orderId: number, buyerId?: number, writeLog?: boolean }} args
 * `buyerId` opcional: si viene, se intenta rellenar `ml_buyers.nombre_apellido` con el mismo criterio que el guion FileMaker sobre el HTML del GET.
 * `writeLog`: si true, escribe log.txt aunque no esté ML_VENTAS_DETALLE_LOG_FILE=1 (útil en POST /ventas-detalle-web/retry).
 */
async function fetchVentasDetalleAndStore(args) {
  const mlUserId = Number(args.mlUserId);
  const orderId = Number(args.orderId);
  const writeLogOnce = args.writeLog === true;
  const buyerId =
    args.buyerId != null && Number.isFinite(Number(args.buyerId)) && Number(args.buyerId) > 0
      ? Number(args.buyerId)
      : null;
  if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
    return { ok: false, skip: "bad_ids" };
  }

  let rawNetscape = null;
  let cookieRef = "(sin fuente cookies)";
  try {
    rawNetscape = await getMlAccountCookiesNetscape(mlUserId);
    if (rawNetscape != null && String(rawNetscape).trim() !== "") {
      cookieRef = "(cookies en base de datos)";
    }
  } catch (e) {
    console.error("[ventas-detalle] lectura cookies BD:", e.message);
  }

  if (rawNetscape == null || String(rawNetscape).trim() === "") {
    const cookiePath = getMlAccountCookiesFilePath(mlUserId);
    if (!cookiePath || !fs.existsSync(cookiePath)) {
      try {
        await insertMlVentasDetalleWeb({
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
    cookieRef = cookiePath;
    try {
      rawNetscape = fs.readFileSync(cookiePath, "utf8");
    } catch (e) {
      try {
        await insertMlVentasDetalleWeb({
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
  }

  let cookieHeader;
  try {
    cookieHeader = buildCookieHeaderFromNetscapeFile(rawNetscape);
  } catch (e) {
    try {
      await insertMlVentasDetalleWeb({
        ml_user_id: mlUserId,
        order_id: orderId,
        request_url: cookieRef,
        http_status: null,
        raw: null,
        celular: null,
        error: `cookie_parse:${e.message || String(e)}`,
      });
    } catch (err2) {
      console.error("[ventas-detalle] log parse error:", err2.message);
    }
    return { ok: false, skip: "cookie_parse_error" };
  }

  if (!cookieHeader || !String(cookieHeader).trim()) {
    try {
      await insertMlVentasDetalleWeb({
        ml_user_id: mlUserId,
        order_id: orderId,
        request_url: cookieRef,
        http_status: null,
        raw: null,
        celular: null,
        error: `cookie_header_vacio_mercadolibre; ml_user_id=${mlUserId} (cookies expiradas o sin dominio mercadolibre; reexportar sesión .ve para ese vendedor)`,
      });
    } catch (e) {
      console.error("[ventas-detalle] log vacío:", e.message);
    }
    console.error(
      "[ventas-detalle] cabecera Cookie vacía tras filtrar ML; ml_user_id=%s",
      mlUserId
    );
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
  const nombreApellidoRaw = bodyStore ? extractNombreApellidoFromVentasHtml(bodyStore) : null;
  const anchorPos = bodyStore ? computeVentasDetalleAnchorPositions(bodyStore) : null;

  const logOut = writeVentasDetalleGetLogFile({
    url,
    orderId,
    mlUserId,
    httpStatus,
    bodyStore: bodyStore || "",
    errMsg,
    force: writeLogOnce,
  });

  try {
    await insertMlVentasDetalleWeb({
      ml_user_id: mlUserId,
      order_id: orderId,
      request_url: url,
      http_status: httpStatus,
      raw: errMsg && !bodyStore ? null : bodyStore,
      celular,
      error: errMsg,
      pos_buyer_info_text: anchorPos ? anchorPos.pos_buyer_info_text : null,
      pos_label: anchorPos ? anchorPos.pos_label : null,
    });
  } catch (e) {
    console.error("[ventas-detalle] insert DB:", e.message);
    return { ok: false, error: e.message };
  }

  if (buyerId && nombreApellidoRaw) {
    try {
      await mergeNombreApellidoFromVentasDetalle(buyerId, nombreApellidoRaw);
    } catch (e) {
      console.error("[ventas-detalle] merge nombre_apellido buyer_id=%s: %s", buyerId, e.message);
    }
  }

  console.log(
    "[ventas-detalle] guardado order_id=%s ml_user_id=%s http=%s bytes≈%s celular=%s nombre_apellido=%s",
    orderId,
    mlUserId,
    httpStatus,
    bodyStore ? bodyStore.length : 0,
    celular || "—",
    nombreApellidoRaw || "—"
  );
  return {
    ok: true,
    http_status: httpStatus,
    url,
    bytes: bodyStore.length,
    celular: celular || null,
    nombre_apellido: nombreApellidoRaw || null,
    log_file: logOut.written ? logOut.path : null,
  };
}

module.exports = { fetchVentasDetalleAndStore, DEFAULT_BASE };
