require("./load-env-local");
const path = require("path");
const { ensureMlCookiesDir } = require("./ml-cookies-path");
const { writeCookiesFromEnv } = require("./ml-cookies-from-env");
ensureMlCookiesDir();
(() => {
  const { written } = writeCookiesFromEnv();
  if (written.length) {
    console.log("[cookies] escritas desde ML_COOKIE_NETSCAPE_* (env): %s", written.join(", "));
  }
})();
if (process.env.ML_VENTAS_DETALLE_LOG_FILE === "1" || process.env.ML_VENTAS_DETALLE_LOG_FILE === "true") {
  const def = path.join(__dirname, "log.txt");
  const extra = process.env.ML_VENTAS_DETALLE_LOG_PATH;
  console.log(
    "[config] GET detalle ventas (.ve): volcado HTML en %s%s",
    path.resolve(def),
    extra && String(extra).trim() !== ""
      ? ` (copia opcional si distinto: ${path.resolve(String(extra).trim())})`
      : ""
  );
}
const http = require("http");
const pkg = require("./package.json");
const { extractSkuTitleFromMlResponse } = require("./ml-payload-extract");
const {
  extractOrderIdFromOrder,
  extractOrderIdFromResource,
  extractOrderIdFromFeedbackPayload,
  extractOrderIdFromMessage,
} = require("./ml-pack-extract");
const { syncPackMessagesForOrder, persistPackMessageFromWebhookFetch } = require("./ml-pack-messages-sync");
const { upsertOrderFeedbackFromApiResponse } = require("./ml-order-feedback-sync");
const { extractBuyerFromOrderPayload } = require("./ml-buyer-extract");
const { upsertBuyerFromOrdersV2Webhook } = require("./ml-buyer-order-sync");
const { orderRowFromMlApi } = require("./ml-order-map");
const {
  normalizeBuyerPrefEntrega,
  BUYER_PREF_ENTREGA_VALUES,
  normalizeCambioDatos,
  normalizeNombreApellido,
  normalizeBuyerObservaciones,
} = require("./ml-buyer-pref");
const { fetchVentasDetalleAndStore } = require("./ml-ventas-detalle-fetch");
const {
  buildQuestionPendingRow,
  buildQuestionAnsweredRow,
  enrichAnsweredRowFromPendingSnapshot,
  extractQuestionIdFromResource,
  isQuestionUnansweredStatus,
  isQuestionAnsweredOrClosedStatus,
} = require("./ml-question-sync");
const { refreshMlQuestionFromApi, syncAllPendingQuestionsFromApi } = require("./ml-question-refresh");
const {
  tryQuestionIaAutoAnswer,
  retryPendingQuestionsIaAuto,
  getQuestionsIaAutoDiagnostics,
  getQuestionsIaAutoWindowEvaluation,
  getQuestionsIaAutoWindowArithmeticBreakdown,
  serializeIaAutoPendingRouteDetail,
  startQuestionsIaAutoPoll,
} = require("./ml-questions-ia-auto");
const { enrichNicknameForFetches } = require("./ml-nickname-enrich");
const { renderPostSaleMessagesPage } = require("./post-sale-messages-html");
const { renderWhatsappTipoEPage } = require("./whatsapp-tipo-e-html");
const { renderWhatsappTipoFPage } = require("./whatsapp-tipo-f-html");
const { trySendDefaultPostSaleMessage } = require("./ml-post-sale-send");
const {
  maybeProcessInternalOrderMessageForTipoE,
  processOrderMessagePhoneForTipoE,
  extractFirstMobile04,
} = require("./ml-whatsapp-internal-order-message");
const { trySendWhatsappTipoFForQuestion } = require("./ml-whatsapp-tipo-ef");
const { processFilemakerTipoGPost } = require("./ml-filemaker-tipo-g");
const { processFilemakerInventarioProductosPost } = require("./ml-filemaker-inventario-productos");
const { normalizePhoneToE164 } = require("./ml-whatsapp-phone");
const { appendWasenderWebhookNdjsonLine } = require("./wasender-webhook-log");
const { wasenderWebhookSignatureOk } = require("./wasender-webhook-signature");
const {
  getAccessToken,
  getAccessTokenForMlUser,
  mercadoLibreGetForUser,
  mercadoLibreFetchForUser,
  normalizeMlResourcePath,
  warmAllMlAccountsRefresh,
  getTokenStatus,
  getTokenStatusForMlUser,
  exchangeAuthorizationCode,
} = require("./oauth-token");
const { listingRowFromMlItemApi } = require("./ml-listing-map");
const { ML_ORDER_STATUSES_KNOWN } = require("./ml-order-statuses");
const {
  insertWebhook,
  listWebhooks,
  deleteWebhooks,
  insertWasenderWebhookEvent,
  listWasenderWebhookEvents,
  upsertMlAccount,
  listMlAccounts,
  setMlAccountCookiesNetscape,
  clearMlAccountCookiesNetscape,
  deleteMlAccount,
  insertTopicFetch,
  updateTopicFetch,
  listTopicFetches,
  FETCH_PROCESS_STATUS_PENDING,
  FETCH_PROCESS_STATUS_DONE,
  FETCH_PROCESS_STATUS_POST_SALE_FAILED,
  listDistinctFetchTopics,
  deleteAllTopicFetches,
  upsertMlBuyer,
  getMlBuyer,
  countMlBuyers,
  listMlBuyers,
  updateMlBuyerPhones,
  listPostSaleMessages,
  insertPostSaleMessage,
  updatePostSaleMessage,
  deletePostSaleMessage,
  listPostSaleAutoSendLog,
  listMlMessageKindSendLog,
  listMlVentasDetalleWeb,
  deleteAllMlVentasDetalleWeb,
  getMlAccount,
  deletePostSaleSent,
  upsertMlQuestionPending,
  getMlQuestionPendingByQuestionId,
  deleteMlQuestionPending,
  upsertMlQuestionAnswered,
  listMlQuestionsPending,
  listMlQuestionsAnswered,
  listMlQuestionsIaAutoLog,
  listMlListingsAll,
  listMlListingsByUser,
  listMlListingSyncStatesAll,
  listMlListingCountsByUser,
  upsertMlListing,
  insertMlListingWebhookLog,
  listMlListingWebhookLog,
  ML_LISTING_CHANGE_ACK_ACTIONS,
  insertMlListingChangeAck,
  listMlListingChangeAck,
  listMlOrdersByUser,
  listMlOrdersAll,
  upsertMlOrder,
  listMlOrdersByUserAndOrderIds,
  listMlBuyersByIds,
  listMlOrderCountsByUserStatus,
  listMlOrderCountsByUser,
  listMlOrderPackMessagesByUser,
  listMlOrderPackMessageCountsByUser,
  countMlOrderPackMessagesTotal,
  countMlOrderPackMessagesForMlUser,
  countMlOrderPackMessagesForOrder,
  listMlRatingRequestLog,
  getMlWhatsappTipoEConfig,
  upsertMlWhatsappTipoEConfig,
  getMlWhatsappTipoFConfig,
  upsertMlWhatsappTipoFConfig,
  listMlWhatsappWasenderLog,
  listMlWhatsappWasenderLogByUserAndOrderIds,
  listFilemakerTipoGLog,
  insertProducto,
  upsertProductoBySku,
  getProductoById,
  getProductoBySku,
  listProductos,
  countProductos,
  updateProducto,
  deleteProducto,
  dbPath,
} = require("./db");
const { enrichProductoConImagenesUrls, buildProductoImagenesUrls } = require("./producto-imagenes-urls");
const { handlePublicFrontendRequest } = require("./public-frontend-api");
const { handleCurrencyApiRequest } = require("./src/routes/currency");
const { handleShippingApiRequest } = require("./src/routes/shipping");
const { handleWmsApiRequest } = require("./src/routes/wms");
const { handleWalletApiRequest } = require("./src/routes/wallet");
const { handleCrmApiPreflight } = require("./src/middleware/crmApiCors");
const { handleVehicleApiRequest } = require("./src/handlers/vehicleApiHandler");
const { handlePurchaseApiRequest } = require("./src/handlers/purchaseApiHandler");
const { handleSalesApiRequest } = require("./src/handlers/salesApiHandler");
const { handleCustomerHistoryRequest } = require("./src/handlers/customerHistory");
const { handleCustomerLoyaltyRoutes, handleCrmLoyaltyEarnRequest } = require("./src/handlers/customerLoyalty");
const { handleCustomersApiRequest } = require("./src/routes/customers");
const { handleCrmApiRequest } = require("./src/routes/crm");
const { handleBankBanescoRequest } = require("./src/routes/bankBanesco");
const { handleBankStatementsRequest } = require("./src/routes/bankStatements");
const { startBanescoMonitor } = require("./src/jobs/banescoMonitor");
const { rejectDuringDowntime, isInDowntime, msUntilSystemUp } = require("./src/utils/sessionGuard");
const {
  reserveForOrder,
  commitReservation,
  releaseReservation,
  mapOrderItemsForWms,
} = require("./src/services/reservationService");
const { timingSafeCompare } = require("./src/services/currencyService");

const PORT = process.env.PORT || 3001;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";
/** POST Wasender API: eventos de sesión WhatsApp (independiente de {@link WEBHOOK_PATH} de Mercado Libre). */
const WASENDER_WEBHOOK_PATH = process.env.WASENDER_WEBHOOK_PATH || "/wasender-webhook";
/**
 * Rutas POST adicionales para el mismo handler Wasender (coma-separadas).
 * Vacío explícito = solo la ruta principal. Si la variable no existe, se añade el alias típico de docs.
 */
function getWasenderWebhookPostPaths() {
  const set = new Set();
  set.add(WASENDER_WEBHOOK_PATH);
  const extra = process.env.WASENDER_WEBHOOK_ALIASES;
  const raw =
    extra !== undefined ? String(extra) : "/api/wasender/webhook";
  if (raw.trim() === "" || raw.trim() === "-") return set;
  for (const p of raw.split(",")) {
    const t = p.trim();
    if (t) set.add(t);
  }
  return set;
}

function matchesWasenderWebhookPostPath(pathname) {
  return pathname != null && getWasenderWebhookPostPaths().has(pathname);
}

const REG_PATH = process.env.REG_PATH || "/reg";
/** GET al resource del webhook y guarda respuesta en tabla ml_topic_fetches (requiere cuenta en ml_accounts). */
const ML_WEBHOOK_FETCH_RESOURCE = process.env.ML_WEBHOOK_FETCH_RESOURCE === "1";
/** Tras GET orden OK: GET HTML ventas/.../detalle con cookies (.txt) y guarda en ml_ventas_detalle_web. */
const ML_WEBHOOK_FETCH_VENTAS_DETALLE = process.env.ML_WEBHOOK_FETCH_VENTAS_DETALLE === "1";

function matchesRegPath(pathname) {
  if (pathname === REG_PATH) return true;
  if (pathname === "/reg.php") return true;
  return false;
}

function isCuentasPath(pathname) {
  return pathname === "/cuentas" || pathname === "/cuentas/";
}

function isHooksPath(pathname) {
  return pathname === "/hooks" || pathname === "/hooks/";
}

function isWasenderWebhooksPath(pathname) {
  return pathname === "/wasender-webhooks" || pathname === "/wasender-webhooks/";
}

function isFetchesPath(pathname) {
  return pathname === "/fetches" || pathname === "/fetches/";
}

function isBuyersPath(pathname) {
  return pathname === "/buyers" || pathname === "/buyers/";
}

/** Inventario local `productos` (repuestos; JSONB atributos + vínculo opcional item_id_ml ML). */
function isInventarioProductosPath(pathname) {
  return pathname === "/inventario-productos" || pathname === "/inventario-productos/";
}

function isPostSaleMessagesPath(pathname) {
  return pathname === "/mensajes-postventa" || pathname === "/mensajes-postventa/";
}

function isWhatsappTipoEConfigPath(pathname) {
  return pathname === "/mensajes-tipo-e-whatsapp" || pathname === "/mensajes-tipo-e-whatsapp/";
}

function isWhatsappTipoFConfigPath(pathname) {
  return pathname === "/mensajes-tipo-f-whatsapp" || pathname === "/mensajes-tipo-f-whatsapp/";
}

function isPostSaleEnviosPath(pathname) {
  return pathname === "/envios-postventa" || pathname === "/envios-postventa/";
}

function isRecordatoriosCalificacionPath(pathname) {
  return (
    pathname === "/recordatorios-calificacion" ||
    pathname === "/recordatorios-calificacion/" ||
    pathname === "/recordatorios" ||
    pathname === "/recordatorios/"
  );
}

/** Log unificado mensajes tipo A/B/C (tabla ml_message_kind_send_log). */
function isEnviosTiposAbcPath(pathname) {
  return pathname === "/envios-tipos-abc" || pathname === "/envios-tipos-abc/";
}

/** Log envíos Wasender tipo E / F (`ml_whatsapp_wasender_log`). */
function isEnviosWhatsappTipoEPath(pathname) {
  return pathname === "/envios-whatsapp-tipo-e" || pathname === "/envios-whatsapp-tipo-e/";
}

/** POST FileMaker: actualizar buyer + encadenar tipo E (`ml-filemaker-tipo-g.js`). */
function isFilemakerTipoGPostPath(pathname) {
  return pathname === "/filemaker/tipo-g" || pathname === "/filemaker/tipo-g/";
}

/** Tipo G: GET log (`ml_filemaker_tipo_g_log`, ?k=ADMIN_SECRET) · POST mismo cuerpo que `/filemaker/tipo-g` (FILEMAKER_TIPO_G_SECRET). */
function isMensajesTipoGPath(pathname) {
  return pathname === "/mensajes-tipo-g" || pathname === "/mensajes-tipo-g/";
}

/** POST FileMaker: upsert producto en `productos` (`ml-filemaker-inventario-productos.js`). */
function isFilemakerInventarioProductosPostPath(pathname) {
  return pathname === "/filemaker/inventario-productos" || pathname === "/filemaker/inventario-productos/";
}

/** Alias POST: mismo JSON y `FILEMAKER_INVENTARIO_PRODUCTOS_SECRET` (como `/mensajes-tipo-g`). */
function isMensajesInventarioProductosPath(pathname) {
  return pathname === "/mensajes-inventario-productos" || pathname === "/mensajes-inventario-productos/";
}

function isVentasDetalleWebPath(pathname) {
  return pathname === "/ventas-detalle-web" || pathname === "/ventas-detalle-web/";
}

function isPreguntasMlPath(pathname) {
  return pathname === "/preguntas-ml" || pathname === "/preguntas-ml/";
}

function isPreguntasMlRefreshPath(pathname) {
  return pathname === "/preguntas-ml-refresh" || pathname === "/preguntas-ml-refresh/";
}

function isPreguntasMlSyncPendingPath(pathname) {
  return pathname === "/preguntas-ml-sync-pending" || pathname === "/preguntas-ml-sync-pending/";
}

function isPreguntasIaAutoLogPath(pathname) {
  return pathname === "/preguntas-ia-auto-log" || pathname === "/preguntas-ia-auto-log/";
}

function isPreguntasIaAutoRetryPath(pathname) {
  return pathname === "/preguntas-ia-auto-retry" || pathname === "/preguntas-ia-auto-retry/";
}

function isPreguntasIaAutoStatusPath(pathname) {
  return pathname === "/preguntas-ia-auto-status" || pathname === "/preguntas-ia-auto-status/";
}

function isPublicacionesMlPath(pathname) {
  return pathname === "/publicaciones-ml" || pathname === "/publicaciones-ml/";
}

function isListingChangeAckPath(pathname) {
  return pathname === "/listing-change-ack" || pathname === "/listing-change-ack/";
}

function isOrdenesMlPath(pathname) {
  return pathname === "/ordenes-ml" || pathname === "/ordenes-ml/";
}

function isMensajesPackOrdenPath(pathname) {
  return pathname === "/mensajes-pack-orden" || pathname === "/mensajes-pack-orden/";
}

function rejectIngestSecret(req, res) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  if (!timingSafeCompare(req.headers["x-ingest-secret"], secret)) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
    return true;
  }
  return false;
}

function rejectAdminSecret(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
    return true;
  }
  if (!timingSafeCompare(req.headers["x-admin-secret"], secret)) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
    return true;
  }
  return false;
}

/** Secreto POST FileMaker (`/filemaker/tipo-g`, `/mensajes-tipo-g`, `/filemaker/inventario-productos`, `/mensajes-inventario-productos`): `Authorization: Bearer`, `X-Filemaker-Secret` o `?secret=`. */
function filemakerTipoGSecretFromRequest(req, url) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(String(auth))) {
    return String(auth).replace(/^Bearer\s+/i, "").trim();
  }
  const h = req.headers["x-filemaker-secret"];
  if (h != null && String(h).trim() !== "") return String(h).trim();
  const q = url.searchParams.get("secret");
  if (q != null && String(q).trim() !== "") return String(q).trim();
  return "";
}

/** URLs destino (hasta 4 POST salientes). Usa POST_URL_1…POST_URL_4 o POST_WEBHOOK_URLS=url1,url2,… */
function getForwardPostUrls() {
  const fromList = (process.env.POST_WEBHOOK_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const singles = [1, 2, 3, 4]
    .map((n) => process.env[`POST_URL_${n}`])
    .filter(Boolean);
  const merged = fromList.length ? fromList : singles;
  return merged.slice(0, 4);
}

function buildForwardHeaders() {
  const h = { "Content-Type": "application/json; charset=utf-8" };
  const bearer = process.env.POST_BEARER_TOKEN;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

/** Dispara hasta 4 POST en segundo plano (no bloquea la respuesta al webhook entrante). */
function forwardWebhookToTargets(body) {
  const urls = getForwardPostUrls();
  if (!urls.length) return;

  const payload = JSON.stringify(body);
  const headers = buildForwardHeaders();

  setImmediate(() => {
    Promise.allSettled(
      urls.map((url, index) =>
        fetch(url, { method: "POST", headers, body: payload }).then((res) => {
          if (!res.ok) {
            throw new Error(`POST #${index + 1} ${res.status} ${url}`);
          }
        })
      )
    ).then((results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`[forward POST #${i + 1}]`, r.reason?.message || r.reason);
        } else {
          console.log(`[forward POST #${i + 1}] ok`);
        }
      });
    });
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined || s === "") return "—";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Atributos HTML y contenido de textarea (no convierte vacío en —). */
function escapeAttr(s) {
  if (s == null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeTextareaContent(s) {
  if (s == null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new SyntaxError("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

/** Respuesta 400 cuando el cuerpo no es JSON (incluye `detail` para depurar). */
function respondJsonBodyParseError(res, err) {
  res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: false,
      error: "body debe ser JSON",
      detail: err && err.message ? String(err.message) : null,
      hint:
        "En PowerShell usá curl.exe (no el alias curl) o Invoke-RestMethod con -ContentType application/json; ver npm run test-wasender-hook",
    })
  );
}

/**
 * Respuesta 400 JSON para POST/PUT /buyers: ayuda a diagnosticar desde FileMaker/cURL sin exponer secretos.
 * @param {import("http").ServerResponse} res
 * @param {{ error: string, code?: string, hint?: string, debug?: Record<string, unknown> }} payload
 */
function buyersErrorJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, ...payload }));
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{ code: string, hint: string, debug: Record<string, unknown> }}
 */
function explainInvalidBuyerId(body) {
  const has = body != null && Object.prototype.hasOwnProperty.call(body, "buyer_id");
  const raw = has ? body.buyer_id : undefined;
  const n = Number(raw);
  const safe = n <= Number.MAX_SAFE_INTEGER;
  const claves =
    body != null && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body).slice(0, 40)
      : [];
  return {
    code: "BUYER_ID_INVALID",
    hint:
      "buyer_id debe ser un número > 0 (ID ML). Clave recomendada: buyer_id (también se aceptan Buyer_Id, buyerId o data.buyer_id). En FileMaker: el 1.er JSONSetElement debe usar $data (p.ej. \"{}\"), no \"\".",
    debug: {
      tipo_raiz_cuerpo: body == null ? "null" : typeof body,
      claves_recibidas: claves,
      clave_buyer_id: has ? "presente" : "ausente",
      tipo_valor: raw === undefined ? "undefined" : typeof raw,
      muestra: raw == null || raw === "" ? raw : String(raw).slice(0, 48),
      parseado: Number.isFinite(n) ? n : "NaN",
      bajo_max_safe_integer: !Number.isFinite(n) || safe,
    },
  };
}

/**
 * FileMaker a veces manda el objeto JSON como **string** (doble o triple "JSON dentro de comillas").
 * Repetir parse mientras el resultado sea string con forma `{...}` / `[...]`.
 * @param {unknown} body
 * @param {number} [depth]
 */
function unwrapJsonBodyIfNeeded(body, depth = 0) {
  if (depth > 10) return body;
  if (body != null && typeof body === "string") {
    const t = body.replace(/^\uFEFF/, "").trim();
    if (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    ) {
      try {
        const inner = JSON.parse(t);
        return unwrapJsonBodyIfNeeded(inner, depth + 1);
      } catch {
        return body;
      }
    }
  }
  return body;
}

/**
 * POST/PUT /buyers: acepta buyer_id como clave canónica o alias (p. ej. FileMaker con mayúsculas).
 * Si falta o está vacío en la raíz, intenta Buyer_Id, BUYER_ID, buyerId, BuyerId y data.buyer_id.
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function normalizeBuyerIdForBuyers(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) return body;
  const hasCanonical = Object.prototype.hasOwnProperty.call(body, "buyer_id");
  const raw = hasCanonical ? body.buyer_id : undefined;
  const looksEmpty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "");

  if (!looksEmpty) return body;

  const aliases = ["Buyer_Id", "BUYER_ID", "buyerId", "BuyerId"];
  for (const key of aliases) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const v = body[key];
    if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) {
      return { ...body, buyer_id: v };
    }
  }
  const data = body.data;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    const d = /** @type {Record<string, unknown>} */ (data);
    if (Object.prototype.hasOwnProperty.call(d, "buyer_id")) {
      const v = d.buyer_id;
      if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) {
        return { ...body, buyer_id: v };
      }
    }
  }
  return body;
}

function logWebhook(body, req) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    ip: req.socket.remoteAddress,
    topic: body.topic,
    resource: body.resource,
    user_id: body.user_id,
    application_id: body.application_id,
    _id: body._id,
  });
  console.log("[webhook]", line);
}

function extractWasenderEvent(body) {
  if (body != null && typeof body === "object" && !Array.isArray(body) && body.event != null) {
    return String(body.event);
  }
  return null;
}

/**
 * POST /webhook compartido con ML: Wasender trae `event` (p. ej. messages.update) y no usa
 * `topic`/`resource` como las notificaciones ML. Opcional: cabecera X-Webhook-Signature si no hay `event`.
 */
function isWasenderWebhookPayload(body, req) {
  const hasSig =
    req.headers["x-webhook-signature"] != null &&
    String(req.headers["x-webhook-signature"]).trim() !== "";
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.topic != null && String(body.topic).trim() !== "") return false;
  if (body.resource != null && String(body.resource).trim() !== "") return false;
  const ev = body.event;
  if (typeof ev === "string" && ev.trim() !== "") return true;
  return hasSig;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {object} body — ya parseado y unwrap
 * @param {string} [sourceLabel] — "webhook" | "path" para logs
 */
async function handleWasenderWebhookPost(req, res, body, sourceLabel) {
  const src = sourceLabel || "wasender";
  const sigCheck = wasenderWebhookSignatureOk(req);
  if (!sigCheck.ok) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "firma inválida (X-Webhook-Signature)" }));
    return;
  }
  const sigHeader =
    req.headers["x-webhook-signature"] != null
      ? String(req.headers["x-webhook-signature"]).slice(0, 500)
      : null;
  const event = extractWasenderEvent(body);
  const payloadStr = JSON.stringify(body);
  let id = null;
  try {
    id = await insertWasenderWebhookEvent({
      event,
      payload: payloadStr,
      x_webhook_signature: sigHeader,
      signature_ok: sigCheck.skipped ? null : true,
    });
  } catch (e) {
    console.error("[db] wasender_webhook no guardado:", e.message);
  }
  appendWasenderWebhookNdjsonLine({
    time: new Date().toISOString(),
    id,
    event,
    ip: req.socket.remoteAddress,
    source: src,
    payload: body,
  });
  console.log("[wasender-webhook] id=%s event=%s source=%s", id, event, src);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, received: true, id }));
}

/** Extrae item_id desde resource de webhook (path /items/… o id suelto). */
function guessMlItemIdFromResource(resourceStr) {
  const s = String(resourceStr || "");
  const m = s.match(/\/items\/([^/?#]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  const t = s.trim();
  if (/^ML[A-Z]{1,2}\d/i.test(t)) {
    const part = t.split(/[/\s?#]/)[0];
    return part || "?";
  }
  return "?";
}

/** Topic o resource de ítem ML: evita que isItemsTopic falle por variantes del topic. */
function isMlItemsTopic(topic, resourceStr) {
  const t = topic != null ? String(topic).trim().toLowerCase() : "";
  if (t === "item" || t === "items") return true;
  if (resourceStr && /\/items\//i.test(String(resourceStr))) return true;
  return false;
}

/**
 * Para webhooks `messages`: si se puede resolver `order_id`, traer `/orders/{id}` y dejar la fila en `ml_orders`
 * aunque el topic original no sea `orders_v2`.
 */
async function ensureOrderRowFromMessagesWebhook(mlUserId, orderId) {
  const mlUid = Number(mlUserId);
  const oid = Number(orderId);
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return { ok: false, reason: "bad_args" };
  }
  const path = `/orders/${oid}`;
  let res;
  try {
    res = await mercadoLibreFetchForUser(mlUid, path);
  } catch (e) {
    return { ok: false, reason: "fetch_exception", detail: e && e.message ? e.message : String(e) };
  }
  if (!res || !res.ok || !res.data || typeof res.data !== "object" || Array.isArray(res.data)) {
    return {
      ok: false,
      reason: "fetch_failed",
      http_status: res && res.status != null ? res.status : null,
      detail: res && res.rawText ? String(res.rawText).slice(0, 4000) : null,
    };
  }
  const row = orderRowFromMlApi(mlUid, res.data, {
    http_status: res.status,
    sync_error: null,
    fetched_at: new Date().toISOString(),
  });
  if (!row) {
    return { ok: false, reason: "row_null" };
  }
  await upsertMlOrder(row);
  const buyer = extractBuyerFromOrderPayload(res.data);
  if (buyer) {
    try {
      await upsertBuyerFromOrdersV2Webhook(buyer);
    } catch (e) {
      console.error("[ml buyers message->order]", e.message || e);
    }
  }
  return { ok: true, buyer_id: row.buyer_id != null ? Number(row.buyer_id) : null };
}

async function getRegisteredSellerIdSet() {
  const accounts = await listMlAccounts();
  return new Set(
    accounts
      .map((a) => Number(a.ml_user_id))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

/**
 * Tras el webhook: GET al recurso de ML y guarda en ml_topic_fetches (no bloquea la respuesta HTTP).
 */
function scheduleTopicFetchFromWebhook(body) {
  if (!ML_WEBHOOK_FETCH_RESOURCE) return;
  const uid = body && body.user_id;
  const resource = body && body.resource;
  if (uid == null || resource == null || resource === "") return;

  setImmediate(() => {
    const mlUserId = Number(uid);
    const resourceStr = String(resource);
    let topic = null;
    if (body.topic != null) {
      topic = typeof body.topic === "string" ? body.topic.trim() : String(body.topic).trim();
      if (topic === "") topic = null;
    }
    if (topic != null) {
      const tl = String(topic).toLowerCase();
      if (tl === "question" || tl === "questions") topic = "questions";
      if (tl === "message" || tl === "messages") topic = "messages";
      if (tl === "item" || tl === "items") topic = "items";
      if (tl === "orders_feedback") topic = "orders_feedback";
    }
    /** Resource solo id opaco (32 hex o UUID) sin path: ML a veces no envía topic ni `/messages/…`. */
    function resourceLooksLikeMessageOpaqueId(s) {
      if (s == null || typeof s !== "string") return false;
      const core = s.trim().split(/[?#]/)[0];
      const last = core.includes("/") ? core.replace(/^.*\//, "").trim() : core.trim();
      if (/^[0-9a-f]{32}$/i.test(last)) return true;
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last)
      ) {
        return true;
      }
      return false;
    }
    if (!topic && /\/orders\/\d+\/feedback/i.test(resourceStr)) {
      /* No inferir orders_feedback: ML debe enviar body.topic estrictamente "orders_feedback". */
    } else if (!topic && /\/orders\/\d/i.test(resourceStr)) {
      topic = "orders_v2";
    } else if (!topic && /\/messages\//i.test(resourceStr)) {
      topic = "messages";
    } else if (!topic && resourceLooksLikeMessageOpaqueId(resourceStr)) {
      topic = "messages";
    } else if (!topic && /\/questions\//i.test(resourceStr)) {
      topic = "questions";
    } else if (!topic && /\/items\//i.test(resourceStr)) {
      topic = "items";
    }
    if (isMlItemsTopic(topic, resourceStr)) {
      topic = "items";
    }
    const notifId = body._id != null ? String(body._id) : null;
    let requestPath = "";

    (async () => {
      let pendingId = null;
      try {
        const acc = await getMlAccount(mlUserId);
        if (!acc) {
          await insertTopicFetch({
            ml_user_id: mlUserId,
            topic,
            resource: resourceStr,
            request_path: "",
            http_status: 0,
            fetched_at: new Date().toISOString(),
            notification_id: notifId,
            payload: null,
            error: `No hay cuenta en ml_accounts para user_id=${mlUserId}`,
            sku: null,
            title: null,
            process_status: FETCH_PROCESS_STATUS_DONE,
          });
          console.error("[ml fetch] sin cuenta ml_user_id=%s", mlUserId);
          return;
        }

        requestPath = normalizeMlResourcePath(topic, resourceStr);
        if (!requestPath) {
          await insertTopicFetch({
            ml_user_id: mlUserId,
            topic,
            resource: resourceStr,
            request_path: "",
            http_status: 0,
            fetched_at: new Date().toISOString(),
            notification_id: notifId,
            payload: null,
            error: "resource vacío o inválido",
            sku: null,
            title: null,
            process_status: FETCH_PROCESS_STATUS_DONE,
          });
          return;
        }

        pendingId = await insertTopicFetch({
          ml_user_id: mlUserId,
          topic,
          resource: resourceStr,
          request_path: requestPath,
          http_status: 0,
          fetched_at: new Date().toISOString(),
          notification_id: notifId,
          payload: null,
          error: null,
          sku: null,
          title: null,
          process_status: FETCH_PROCESS_STATUS_PENDING,
        });

        const result = await mercadoLibreFetchForUser(mlUserId, requestPath);
        if (topic === "questions" && !result.ok) {
          const st = result.status;
          if (st === 404 || st === 410) {
            const qidGone = extractQuestionIdFromResource(resourceStr);
            if (qidGone != null && Number.isFinite(qidGone) && qidGone > 0) {
              try {
                const removed = await deleteMlQuestionPending(qidGone);
                if (removed > 0) {
                  console.log(
                    "[ml questions] GET %s → %s; eliminado pending ml_question_id=%s (recurso inexistente en ML)",
                    requestPath,
                    st,
                    qidGone
                  );
                }
              } catch (ePg) {
                console.error("[ml questions] DELETE pending tras %s:", st, ePg.message || ePg);
              }
            }
          } else {
            console.error(
              "[ml questions] GET %s → HTTP %s (revisa token y ml_accounts; no se actualiza pending/answered)",
              requestPath,
              st
            );
          }
        }
        let payloadStr = null;
        if (result.data != null) {
          payloadStr =
            typeof result.data === "string"
              ? result.data
              : JSON.stringify(result.data);
        }
        const errMsg = result.ok
          ? null
          : (result.rawText || `HTTP ${result.status}`).slice(0, 4000);

        let sku = null;
        let title = null;
        let parsed = null;
        if (result.ok && result.data != null) {
          let rawParsed = result.data;
          if (typeof rawParsed === "string") {
            try {
              rawParsed = JSON.parse(rawParsed);
            } catch {
              rawParsed = null;
            }
          }
          if (rawParsed && typeof rawParsed === "object" && !Array.isArray(rawParsed)) {
            parsed = rawParsed;
            const extracted = extractSkuTitleFromMlResponse(topic, parsed);
            sku = extracted.sku;
            title = extracted.title;
            if (
              result.ok &&
              topic &&
              (topic === "orders_v2" ||
                (String(topic).startsWith("orders") && topic !== "orders_feedback"))
            ) {
              const buyer = extractBuyerFromOrderPayload(parsed);
              if (buyer) {
                try {
                  await upsertBuyerFromOrdersV2Webhook(buyer);
                } catch (errBuyer) {
                  console.error("[ml buyers]", errBuyer.message);
                }
              }
              /** Sin fila en `ml_orders`, tipo E / ordenes-ml quedan vacíos aunque el hook registre el GET. */
              try {
                const rowOrder = orderRowFromMlApi(mlUserId, parsed, {
                  http_status: result.status,
                  sync_error: null,
                  fetched_at: new Date().toISOString(),
                });
                if (rowOrder) {
                  await upsertMlOrder(rowOrder);
                }
              } catch (eOrd) {
                console.error("[ml orders webhook]", eOrd.message || eOrd);
              }
            }
            if (result.ok && parsed && topic === "orders_feedback") {
              try {
                const oidFb =
                  extractOrderIdFromResource(resourceStr) ||
                  extractOrderIdFromFeedbackPayload(parsed);
                if (oidFb) {
                  const rFb = await upsertOrderFeedbackFromApiResponse(
                    mlUserId,
                    oidFb,
                    parsed,
                    new Date().toISOString(),
                    "orders_feedback_webhook"
                  );
                  console.log(
                    "[orders_feedback webhook] ml_user_id=%s order_id=%s filas_feedback=%s filas_ml_orders=%s ok=%s",
                    mlUserId,
                    oidFb,
                    rFb.upserted,
                    rFb.orderRowsUpdated ?? "—",
                    rFb.ok
                  );
                } else {
                  console.warn(
                    "[orders_feedback webhook] no se pudo resolver order_id (resource ni body.order_id)"
                  );
                }
              } catch (eFb) {
                console.error("[orders_feedback webhook]", eFb.message);
              }
            }
            if (
              result.ok &&
              parsed &&
              topic &&
              topic === "questions"
            ) {
              try {
                const row = buildQuestionPendingRow(parsed, mlUserId, notifId);
                if (row) {
                  if (isQuestionAnsweredOrClosedStatus(row.ml_status)) {
                    const pendingSnap = await getMlQuestionPendingByQuestionId(row.ml_question_id);
                    const answeredRow = buildQuestionAnsweredRow(parsed, mlUserId, notifId);
                    if (answeredRow) {
                      enrichAnsweredRowFromPendingSnapshot(answeredRow, pendingSnap, parsed);
                      const answeredId = await upsertMlQuestionAnswered(answeredRow);
                      if (answeredId != null) {
                        await deleteMlQuestionPending(row.ml_question_id);
                      }
                    }
                  } else if (isQuestionUnansweredStatus(row.ml_status)) {
                    /**
                     * (1) Hook + GET → fila `row`. (2) Si ML_QUESTIONS_IA_AUTO_ENABLED=1 → tryQuestionIaAutoAnswer
                     * (POST /answers, plantilla aleatoria). (3) Si OK → answered + delete pending; si no → pending.
                     */
                    const evalAt = new Date();
                    const win = getQuestionsIaAutoWindowEvaluation(evalAt);
                    const arithmetic = getQuestionsIaAutoWindowArithmeticBreakdown(evalAt);
                    const iaOn = process.env.ML_QUESTIONS_IA_AUTO_ENABLED === "1";
                    const buildIaRouteDetail = (route, extra) =>
                      serializeIaAutoPendingRouteDetail({
                        route,
                        evaluated_at_utc: evalAt.toISOString(),
                        question_date_created_ml: row.date_created || null,
                        evaluation: {
                          active: win.active,
                          outcome: win.outcome,
                          reason_detail: win.reason_detail,
                        },
                        arithmetic_breakdown: arithmetic,
                        ...extra,
                      });
                    if (iaOn) {
                      try {
                        const r = await tryQuestionIaAutoAnswer({
                          mlUserId,
                          pendingRow: row,
                          parsed,
                          notifId,
                          evalAt,
                        });
                        const resueltaAuto =
                          r &&
                          r.ok === true &&
                          (r.question_id != null ||
                            r.skip === "already_sent" ||
                            r.skip === "dropped_stale_pending" ||
                            r.skip === "pending_too_old");
                        if (!resueltaAuto) {
                          await upsertMlQuestionPending({
                            ...row,
                            ia_auto_route_detail: buildIaRouteDetail("pending_after_auto_attempt", {
                              why_not_auto: {
                                ok: r && r.ok,
                                skip: r && r.skip,
                                http_status: r && r.status,
                                error: r && r.error != null ? String(r.error).slice(0, 4000) : null,
                              },
                              human:
                                "IA automática activa pero el POST no completó (revisar skip, api_error o exception en why_not_auto).",
                            }),
                          });
                        }
                      } catch (eIa) {
                        console.error("[questions ia-auto]", eIa.message || eIa);
                        await upsertMlQuestionPending({
                          ...row,
                          ia_auto_route_detail: buildIaRouteDetail("pending_auto_exception", {
                            exception: String(eIa.message || eIa).slice(0, 4000),
                            human: "Excepción al intentar respuesta automática; queda pending para reintento o manual.",
                          }),
                        });
                      }
                    } else {
                      await upsertMlQuestionPending({
                        ...row,
                        ia_auto_route_detail: buildIaRouteDetail("pending_no_auto_attempt", {
                          why: "ML_QUESTIONS_IA_AUTO_ENABLED distinto de 1",
                          human:
                            "IA automática deshabilitada: no se intenta POST /answers; solo se guarda pending.",
                        }),
                      });
                    }
                    if (process.env.ML_WHATSAPP_TIPO_F_ENABLED === "1") {
                      const qidF = row.ml_question_id;
                      const uidF = mlUserId;
                      setImmediate(() => {
                        trySendWhatsappTipoFForQuestion({
                          mlUserId: uidF,
                          mlQuestionId: Number(qidF),
                        }).catch((err) =>
                          console.error(
                            "[whatsapp tipo F] ml_question_id=%s %s",
                            qidF,
                            err && err.message ? err.message : err
                          )
                        );
                      });
                    }
                  } else {
                    /** Otros estados (p. ej. UNDER_REVIEW): no mantener en pending. */
                    await deleteMlQuestionPending(row.ml_question_id);
                  }
                }
              } catch (eQ) {
                console.error("[ml questions pending]", eQ.message);
              }
            }
            if (
              result.ok &&
              ML_WEBHOOK_FETCH_VENTAS_DETALLE &&
              topic &&
              (topic === "orders_v2" ||
                (String(topic).startsWith("orders") && topic !== "orders_feedback"))
            ) {
              const ventasOrderId = extractOrderIdFromOrder(parsed);
              if (ventasOrderId) {
                const buyerVentas = extractBuyerFromOrderPayload(parsed);
                const buyerIdVentas = buyerVentas ? buyerVentas.buyer_id : undefined;
                setImmediate(() => {
                  /* mlUserId = body.user_id del webhook (vendedor); cookies deben estar guardadas para ese id */
                  fetchVentasDetalleAndStore({
                    mlUserId,
                    orderId: ventasOrderId,
                    buyerId: buyerIdVentas,
                  }).catch((e) => console.error("[ventas-detalle]", e.message));
                });
              }
            }
          }
        }

        if (topic === "items") {
          const pathForLog = result.path || requestPath;
          const fetchedAt = new Date().toISOString();
          const logItemId = guessMlItemIdFromResource(resourceStr);
          try {
            if (result.ok && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const row = listingRowFromMlItemApi(mlUserId, parsed, {
                http_status: result.status,
                sync_error: null,
                fetched_at: fetchedAt,
              });
              if (row) {
                const lid = await upsertMlListing(row);
                await insertMlListingWebhookLog({
                  ml_user_id: mlUserId,
                  item_id: row.item_id,
                  notification_id: notifId,
                  topic: "items",
                  request_path: pathForLog,
                  http_status: result.status,
                  upsert_ok: true,
                  listing_id: lid,
                  error_message: null,
                  fetched_at: fetchedAt,
                });
              } else {
                await insertMlListingWebhookLog({
                  ml_user_id: mlUserId,
                  item_id: logItemId,
                  notification_id: notifId,
                  topic: "items",
                  request_path: pathForLog,
                  http_status: result.status,
                  upsert_ok: false,
                  listing_id: null,
                  error_message: "JSON de ítem sin id válido",
                  fetched_at: fetchedAt,
                });
              }
            } else {
              await insertMlListingWebhookLog({
                ml_user_id: mlUserId,
                item_id: logItemId,
                notification_id: notifId,
                topic: "items",
                request_path: pathForLog,
                http_status: result.status,
                upsert_ok: false,
                listing_id: null,
                error_message: errMsg || "respuesta no JSON o vacía",
                fetched_at: fetchedAt,
              });
            }
          } catch (eItems) {
            console.error("[ml items webhook]", eItems.message);
            try {
              await insertMlListingWebhookLog({
                ml_user_id: mlUserId,
                item_id: logItemId,
                notification_id: notifId,
                topic: "items",
                request_path: pathForLog,
                http_status: result.status,
                upsert_ok: false,
                listing_id: null,
                error_message: (eItems.message || String(eItems)).slice(0, 4000),
                fetched_at: fetchedAt,
              });
            } catch (eLog) {
              console.error("[ml items webhook log]", eLog.message);
            }
          }
        }

        const isOrderTopic =
          topic &&
          (topic === "orders_v2" ||
            (String(topic).startsWith("orders") && topic !== "orders_feedback"));
        /** orders_v2: post-venta define el estado. items: siempre cerrado (no dejar job pendiente). Otros topics no-orden suelen quedar pendientes. */
        const isOrdersV2Topic = topic === "orders_v2";
        const isOrdersFeedbackTopic = topic === "orders_feedback";
        const isItemsTopic = topic === "items" || isMlItemsTopic(topic, resourceStr);

        let processStatus = FETCH_PROCESS_STATUS_DONE;
        if (isOrderTopic) {
          try {
            const ps = await trySendDefaultPostSaleMessage({
              mlUserId,
              topic,
              payload: parsed,
              resource: resourceStr,
              notificationId: notifId,
            });
            if (ps && ps.skipped) {
              processStatus = FETCH_PROCESS_STATUS_DONE;
            } else if (ps && ps.ok === true) {
              processStatus = FETCH_PROCESS_STATUS_DONE;
            } else {
              processStatus = FETCH_PROCESS_STATUS_POST_SALE_FAILED;
            }
          } catch (e) {
            console.error("[post-sale]", e.message);
            processStatus = FETCH_PROCESS_STATUS_POST_SALE_FAILED;
          }
        }
        if (
          result.ok &&
          parsed &&
          topic === "orders_v2" &&
          process.env.ML_WMS_ORDER_RESERVATIONS_ENABLED === "1"
        ) {
          setImmediate(() => {
            (async () => {
              try {
                const orderId = extractOrderIdFromOrder(parsed);
                if (!orderId) return;
                const resource =
                  parsed._links && parsed._links.self && parsed._links.self.href
                    ? String(parsed._links.self.href)
                    : "";
                const status = parsed.status != null ? String(parsed.status) : "";
                const items = mapOrderItemsForWms(parsed);

                if (status === "confirmed" || status === "paid") {
                  const r = await reserveForOrder({
                    mlOrderId: orderId,
                    mlResourceUrl: resource,
                    items,
                    userId: null,
                  });
                  if (!r.success) {
                    console.log("[WMS] Reserva fallida orden", orderId, r);
                  }
                } else if (status === "shipped") {
                  await commitReservation({ mlOrderId: orderId, userId: null });
                } else if (status === "cancelled") {
                  await releaseReservation({ mlOrderId: orderId, userId: null });
                }
              } catch (err) {
                console.error(
                  "[WMS] Error en reserva automática:",
                  err && err.message ? err.message : err
                );
              }
            })();
          });
        }
        if (result.ok && !isOrdersV2Topic && !isItemsTopic && !isOrdersFeedbackTopic) {
          processStatus = FETCH_PROCESS_STATUS_PENDING;
        }

        /** Post-venta automático para topics no-orden: solo `messages` (order_id en payload). */
        if (result.ok && parsed && !isOrderTopic && topic === "messages") {
          setImmediate(() => {
            (async () => {
              const oidMsg = extractOrderIdFromMessage(parsed);
              const tagPack =
                (process.env.ML_PACK_MESSAGES_SYNC_TAG || "post_sale").trim() || "post_sale";
              let skipPhoneAnalysisFromSeller = false;
              try {
                const sellerIds = await getRegisteredSellerIdSet();
                const msgRoot =
                  parsed &&
                  typeof parsed === "object" &&
                  Array.isArray(parsed.messages) &&
                  parsed.messages.length > 0 &&
                  parsed.messages[0] &&
                  typeof parsed.messages[0] === "object"
                    ? parsed.messages[0]
                    : parsed;
                const fromUserId =
                  msgRoot &&
                  msgRoot.from &&
                  typeof msgRoot.from === "object" &&
                  msgRoot.from.user_id != null
                    ? Number(msgRoot.from.user_id)
                    : NaN;
                skipPhoneAnalysisFromSeller =
                  Number.isFinite(fromUserId) && fromUserId > 0 && sellerIds.has(fromUserId);
                if (skipPhoneAnalysisFromSeller) {
                  console.log(
                    "[messages phone analysis] omitido ml_user_id=%s from_user_id=%s (cuenta seller registrada)",
                    mlUserId,
                    fromUserId
                  );
                }
              } catch (eSeller) {
                console.error("[messages phone analysis] seller ids:", eSeller.message || eSeller);
              }
              if (oidMsg) {
                try {
                  const ordRes = await ensureOrderRowFromMessagesWebhook(mlUserId, oidMsg);
                  if (ordRes.ok) {
                    console.log("[ml orders message-hook] ml_user_id=%s order_id=%s upsert_ok=1", mlUserId, oidMsg);
                  } else {
                    console.warn(
                      "[ml orders message-hook] ml_user_id=%s order_id=%s reason=%s http=%s",
                      mlUserId,
                      oidMsg,
                      ordRes.reason || "unknown",
                      ordRes.http_status != null ? ordRes.http_status : "—"
                    );
                  }
                } catch (eOrd) {
                  console.error("[ml orders message-hook]", eOrd.message || eOrd);
                }
              }
              /** Aunque el listado pack aún no exista (404), el GET del mensaje sí trae cuerpo; así se crea la 1.ª fila. */
              if (
                oidMsg &&
                process.env.ML_WEBHOOK_PERSIST_MESSAGE_FETCH !== "0" &&
                process.env.ML_WEBHOOK_PERSIST_MESSAGE_FETCH !== "false"
              ) {
                try {
                  const pr0 = await persistPackMessageFromWebhookFetch(mlUserId, oidMsg, parsed, {
                    tag: tagPack,
                    resourceStr: resourceStr,
                  });
                  if (pr0.ok) {
                    console.log(
                      "[ml pack webhook] mensaje GET guardado ml_user_id=%s order_id=%s ml_message_id=%s",
                      mlUserId,
                      oidMsg,
                      pr0.ml_message_id
                    );
                  }
                } catch (e0) {
                  console.error("[ml pack webhook] persist mensaje GET:", e0.message || e0);
                }
              }
              if (
                oidMsg &&
                process.env.ML_WEBHOOK_SYNC_PACK_ON_MESSAGE !== "0" &&
                process.env.ML_WEBHOOK_SYNC_PACK_ON_MESSAGE !== "false"
              ) {
                try {
                  const appId = String(
                    process.env.ML_APPLICATION_ID || process.env.OAUTH_CLIENT_ID || "1837222235616049"
                  ).trim();
                  const pageSize = Math.min(
                    50,
                    Math.max(1, Number(process.env.ML_PACK_MESSAGES_SYNC_PAGE_SIZE) || 50)
                  );
                  const delayMs = Math.max(0, Number(process.env.ML_PACK_MESSAGES_SYNC_DELAY_MS) || 0);
                  const pr = await syncPackMessagesForOrder(mlUserId, oidMsg, {
                    tag: tagPack,
                    appId,
                    pageSize,
                    delayMs,
                  });
                  if (pr.ok) {
                    console.log(
                      "[ml pack webhook] ml_user_id=%s order_id=%s mensajes_upsert_lista=%s empty=%s",
                      mlUserId,
                      oidMsg,
                      pr.upserted,
                      pr.empty === true ? "1" : "0"
                    );
                  } else {
                    console.warn(
                      "[ml pack webhook] ml_user_id=%s order_id=%s err=%s",
                      mlUserId,
                      oidMsg,
                      (pr.error || "—").slice(0, 400)
                    );
                  }
                } catch (ePk) {
                  console.error("[ml pack webhook] sync lista:", ePk.message || ePk);
                }
              }
              try {
                await trySendDefaultPostSaleMessage({
                  mlUserId,
                  topic,
                  payload: parsed,
                  resource: resourceStr,
                  notificationId: notifId,
                });
              } catch (e) {
                console.error("[post-sale]", e.message);
              }
              try {
                if (!skipPhoneAnalysisFromSeller) {
                  await maybeProcessInternalOrderMessageForTipoE({
                    mlUserId,
                    parsed,
                    resourceStr,
                  });
                }
              } catch (e) {
                console.error("[whatsapp tipo E internal]", e.message);
              }
              try {
                const tipoEForce =
                  process.env.ML_WEBHOOK_MESSAGES_FORCE_TIPO_E_ON_PHONE !== "0" &&
                  process.env.ML_WEBHOOK_MESSAGES_FORCE_TIPO_E_ON_PHONE !== "false";
                if (tipoEForce && !skipPhoneAnalysisFromSeller) {
                  const forced = await processOrderMessagePhoneForTipoE({
                    mlUserId,
                    parsed,
                    resourceStr,
                    tipoEActivationSource: "mensajeria_pack_phone",
                  });
                  if (forced && !forced.skipped) {
                    console.log(
                      "[whatsapp tipo E message-phone] ml_user_id=%s order_id=%s buyer_id=%s updated=%s outcome=%s",
                      mlUserId,
                      forced.order_id != null ? forced.order_id : "—",
                      forced.buyer_id != null ? forced.buyer_id : "—",
                      forced.buyer_updated === true ? "1" : "0",
                      forced.outcome || "—"
                    );
                  }
                }
              } catch (e) {
                console.error("[whatsapp tipo E message-phone]", e.message || e);
              }
            })();
          });
        }

        await updateTopicFetch(pendingId, {
          request_path: result.path || requestPath,
          http_status: result.status,
          fetched_at: new Date().toISOString(),
          payload: payloadStr,
          error: errMsg,
          sku,
          title,
          process_status: processStatus,
        });
        if (!result.ok) {
          console.error(
            "[ml fetch] user_id=%s topic=%s %s → %s",
            mlUserId,
            topic,
            requestPath,
            result.status
          );
        } else {
          console.log("[ml fetch] ok user_id=%s topic=%s %s", mlUserId, topic, requestPath);
        }
      } catch (e) {
        try {
          if (pendingId != null) {
            await updateTopicFetch(pendingId, {
              error: e.message || String(e),
              http_status: 0,
              process_status: FETCH_PROCESS_STATUS_DONE,
            });
          } else {
            await insertTopicFetch({
              ml_user_id: mlUserId,
              topic,
              resource: resourceStr,
              request_path: requestPath || "",
              http_status: 0,
              fetched_at: new Date().toISOString(),
              notification_id: notifId,
              payload: null,
              error: e.message || String(e),
              sku: null,
              title: null,
              process_status: FETCH_PROCESS_STATUS_DONE,
            });
          }
        } catch (dbErr) {
          console.error("[ml fetch] DB:", dbErr.message);
        }
        console.error("[ml fetch] user_id=%s: %s", mlUserId, e.message);
      }
    })();
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (handleCrmApiPreflight(req, res, url)) {
    return;
  }

  if (await handlePublicFrontendRequest(req, res, url)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "webhook-receiver",
        version: pkg.version,
        database: {
          backend: "postgresql",
          info: dbPath,
        },
        webhook: WEBHOOK_PATH,
        multi_cuentas_ml:
          "POST /admin/ml-accounts (cabecera X-Admin-Secret) registra refresh por ml_user_id · POST /admin/oauth-exchange JSON {code, redirect_uri?} intercambia code de ML y guarda cuenta · POST /admin/ml-web-cookies JSON {ml_user_id, cookies_netscape} — cookies en BD; DELETE ?ml_user_id= — borra",
        oauth_token_status:
          "GET /oauth/token-status  o  ?ml_user_id=  (token enmascarado, sin secreto completo)",
        cuentas_ml:
          "GET /cuentas?k=ADMIN_SECRET (lista cuentas; mismo valor que variable ADMIN_SECRET)",
        hooks_recibidos:
          "GET /hooks?k=ADMIN_SECRET (webhook_events: cada POST /webhook guarda JSON; POST /reg también)",
        wasender_webhook:
          "Wasender puede usar el mismo POST que ML: /webhook (cuerpo con event Wasender, sin topic/resource ML) o rutas dedicadas /wasender-webhook, /api/wasender/webhook — wasender_webhook_events; GET /wasender-webhooks?k=ADMIN_SECRET",
        topic_fetches_ml:
          "GET /fetches?k=ADMIN_SECRET (orden por topic; ?topic=orders_v2 filtra; ML_WEBHOOK_FETCH_RESOURCE=1). Solo si body.topic es exactamente orders_feedback: tras GET /orders/{id}/feedback se actualizan ml_order_feedback y feedback_* en ml_orders (no se infiere el topic desde el resource)",
        borrar_todos_los_fetches:
          "DELETE /admin/topic-fetches (cabecera X-Admin-Secret) vacía tabla ml_topic_fetches",
        borrar_snapshots_ventas_detalle_ve:
          "DELETE /admin/ventas-detalle-web (cabecera X-Admin-Secret) vacía ml_ventas_detalle_web (GET detalle .ve con cookies)",
        buyers_ml:
          "GET /buyers?k=ADMIN_SECRET (ml_buyers: nombre_apellido, pref_entrega, observaciones texto libre, actualizacion ISO). POST/PUT JSON buyer_id + campos opcionales (cabecera X-Admin-Secret alternativa)",
        inventario_productos:
          "GET|POST|PUT|DELETE /inventario-productos?k=ADMIN_SECRET — tabla productos (BD): hasta 9 imgs/SKU (imagenes_cantidad + PRODUCT_IMAGE_BASE_URL → imagenes_urls en JSON). Ver productos-inventario.js",
        mensajes_postventa:
          "GET|POST|DELETE /mensajes-postventa?k=ADMIN_SECRET (plantillas post-venta; JSON en POST/DELETE)",
        mensajes_whatsapp_tipo_e:
          "GET|POST /mensajes-tipo-e-whatsapp?k=ADMIN_SECRET (config tipo E en ml_whatsapp_tipo_e_config) · GET|POST /mensajes-tipo-f-whatsapp?k=ADMIN_SECRET (plantilla tipo F + seguir con E×2) · GET /envios-whatsapp-tipo-e?k=ADMIN_SECRET (log envíos Wasender E/F en ml_whatsapp_wasender_log; ?kind=e|f|all & outcome=…)",
        filemaker_tipo_g:
          "POST /filemaker/tipo-g o POST /mensajes-tipo-g (mismo JSON y FILEMAKER_TIPO_G_SECRET) — actualiza ml_buyers e intenta WhatsApp tipo E · GET /mensajes-tipo-g?k=ADMIN_SECRET (log ml_filemaker_tipo_g_log)",
        filemaker_inventario_productos:
          "POST /filemaker/inventario-productos o POST /mensajes-inventario-productos (JSON producto + FILEMAKER_INVENTARIO_PRODUCTOS_SECRET) — upsert tabla productos; GET inventario sigue en /inventario-productos?k=ADMIN_SECRET",
        catalogo_publico_frontend:
          "API pública /api/v1: GET /api/v1 (índice), GET /api/v1/health, GET /api/v1/catalog?search=&limit=&offset= — catálogo con cabecera X-API-KEY (=FRONTEND_API_KEY); CORS FRONTEND_CORS_ORIGINS; rate limit FRONTEND_RATE_LIMIT_*; solo id, sku, nombre, precio_venta, stock · compat motor/válvulas: GET /api/v1/catalog/compat/makes|/models?make=|/search?make=&model=&year=&displacement_l=|/for-sku?sku=|/equivalences?sku= (misma X-API-KEY; requiere sql/catalog-motor-compatibility.sql)",
        api_wallet_admin:
          "Customer wallet (X-Admin-Secret): GET /api/wallet/summary?customer_id=|ml_buyer_id=&currency= · GET /drift · GET /customers · GET /customer?id= · GET /transactions?customer_id= · POST /customers, /link-ml-buyer, /wallets/ensure, /transactions, /transactions/confirm, /transactions/cancel — npm run test-wallet; npm run test-wallet-http (servidor arriba; requiere sql/customer-wallet.sql)",
        api_customers_crm:
          "Clientes CRM: CRUD admin (X-Admin-Secret) GET/POST/PUT/PATCH /api/customers… · historial+fidelidad+perfil unificado (X-Admin-Secret o X-API-Key=FRONTEND_API_KEY): GET /api/customers/:id/history, GET …/loyalty, GET …/profile, POST …/loyalty/adjust (solo admin) · POST /api/crm/loyalty/earn (solo admin, acumulación por orden) — CORS OPTIONS en /api/customers* y /api/crm/* — migraciones: sql/crm-solomotor3k.sql + sql/20260408_loyalty.sql (npm run db:loyalty)",
        api_crm_admin:
          "CRM (X-Admin-Secret): catálogo plano GET|POST /api/crm/brands, GET|POST /api/crm/models?brand_id=, GET|POST /api/crm/generations?model_id=, GET|POST /api/crm/compatibility · POST /api/customers/purchase (mostrador + puntos) · GET /api/crm/logs · WhatsApp GET|POST /webhook/whatsapp (WA_VERIFY_TOKEN) — migraciones sql/20260408_vehicles_catalog.sql + 20260408_mostrador_orders.sql",
        api_sales_omnicanal:
          "Ventas globales (X-Admin-Secret): POST /api/sales/create (mostrador/social; customer opcional; payment_method; Bs vía tasas), GET /api/sales, /stats, PATCH estados pending|paid|shipped|cancelled, import ML — npm run db:sales && db:sales-ml && db:sales-global; crm_customer_identities + kits en productos.atributos.kit_components; npm run sales:stress",
        envio_auto_postventa:
          "ML_AUTO_SEND_POST_SALE=1, ML_AUTO_SEND_TOPICS=… · ML_POST_SALE_TOTAL_MESSAGES=1|2|3 (plantillas por id en post_sale_messages) · ML_POST_SALE_EXTRA_DELAY_MS · ML_POST_SALE_DISABLE_DEDUP=1 solo pruebas (sin deduplicación) · placeholders {{order_id}} {{buyer_id}} {{seller_id}} · recordatorio calificación: npm run rating-request-daily-all + ML_RATING_REQUEST_ENABLED=1 (lookback por defecto 6 días; ML_RATING_REQUEST_LOOKBACK_DAYS opcional)",
        log_envios_postventa:
          "GET /envios-postventa?k=ADMIN_SECRET (historial). POST /envios-postventa/retry?k=… JSON {order_id,ml_user_id,buyer_id?} opcional force, topic",
        log_envios_tipos_abc:
          "GET /envios-tipos-abc?k=ADMIN_SECRET - log unificado ml_message_kind_send_log (tipos A/B/C; ?kind=a|b|c|all & outcome=success|skipped|api_error|all)",
        recordatorios_calificacion:
          "GET /recordatorios-calificacion?k=ADMIN_SECRET — visualiza tabla ml_rating_request_log (cada POST recordatorio calificación; HTML o ?format=json; ?outcome=all|success|api_error; columna feedback comprador = snapshot ml_orders). Alias corto: GET /recordatorios?k=…",
        ml_rating_request_log:
          "Misma vista — GET /recordatorios-calificacion?k=ADMIN_SECRET o /recordatorios?k=ADMIN_SECRET",
        como_ver_recordatorios_calificacion: {
          paso_1: "El servidor debe tener definida la variable de entorno ADMIN_SECRET (misma clave que usás en ?k=).",
          paso_2:
            "Con el servidor en marcha (npm start), abrí en el navegador: https://TU_HOST/recordatorios-calificacion?k=TU_CLAVE (o /recordatorios?k=…). Local: http://localhost:PUERTO/recordatorios-calificacion?k=TU_CLAVE",
          paso_3: "Si ves 503, falta ADMIN_SECRET; si 401, la clave en ?k= no coincide.",
          json: "GET …/recordatorios-calificacion?k=…&format=json",
        },
        cookies_ml_web:
          "Cookies detalle .ve: prioridad (1) ml_accounts.cookies_netscape (POST /admin/ml-web-cookies), (2) archivo, (3) ML_COOKIE_NETSCAPE_*. Formatos: Netscape, JSON o Header String (Cookie-Editor).",
        ventas_detalle_web:
          "ml_ventas_detalle_web.raw = HTML; GET /ventas-detalle-web?k= & format=json&include_raw=1 — POST retry JSON write_log:true o ML_VENTAS_DETALLE_LOG_FILE=1 → log.txt (ML_VENTAS_DETALLE_LOG_PATH opcional) — DELETE /admin/ventas-detalle-web vacía la tabla",
        preguntas_ml: {
          ml_questions_pending:
            "Por responder: GET /preguntas-ml?k=ADMIN_SECRET&tabla=pending · Webhook questions + ML_WEBHOOK_FETCH_RESOURCE=1 → GET /questions/{id}; si UNANSWERED y ML_QUESTIONS_IA_AUTO_ENABLED=1 se intenta POST /answers al instante (plantilla aleatoria) o se deja pending",
          ml_questions_answered:
            "Respondidas: GET /preguntas-ml?k=ADMIN_SECRET&tabla=answered · Tras GET /questions/{id} con status respondido/cerrado",
          ml_questions_refresh:
            "GET /preguntas-ml-refresh?k=ADMIN_SECRET&ml_question_id=ID — sincroniza una pregunta con la API ML (respuesta manual en la app sin webhook); opcional ml_user_id= vendedor si pending tiene user_id erróneo",
          ml_questions_sync_pending:
            "GET /preguntas-ml-sync-pending?k=ADMIN_SECRET&limit=50 — recorre pending y alinea con ML (answered/cerradas → answered; GET 404/410 → borra pending huérfano)",
          delete_all_ml_questions_pending:
            "DELETE /admin/ml-questions-pending (cabecera X-Admin-Secret) vacía ml_questions_pending (solo BD local; no afecta preguntas en ML)",
          respuesta_automatica_ia:
            "Tipo D (preguntas): ML_QUESTIONS_IA_AUTO_ENABLED=1 → POST /answers, plantillas QUESTION_IA_BODIES + ML_QUESTIONS_IA_AUTO_EXTRA_LINE opcional al final (avisos p. ej. Semana Santa). Ventana START/END (TIMEZONE); domingo 24 h salvo SUNDAY_IGNORE_WINDOW=0; DAYS; IGNORE_WINDOW/FORCE. Éxito → answered + borrar pending.",
          log_ia_auto_omitidos:
            "GET /preguntas-ia-auto-log?k=ADMIN_SECRET — ml_questions_ia_auto_log (intentos sin POST /answers cuando IA desactivada u otros motivos; ?format=json&limit=)",
          retry_ia_auto_pending:
            "GET /preguntas-ia-auto-retry?k=ADMIN_SECRET — reintenta POST /answers para filas en ml_questions_pending (?limit=50)",
          poll_ia_auto_pending:
            "ENABLED=1: reintenta pending cada 1 min por defecto (POLL_MS vacío=60000; 0=sin poll; ≥60000=intervalo ms). ML_QUESTIONS_IA_AUTO_POLL_LIMIT=40 · ML_QUESTIONS_IA_AUTO_PENDING_MAX_AGE_MS vacío=1800000 (30 min): no POST /answers automático si la pregunta es más antigua; 0=sin tope por edad",
          estado_ia_auto_prueba:
            "GET /preguntas-ia-auto-status?k=ADMIN_SECRET — JSON: modo manual/automático, hora local, env efectivo, checks (IA on, ML_WEBHOOK_FETCH_RESOURCE), texto prueba",
        },
        publicaciones_ml:
          "GET /publicaciones-ml?k=ADMIN_SECRET — publicaciones en ml_listings por cuenta; ?cuenta=ml_user_id y ?status= (ej. active, paused, closed) filtran; ?format=json; estado sync en ml_listing_sync_state (cuando exista job de descarga)",
        items_webhook_listing_refresh:
          "Con ML_WEBHOOK_FETCH_RESOURCE=1, topic items (o resource /items/…) → GET /items/{id}?api_version=4 y upsert en ml_listings; auditoría en ml_listing_webhook_log",
        listing_change_ack:
          "GET|POST /listing-change-ack?k=ADMIN_SECRET — tabla ml_listing_change_ack: marcar ítem procesado (action: activate|add_stock|pause|delete|dismiss). POST JSON { ml_user_id, item_id, action, note?, webhook_log_id? }",
        ordenes_ml:
          "GET /ordenes-ml?k=ADMIN_SECRET — ml_orders (descarga: npm run sync-orders | sync-orders-all | sync-orders-today-all solo día actual); feedback detalle: npm run sync-order-feedback | sync-order-feedback-all; ?cuenta= ?status= ?format=json; status ML típicos en raíz JSON bajo ordenes_estados_ml",
        mensajes_pack_orden:
          "GET /mensajes-pack-orden?k=ADMIN_SECRET — ml_order_pack_messages (sync: npm run sync-pack-messages); webhook messages: guarda el mensaje del GET en BD (ML_WEBHOOK_PERSIST_MESSAGE_FETCH≠0) aunque /messages/packs/{order_id}/… aún no exista; luego lista el pack (ML_WEBHOOK_SYNC_PACK_ON_MESSAGE≠0). ?ml_user_id= & opcional &order_id= &limit= ; ?format=json",
        ordenes_estados_ml: ML_ORDER_STATUSES_KNOWN,
      })
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const down = isInDowntime();
    const msLeft = msUntilSystemUp();
    res.writeHead(down ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        status: down ? "DOWNTIME" : "OK",
        time_vet: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        retry_after_seconds: down ? Math.ceil(msLeft / 1000) : 0,
      })
    );
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/currency/override" || url.pathname === "/api/currency/fetch")) {
    if (rejectDuringDowntime(req, res)) return;
  }

  if (await handleCurrencyApiRequest(req, res, url)) {
    return;
  }

  if (await handleShippingApiRequest(req, res, url)) {
    return;
  }

  if (await handleWmsApiRequest(req, res, url)) {
    return;
  }

  if (await handleWalletApiRequest(req, res, url)) {
    return;
  }

  if (await handleVehicleApiRequest(req, res, url)) {
    return;
  }

  if (await handlePurchaseApiRequest(req, res, url)) {
    return;
  }

  if (await handleSalesApiRequest(req, res, url)) {
    return;
  }

  if (await handleCustomerHistoryRequest(req, res, url)) {
    return;
  }

  if (await handleCustomerLoyaltyRoutes(req, res, url)) {
    return;
  }

  if (await handleCrmLoyaltyEarnRequest(req, res, url)) {
    return;
  }

  if (await handleCustomersApiRequest(req, res, url)) {
    return;
  }

  if (await handleCrmApiRequest(req, res, url)) {
    return;
  }

  if (await handleBankStatementsRequest(req, res, url)) {
    return;
  }

  if (await handleBankBanescoRequest(req, res, url)) {
    return;
  }

  /** FileMaker → actualizar buyer + intento tipo E (Wasender). Requiere `FILEMAKER_TIPO_G_SECRET`. Alias POST: `/mensajes-tipo-g`. */
  if (
    req.method === "POST" &&
    (isFilemakerTipoGPostPath(url.pathname) || isMensajesTipoGPath(url.pathname))
  ) {
    const expected = process.env.FILEMAKER_TIPO_G_SECRET;
    if (!expected || String(expected).trim() === "") {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "FILEMAKER_TIPO_G_SECRET no definido en el servidor",
        })
      );
      return;
    }
    const provided = filemakerTipoGSecretFromRequest(req, url);
    if (!timingSafeCompare(provided, String(expected).trim())) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      respondJsonBodyParseError(res, e);
      return;
    }
    body = unwrapJsonBodyIfNeeded(body);
    try {
      const result = await processFilemakerTipoGPost(body);
      res.writeHead(result.httpStatus, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result.json));
    } catch (e) {
      console.error("[filemaker tipo G]", e);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "internal_error", detail: e.message || String(e) }));
    }
    return;
  }

  /** FileMaker → upsert `productos`. Requiere `FILEMAKER_INVENTARIO_PRODUCTOS_SECRET`. Alias POST: `/mensajes-inventario-productos`. */
  if (
    req.method === "POST" &&
    (isFilemakerInventarioProductosPostPath(url.pathname) || isMensajesInventarioProductosPath(url.pathname))
  ) {
    const expected = process.env.FILEMAKER_INVENTARIO_PRODUCTOS_SECRET;
    if (!expected || String(expected).trim() === "") {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "FILEMAKER_INVENTARIO_PRODUCTOS_SECRET no definido en el servidor",
        })
      );
      return;
    }
    const provided = filemakerTipoGSecretFromRequest(req, url);
    if (!timingSafeCompare(provided, String(expected).trim())) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      respondJsonBodyParseError(res, e);
      return;
    }
    body = unwrapJsonBodyIfNeeded(body);
    try {
      const result = await processFilemakerInventarioProductosPost(body);
      res.writeHead(result.httpStatus, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result.json));
    } catch (e) {
      console.error("[filemaker inventario productos]", e);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "internal_error", detail: e.message || String(e) }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/status") {
    const hasCreds = Boolean(
      (process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID) &&
        (process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET) &&
        (process.env.OAUTH_REFRESH_TOKEN ||
          process.env.ML_REFRESH_TOKEN ||
          process.env.OAUTH_TOKEN_FILE)
    );
    if (!hasCreds) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ oauth: "no configurado" }));
      return;
    }
    try {
      await getAccessToken();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ oauth: "conectado", ok: true }));
    } catch (e) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ oauth: "error", ok: false, message: e.message }));
    }
    return;
  }

  /** Token activo: solo vista enmascarada + caducidad (nunca el string completo). */
  if (req.method === "GET" && url.pathname === "/oauth/token-status") {
    const mlUid = url.searchParams.get("ml_user_id");
    try {
      if (mlUid !== null && mlUid !== "") {
        const id = Number(mlUid);
        if (!Number.isFinite(id) || id <= 0) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "ml_user_id invalido" }));
          return;
        }
        await getAccessTokenForMlUser(id);
        const st = getTokenStatusForMlUser(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            modo: "cuenta_registrada",
            nota: "access_token enmascarado; no se muestra el valor completo por seguridad",
            ...st,
          })
        );
        return;
      }

      const hasSingle = Boolean(
        (process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID) &&
          (process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET) &&
          (process.env.OAUTH_REFRESH_TOKEN ||
            process.env.ML_REFRESH_TOKEN ||
            process.env.OAUTH_TOKEN_FILE)
      );
      if (!hasSingle) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            hint: "Configura refresh en env, o usa /oauth/token-status?ml_user_id=NUMERO (cuenta en ml_accounts)",
          })
        );
        return;
      }

      await getAccessToken();
      const st = getTokenStatus();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          modo: "cuenta_env",
          nota: "access_token enmascarado; no se muestra el valor completo por seguridad",
          ...st,
        })
      );
    } catch (e) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return;
  }

  /** Lista de cuentas ML registradas (HTML o JSON); protegida con ?k= igual a ADMIN_SECRET. */
  if (req.method === "GET" && isCuentasPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Cuentas</title><p>Define la variable de entorno <code>ADMIN_SECRET</code> en el servidor y reinicia.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Cuentas</title><p>Acceso denegado. Abre <code>/cuentas?k=TU_CLAVE</code> (la misma clave que <code>ADMIN_SECRET</code>).</p>"
      );
      return;
    }
    let accounts;
    try {
      accounts = await listMlAccounts();
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }

    const enriched = await Promise.all(
      accounts.map(async (a) => {
        const uid = a.ml_user_id;
        try {
          await getAccessTokenForMlUser(uid);
          const st = getTokenStatusForMlUser(uid);
          return {
            ml_user_id: uid,
            nickname: a.nickname,
            updated_at: a.updated_at,
            cookies_web_stored: Boolean(a.cookies_web_stored),
            status: "ok",
            access_token_preview: st.access_token_preview || st.mask,
            expiresAtIso: st.expiresAtIso,
            secondsRemaining: st.secondsRemaining,
            error: null,
          };
        } catch (err) {
          return {
            ml_user_id: uid,
            nickname: a.nickname,
            updated_at: a.updated_at,
            cookies_web_stored: Boolean(a.cookies_web_stored),
            status: "error",
            access_token_preview: null,
            expiresAtIso: null,
            secondsRemaining: null,
            error: err.message || String(err),
          };
        }
      })
    );

    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, accounts: enriched }));
      return;
    }

    const rows = enriched
      .map((row) => {
        const ok = row.status === "ok";
        const badge = ok
          ? '<span class="badge ok">Conectado</span>'
          : `<span class="badge err">Error</span>`;
        const tokenCell = ok
          ? `<code class="tok">${escapeHtml(row.access_token_preview)}</code>`
          : `<span class="err-msg">${escapeHtml(row.error)}</span>`;
        const caduca = ok ? escapeHtml(row.expiresAtIso) : "—";
        const seg = ok && row.secondsRemaining != null ? escapeHtml(row.secondsRemaining) : "—";
        const ck =
          row.cookies_web_stored === true
            ? '<span class="badge ok">Sí</span>'
            : '<span class="muted">No</span>';
        return `<tr>
  <td>${escapeHtml(row.ml_user_id)}</td>
  <td>${escapeHtml(row.nickname)}</td>
  <td>${badge}</td>
  <td>${tokenCell}</td>
  <td>${caduca}</td>
  <td>${seg}</td>
  <td>${ck}</td>
  <td class="muted">${escapeHtml(row.updated_at)}</td>
</tr>`;
      })
      .join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Cuentas Mercado Libre</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; max-width: 1100px; margin-top: 1rem; font-size: 0.9rem; }
    th, td { border: 1px solid #38444d; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #71767b; font-size: 0.85rem; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    .badge { display: inline-block; padding: 0.15rem 0.45rem; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
    .badge.ok { background: #003920; color: #00d395; }
    .badge.err { background: #3b1219; color: #f4212e; }
    .tok { font-size: 0.8rem; word-break: break-all; color: #c4cfda; }
    .err-msg { font-size: 0.8rem; color: #f4212e; word-break: break-word; }
  </style>
</head>
<body>
  <h1>Cuentas conectadas</h1>
  <p class="lead">${accounts.length} cuenta(s). Token en vista previa; refresh no se muestra.</p>
  <table>
    <thead><tr>
      <th>user_id</th><th>Nickname</th><th>Estado</th><th>Token (enmascarado)</th>
      <th>Caduca (UTC)</th><th>Seg. restantes</th><th>Cookies web (BD)</th><th>Actualizado (DB)</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="8">No hay cuentas registradas.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Webhooks guardados en PostgreSQL (misma clave ADMIN_SECRET que /cuentas). */
  if (req.method === "GET" && isHooksPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Hooks</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Hooks</title><p>Acceso denegado. Usa <code>/hooks?k=TU_CLAVE</code> (misma que <code>ADMIN_SECRET</code>).</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    let items;
    try {
      items = await listWebhooks(lim, 2000);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, count: items.length, items }));
      return;
    }
    const hookRows = items
      .map(
        (row) => `<tr>
  <td>${escapeHtml(row.id)}</td>
  <td class="muted">${escapeHtml(row.received_at)}</td>
  <td>${escapeHtml(row.topic)}</td>
  <td>${escapeHtml(row.resource)}</td>
</tr>`
      )
      .join("");
    const hooksHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Webhooks recibidos</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1200px; margin-top: 1rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.45rem 0.55rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Webhooks guardados</h1>
  <p class="lead">${items.length} registro(s), <strong>orden: más recientes primero</strong> (id descendente). Cada POST a <code>${WEBHOOK_PATH}</code> (y POST a <code>${REG_PATH}</code>) persiste en <code>webhook_events</code>. Parametro <code>limit</code> (max 2000). Cuerpo completo: <code>?format=json</code>.</p>
  <table>
    <thead><tr><th>id</th><th>Recibido</th><th>topic</th><th>resource</th></tr></thead>
    <tbody>${hookRows || '<tr><td colspan="4">No hay webhooks en la base.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(hooksHtml);
    return;
  }

  /** Eventos Wasender API guardados en PostgreSQL (misma clave ADMIN_SECRET que /hooks). */
  if (req.method === "GET" && isWasenderWebhooksPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Wasender webhooks</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Wasender webhooks</title><p>Acceso denegado. Usa <code>/wasender-webhooks?k=…</code>.</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    let items;
    try {
      items = await listWasenderWebhookEvents(lim, 2000);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, count: items.length, items }));
      return;
    }
    const hookRows = items
      .map((row) => {
        const preview = JSON.stringify(row.data).slice(0, 320);
        return `<tr>
  <td>${escapeHtml(row.id)}</td>
  <td class="muted">${escapeHtml(row.received_at)}</td>
  <td>${escapeHtml(row.event)}</td>
  <td>${row.signature_ok === null ? "—" : row.signature_ok ? "sí" : "no"}</td>
  <td><pre class="payload">${escapeHtml(preview)}${preview.length >= 320 ? "…" : ""}</pre></td>
</tr>`;
      })
      .join("");
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Wasender webhooks</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    ul.potential { color: #8b98a5; font-size: 0.82rem; max-width: 900px; line-height: 1.45; }
    table { border-collapse: collapse; width: 100%; max-width: 1400px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.8rem; }
    pre.payload { margin: 0; max-height: 100px; overflow: auto; font-size: 0.72rem; white-space: pre-wrap; word-break: break-word; color: #c4cfda; }
  </style>
</head>
<body>
  <h1>Webhooks Wasender API</h1>
  <p class="lead">${items.length} registro(s). <strong>Wasender</strong> puede entrar por el mismo <code>${escapeHtml(
      WEBHOOK_PATH
    )}</code> que Mercado Libre (JSON con <code>event</code>, sin <code>topic</code>/<code>resource</code> ML) o por rutas dedicadas: <code>${escapeHtml(
      Array.from(getWasenderWebhookPostPaths()).join(", ")
    )}</code>. Tabla <code>wasender_webhook_events</code>. NDJSON: <code>wasender-webhook.log</code>. Firma: env <code>WASENDER_WEBHOOK_SECRET</code> o <code>WASENDER_X_WEBHOOK_SIGNATURE</code> (mismo valor que el Webhook Secret del panel) → cabecera <code>X-Webhook-Signature</code>.</p>
  <p class="lead"><strong>Qué permite tener los hooks (según documentación Wasender):</strong></p>
  <ul class="potential">
    <li><strong>Mensajes</strong> — entrantes/salientes (<code>messages.received</code>, <code>messages.upsert</code>), <strong>estados</strong> entregado/leído (<code>messages.update</code>), borrados, reacciones; enlazar con <code>msgId</code> de envíos API.</li>
    <li><strong>Sesión</strong> — conexión/desconexión, QR renovado; alertar si el número deja de estar enlazado.</li>
    <li><strong>Chats / contactos / grupos</strong> — altas, mute, participantes (si aplica a tu flujo).</li>
    <li><strong>Uso práctico</strong> — confirmar entrega de tipo E/F, automatizar respuestas a texto entrante, métricas, evitar doble envío cuando el usuario ya respondió por WhatsApp.</li>
  </ul>
  <table>
    <thead><tr><th>id</th><th>Recibido</th><th>event</th><th>firma OK</th><th>payload (vista)</th></tr></thead>
    <tbody>${hookRows || '<tr><td colspan="5">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Respuestas GET a la API de ML guardadas (ml_topic_fetches); misma clave que /hooks. */
  if (req.method === "GET" && isFetchesPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Fetches</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Fetches</title><p>Acceso denegado. Usa <code>/fetches?k=TU_CLAVE</code> (misma que <code>ADMIN_SECRET</code>).</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const rawTopic = url.searchParams.get("topic");
    const topicFilter =
      rawTopic != null && String(rawTopic).trim() !== "" ? String(rawTopic).trim() : null;
    let topicsInDb = [];
    let rows;
    try {
      topicsInDb = await listDistinctFetchTopics();
      rows = await enrichNicknameForFetches(await listTopicFetches(lim, 2000, topicFilter));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      const items = rows.map((r) => ({
        id: r.id,
        ml_user_id: r.ml_user_id,
        nickname: r.nickname,
        topic: r.topic,
        resource: r.resource,
        request_path: r.request_path,
        http_status: r.http_status,
        fetched_at: r.fetched_at,
        notification_id: r.notification_id,
        sku: r.sku,
        title: r.title,
        error: r.error,
        process_status: r.process_status,
        data: r.payload ? tryParseJson(r.payload) : null,
      }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          topic_filter: topicFilter,
          topics_in_db: topicsInDb,
          count: items.length,
          items,
        })
      );
      return;
    }
    const kEnc = encodeURIComponent(adminSecret);
    const baseFetchesUrl = `/fetches?k=${kEnc}`;
    const topicFilterLinks = (() => {
      const parts = [`<a href="${baseFetchesUrl}">Todos los topics</a>`];
      for (const t of topicsInDb) {
        const active = topicFilter === t ? ' class="active"' : "";
        parts.push(
          `<a${active} href="${baseFetchesUrl}&topic=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`
        );
      }
      return parts.join(" · ");
    })();
    const tableRows = rows
      .map((r) => {
        const errCell = r.error ? `<span class="err">${escapeHtml(r.error.slice(0, 200))}</span>` : "—";
        const st = r.process_status != null && String(r.process_status).trim() !== ""
          ? escapeHtml(r.process_status)
          : "—";
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.fetched_at)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.nickname)}</td>
  <td>${escapeHtml(r.topic)}</td>
  <td>${escapeHtml(r.sku)}</td>
  <td>${escapeHtml(r.title)}</td>
  <td>${escapeHtml(r.request_path)}</td>
  <td>${escapeHtml(r.http_status)}</td>
  <td><strong>${st}</strong></td>
  <td>${errCell}</td>
</tr>`;
      })
      .join("");
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>ML topic fetches</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1200px; margin-top: 1rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.45rem 0.55rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.8rem; }
    .err { color: #f4212e; font-size: 0.8rem; word-break: break-word; }
    .topic-filters { margin-top: 0.75rem; font-size: 0.9rem; line-height: 1.6; }
    .topic-filters a { color: #1d9bf0; text-decoration: none; }
    .topic-filters a:hover { text-decoration: underline; }
    .topic-filters a.active { font-weight: 600; color: #e7e9ea; }
  </style>
</head>
<body>
  <h1>Respuestas API (ml_topic_fetches)</h1>
  <p class="lead">${rows.length} registro(s)${topicFilter ? ` · filtro: <code>${escapeHtml(topicFilter)}</code>` : ""}. Cuerpo JSON de la respuesta ML (payload): <code>?format=json</code>. <strong>estado</strong>: con topic <code>orders_v2</code>, tras el GET a ML puede quedar <code>Completado</code> o <code>Fallo post-venta</code>. Si el topic <strong>no</strong> es <code>orders_v2</code>, tras un fetch OK sigue <code>Procesando...</code>. Orden: <strong>id reciente primero</strong> (todos los topics mezclados; usa el filtro por topic para ver solo uno).</p>
  <p class="topic-filters">${topicFilterLinks}</p>
  <div style="overflow-x:auto; max-width:100%">
  <table>
    <thead><tr><th>id</th><th>fetched_at</th><th>user_id</th><th>nickname</th><th>topic</th><th>sku</th><th>title</th><th>request_path</th><th>http</th><th>estado</th><th>error</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="11">No hay fetches guardados.</td></tr>'}</tbody>
  </table>
  </div>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Compradores ML (ml_buyers); misma clave ADMIN_SECRET. */
  if (isBuyersPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    const authBuyers =
      adminSecret && (k === adminSecret || req.headers["x-admin-secret"] === adminSecret);

    if (req.method === "POST") {
      if (!adminSecret) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
        return;
      }
      if (!authBuyers) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
        return;
      }
      let body;
      try {
        body = normalizeBuyerIdForBuyers(unwrapJsonBodyIfNeeded(await parseJsonBody(req)));
      } catch (e) {
        buyersErrorJson(res, 400, {
          error: "body debe ser JSON",
          code: "JSON_BODY_INVALID",
          hint: "Cuerpo no es JSON válido (UTF-8). Revise comillas, comas y un solo objeto { ... }.",
        });
        return;
      }
      const buyerId = Number(body.buyer_id);
      if (!Number.isFinite(buyerId) || buyerId <= 0) {
        buyersErrorJson(res, 400, {
          error: "buyer_id inválido",
          ...explainInvalidBuyerId(body),
        });
        return;
      }
      const nickRaw = body.nickname != null ? String(body.nickname).trim() : "";
      const p1Raw = body.phone_1 != null ? String(body.phone_1).trim() : "";
      const p2Raw = body.phone_2 != null ? String(body.phone_2).trim() : "";
      const row = {
        buyer_id: buyerId,
        nickname: nickRaw === "" ? null : nickRaw,
        phone_1: p1Raw === "" ? null : p1Raw,
        phone_2: p2Raw === "" ? null : p2Raw,
      };
      if (Object.prototype.hasOwnProperty.call(body, "nombre_apellido")) {
        row.nombre_apellido = normalizeNombreApellido(body.nombre_apellido);
      }
      let needPrefClear = false;
      if (Object.prototype.hasOwnProperty.call(body, "pref_entrega")) {
        if (body.pref_entrega === null || String(body.pref_entrega).trim() === "") {
          needPrefClear = true;
        } else {
          const pe = normalizeBuyerPrefEntrega(body.pref_entrega);
          if (!pe) {
            buyersErrorJson(res, 400, {
              error: `pref_entrega debe ser uno de: ${BUYER_PREF_ENTREGA_VALUES.join(", ")}`,
              code: "PREF_ENTREGA_INVALID",
              hint: "Valores: Pickup, Envio Courier, Delivery. Sinónimos: RETIRO→Pickup (si el servidor está actualizado).",
              debug: { recibido: String(body.pref_entrega).slice(0, 80) },
            });
            return;
          }
          row.pref_entrega = pe;
        }
      }
      let needCambioClear = false;
      if (Object.prototype.hasOwnProperty.call(body, "cambio_datos")) {
        if (body.cambio_datos === null || String(body.cambio_datos).trim() === "") {
          needCambioClear = true;
        } else {
          row.cambio_datos = normalizeCambioDatos(body.cambio_datos);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "observaciones")) {
        row.observaciones =
          body.observaciones === null || String(body.observaciones).trim() === ""
            ? null
            : normalizeBuyerObservaciones(body.observaciones);
      }
      try {
        await upsertMlBuyer(row);
        if (needPrefClear) await updateMlBuyerPhones(buyerId, { pref_entrega: null });
        if (needCambioClear) await updateMlBuyerPhones(buyerId, { cambio_datos: null });
        const buyer = await getMlBuyer(buyerId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, buyer }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "PUT") {
      if (!adminSecret) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
        return;
      }
      if (!authBuyers) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
        return;
      }
      let body;
      try {
        body = normalizeBuyerIdForBuyers(unwrapJsonBodyIfNeeded(await parseJsonBody(req)));
      } catch (e) {
        buyersErrorJson(res, 400, {
          error: "body debe ser JSON",
          code: "JSON_BODY_INVALID",
          hint: "Cuerpo no es JSON válido (UTF-8). Revise comillas, comas y un solo objeto { ... }.",
        });
        return;
      }
      const buyerId = Number(body.buyer_id);
      if (!Number.isFinite(buyerId) || buyerId <= 0) {
        buyersErrorJson(res, 400, {
          error: "buyer_id inválido",
          ...explainInvalidBuyerId(body),
        });
        return;
      }
      const patch = {
        phone_1: body.phone_1,
        phone_2: body.phone_2,
      };
      if (body.pref_entrega !== undefined) {
        if (body.pref_entrega === null || String(body.pref_entrega).trim() === "") {
          patch.pref_entrega = null;
        } else {
          const pe = normalizeBuyerPrefEntrega(body.pref_entrega);
          if (!pe) {
            buyersErrorJson(res, 400, {
              error: `pref_entrega debe ser uno de: ${BUYER_PREF_ENTREGA_VALUES.join(", ")}`,
              code: "PREF_ENTREGA_INVALID",
              hint: "Valores: Pickup, Envio Courier, Delivery. Sinónimos: RETIRO→Pickup (si el servidor está actualizado).",
              debug: { recibido: String(body.pref_entrega).slice(0, 80) },
            });
            return;
          }
          patch.pref_entrega = pe;
        }
      }
      if (body.cambio_datos !== undefined) {
        if (body.cambio_datos === null || String(body.cambio_datos).trim() === "") {
          patch.cambio_datos = null;
        } else {
          patch.cambio_datos = normalizeCambioDatos(body.cambio_datos);
        }
      }
      if (body.nombre_apellido !== undefined) {
        patch.nombre_apellido =
          body.nombre_apellido === null || String(body.nombre_apellido).trim() === ""
            ? null
            : normalizeNombreApellido(body.nombre_apellido);
      }
      if (body.observaciones !== undefined) {
        if (body.observaciones === null || String(body.observaciones).trim() === "") {
          patch.observaciones = null;
        } else {
          patch.observaciones = normalizeBuyerObservaciones(body.observaciones);
        }
      }
      try {
        const buyer = await updateMlBuyerPhones(buyerId, patch);
        if (!buyer) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "buyer_id no encontrado" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, buyer }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "método no permitido" }));
      return;
    }

    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Buyers</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Buyers</title><p>Acceso denegado. Usa <code>/buyers?k=TU_CLAVE</code> (misma que <code>ADMIN_SECRET</code>).</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    let rows;
    let totalEnTabla;
    try {
      [rows, totalEnTabla] = await Promise.all([listMlBuyers(lim, 2000), countMlBuyers()]);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          total: totalEnTabla,
          count: rows.length,
          items: rows,
        })
      );
      return;
    }
    const buyerRows = rows
      .map(
        (r) => {
          const cdRaw = r.cambio_datos != null ? String(r.cambio_datos) : "";
          const cdShort =
            cdRaw.length > 120 ? `${escapeHtml(cdRaw.slice(0, 120))}…` : escapeHtml(cdRaw);
          const obsRaw = r.observaciones != null ? String(r.observaciones) : "";
          const obsShort =
            obsRaw.length > 160 ? `${escapeHtml(obsRaw.slice(0, 160))}…` : escapeHtml(obsRaw);
          return `<tr>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.nickname)}</td>
  <td>${escapeHtml(r.nombre_apellido)}</td>
  <td>${escapeHtml(r.phone_1)}</td>
  <td>${escapeHtml(r.phone_2)}</td>
  <td>${escapeHtml(r.pref_entrega)}</td>
  <td class="muted" style="max-width:280px;white-space:pre-wrap;word-break:break-word;">${cdShort || "—"}</td>
  <td class="muted" style="max-width:320px;white-space:pre-wrap;word-break:break-word;" title="Notas operativas (delivery, WhatsApp/JID, etc.)">${obsShort || "—"}</td>
  <td class="muted">${escapeHtml(r.actualizacion)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td class="muted">${escapeHtml(r.updated_at)}</td>
</tr>`;
        }
      )
      .join("");
    const buyersHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>ML buyers</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1280px; margin-top: 1rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.45rem 0.55rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Compradores (ml_buyers)</h1>
  <p class="lead"><strong>${totalEnTabla}</strong> fila(s) en total en la tabla. Mostrando <strong>${rows.length}</strong> en esta vista (orden por última actualización; <code>?limit=</code> hasta 2000). <code>pref_entrega</code> por defecto <code>Pickup</code> si no viene en el webhook. <code>observaciones</code>: notas (zona delivery, errores WhatsApp/JID, etc.). POST/PUT JSON <code>observaciones</code>. <code>actualizacion</code> = última modificación (ISO). JSON: <code>?format=json</code> incluye <code>total</code> y <code>count</code> (filas devueltas).</p>
  <table>
    <thead><tr><th>buyer_id</th><th>nickname</th><th>nombre y apellido</th><th>phone_1</th><th>phone_2</th><th>pref_entrega</th><th>cambio_datos</th><th>observaciones</th><th>actualizacion</th><th>created_at</th><th>updated_at</th></tr></thead>
    <tbody>${buyerRows || '<tr><td colspan="11">No hay compradores guardados.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buyersHtml);
    return;
  }

  /** Inventario `productos` (Solomotor3k / repuestos; atributos JSONB; item_id_ml opcional = id ítem ML). */
  if (isInventarioProductosPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    const authInv = adminSecret && (k === adminSecret || req.headers["x-admin-secret"] === adminSecret);

    if (req.method === "POST") {
      if (!adminSecret) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
        return;
      }
      if (!authInv) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
        return;
      }
      let body;
      try {
        body = unwrapJsonBodyIfNeeded(await parseJsonBody(req));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const upsert = url.searchParams.get("upsert") === "1" || url.searchParams.get("upsert") === "true";
      try {
        const row = upsert ? await upsertProductoBySku(body) : await insertProducto(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, producto: enrichProductoConImagenesUrls(row) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
      return;
    }

    if (req.method === "PUT") {
      if (!adminSecret) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
        return;
      }
      if (!authInv) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
        return;
      }
      let body;
      try {
        body = unwrapJsonBodyIfNeeded(await parseJsonBody(req));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const id = Number(body.id != null ? body.id : url.searchParams.get("id"));
      if (!Number.isFinite(id) || id <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "id inválido (body.id o ?id=)" }));
        return;
      }
      try {
        const row = await updateProducto(id, body);
        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "producto no encontrado" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, producto: enrichProductoConImagenesUrls(row) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
      return;
    }

    if (req.method === "DELETE") {
      if (!adminSecret) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
        return;
      }
      if (!authInv) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
        return;
      }
      const id = Number(url.searchParams.get("id"));
      if (!Number.isFinite(id) || id <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?id=NUMERO" }));
        return;
      }
      try {
        const deleted = await deleteProducto(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted: deleted > 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "método no permitido" }));
      return;
    }

    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Inventario</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Inventario</title><p>Acceso denegado. <code>/inventario-productos?k=…</code></p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    let rows;
    let totalEnTabla;
    try {
      [rows, totalEnTabla] = await Promise.all([listProductos(lim, 5000), countProductos()]);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          total: totalEnTabla,
          count: rows.length,
          items: rows.map((r) => enrichProductoConImagenesUrls(r)),
        })
      );
      return;
    }
    const prodRows = rows
      .map((r) => {
        const codProd = r.cod_producto != null ? r.cod_producto : r.cod_marca_proveedor;
        let attrPreview = "—";
        try {
          const s = JSON.stringify(r.atributos);
          attrPreview =
            s.length > 100 ? `${escapeHtml(s.slice(0, 100))}…` : escapeHtml(s);
        } catch {
          attrPreview = "—";
        }
        let urlsPreview = "—";
        try {
          const u = JSON.stringify(r.urls != null ? r.urls : {});
          urlsPreview = u.length > 80 ? `${escapeHtml(u.slice(0, 80))}…` : escapeHtml(u);
        } catch {
          urlsPreview = "—";
        }
        const appExt =
          r.aplicacion_extendida != null
            ? escapeHtml(
                String(r.aplicacion_extendida).length > 120
                  ? `${String(r.aplicacion_extendida).slice(0, 120)}…`
                  : String(r.aplicacion_extendida)
              )
            : "—";
        const imgN = r.imagenes_cantidad != null ? Number(r.imagenes_cantidad) : 0;
        const imgUrls = buildProductoImagenesUrls(r.sku, imgN);
        const imgCell =
          imgUrls.length > 0
            ? `${escapeHtml(String(imgN))} · <a href="${escapeAttr(imgUrls[0])}" target="_blank" rel="noopener noreferrer" class="muted">1ª</a>`
            : escapeHtml(String(imgN));
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td>${escapeHtml(r.sku)}</td>
  <td>${escapeHtml(codProd)}</td>
  <td>${escapeHtml(r.marca_producto)}</td>
  <td>${escapeHtml(r.proveedor)}</td>
  <td class="muted" style="max-width:220px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(r.descripcion)}</td>
  <td class="muted" style="max-width:200px;font-size:0.78rem;white-space:pre-wrap;word-break:break-word;">${appExt}</td>
  <td>${escapeHtml(r.ubicacion)}</td>
  <td class="muted" style="font-size:0.72rem;">${imgCell}</td>
  <td>${escapeHtml(r.stock)}</td>
  <td>${escapeHtml(r.precio_usd)}</td>
  <td>${escapeHtml(r.oem)}</td>
  <td>${escapeHtml(r.ref_1)}</td>
  <td>${escapeHtml(r.ref_2)}</td>
  <td>${escapeHtml(r.ref_3)}</td>
  <td class="muted" style="max-width:200px;font-size:0.75rem;">${attrPreview}</td>
  <td class="muted" style="max-width:160px;font-size:0.72rem;">${urlsPreview}</td>
  <td>${escapeHtml(r.item_id_ml)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td class="muted">${escapeHtml(r.updated_at)}</td>
</tr>`;
      })
      .join("");
    const invHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Inventario productos</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.85rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1400px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.4rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.72rem; }
    code { font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>Inventario (productos)</h1>
  <p class="lead"><strong>${totalEnTabla}</strong> en tabla · mostrando <strong>${rows.length}</strong>. Imágenes: <code>imagenes_cantidad</code> (0–9) + env <code>PRODUCT_IMAGE_BASE_URL</code> → <code>{base}/{sku}_{1..n}.webp</code>. <code>urls</code> JSON opcional (ml, web). ML: <code>item_id_ml</code>. JSON: <code>?format=json</code> incluye <code>imagenes_urls</code>. POST / PUT / upsert.</p>
  <table>
    <thead><tr><th>id</th><th>sku</th><th>cod_producto</th><th>marca_producto</th><th>proveedor</th><th>descripcion</th><th>aplicacion_extendida</th><th>ubicacion</th><th>imagenes</th><th>stock</th><th>precio_usd</th><th>oem</th><th>ref_1</th><th>ref_2</th><th>ref_3</th><th>atributos</th><th>urls</th><th>item_id_ml</th><th>created_at</th><th>updated_at</th></tr></thead>
    <tbody>${prodRows || '<tr><td colspan="20">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(invHtml);
    return;
  }

  /** Plantillas de mensajes post-venta (post_sale_messages). */
  if (isPostSaleMessagesPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Mensajes</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Mensajes</title><p>Acceso denegado. Usa <code>/mensajes-postventa?k=TU_CLAVE</code>.</p>"
      );
      return;
    }

    if (req.method === "DELETE") {
      const id = Number(url.searchParams.get("id"));
      if (!Number.isFinite(id) || id <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?id=NUMERO" }));
        return;
      }
      try {
        const deleted = await deletePostSaleMessage(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted: deleted > 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      try {
        if (body.id != null && body.id !== "") {
          const id = Number(body.id);
          if (!Number.isFinite(id) || id <= 0) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "id invalido" }));
            return;
          }
          const ch = await updatePostSaleMessage(id, { name: body.name, body: body.body });
          if (ch === 0) {
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "no encontrado" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, id }));
          return;
        }
        const newId = await insertPostSaleMessage({ name: body.name, body: body.body });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, id: newId }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET") {
      let rows;
      try {
        rows = await listPostSaleMessages();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
        return;
      }
      if (url.searchParams.get("format") === "json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, count: rows.length, items: rows }));
        return;
      }
      const html = renderPostSaleMessagesPage(rows, {
        escapeHtml,
        escapeAttr,
        escapeTextareaContent,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  /** Configuración mensajes WhatsApp tipo E (`ml_whatsapp_tipo_e_config`). */
  if (isWhatsappTipoEConfigPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Tipo E WhatsApp</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Tipo E WhatsApp</title><p>Acceso denegado. Usa <code>/mensajes-tipo-e-whatsapp?k=TU_CLAVE</code>.</p>"
      );
      return;
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      try {
        await upsertMlWhatsappTipoEConfig(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET") {
      let row;
      try {
        row = await getMlWhatsappTipoEConfig();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
        return;
      }
      if (url.searchParams.get("format") === "json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, config: row }));
        return;
      }
      const html = renderWhatsappTipoEPage(row, {
        escapeHtml,
        escapeAttr,
        escapeTextareaContent,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  /** Configuración mensajes WhatsApp tipo F (`ml_whatsapp_tipo_f_config`). */
  if (isWhatsappTipoFConfigPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Tipo F WhatsApp</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Tipo F WhatsApp</title><p>Acceso denegado. Usa <code>/mensajes-tipo-f-whatsapp?k=TU_CLAVE</code>.</p>"
      );
      return;
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      try {
        await upsertMlWhatsappTipoFConfig(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET") {
      let row;
      try {
        row = await getMlWhatsappTipoFConfig();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
        return;
      }
      if (url.searchParams.get("format") === "json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, config: row }));
        return;
      }
      const html = renderWhatsappTipoFPage(row, {
        escapeHtml,
        escapeAttr,
        escapeTextareaContent,
      }, { k });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  /** Reintento manual de envío post-venta (misma lógica que el webhook). */
  if (req.method === "POST" && url.pathname === "/envios-postventa/retry") {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret || k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
      return;
    }
    const mlUserId = Number(body.ml_user_id);
    const orderId = Number(body.order_id);
    const buyerIdRaw = body.buyer_id;
    const buyerId =
      buyerIdRaw != null && String(buyerIdRaw).trim() !== ""
        ? Number(buyerIdRaw)
        : null;
    const force = body.force === true || body.force === "1";
    const topic =
      body.topic && String(body.topic).trim()
        ? String(body.topic).trim()
        : "orders_v2";
    if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "ml_user_id y order_id numéricos requeridos" }));
      return;
    }
    if (force) {
      await deletePostSaleSent(orderId);
    }
    const retryPayload =
      buyerId != null && Number.isFinite(buyerId) && buyerId > 0
        ? { id: orderId, buyer: { id: buyerId } }
        : { id: orderId };
    try {
      const result = await trySendDefaultPostSaleMessage({
        mlUserId,
        topic,
        payload: retryPayload,
        notificationId: "manual-retry",
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Prueba manual: GET detalle ventas .ve con cookies y guarda en ml_ventas_detalle_web. */
  if (req.method === "POST" && url.pathname === "/ventas-detalle-web/retry") {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret || k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
      return;
    }
    const mlUserId = Number(body.ml_user_id);
    const orderId = Number(body.order_id);
    const buyerId =
      body.buyer_id != null && Number.isFinite(Number(body.buyer_id)) && Number(body.buyer_id) > 0
        ? Number(body.buyer_id)
        : undefined;
    if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "ml_user_id y order_id numéricos requeridos" }));
      return;
    }
    try {
      const writeLog =
        body.write_log === true ||
        body.write_log === 1 ||
        String(body.write_log || "").toLowerCase() === "true";
      const result = await fetchVentasDetalleAndStore({ mlUserId, orderId, buyerId, writeLog });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Sincronizar una pregunta con GET /questions/{id} (p. ej. ya respondida en ML y pending obsoleto). */
  if (req.method === "GET" && isPreguntasMlRefreshPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    const mq = url.searchParams.get("ml_question_id") || url.searchParams.get("question_id");
    const mu = url.searchParams.get("ml_user_id") || url.searchParams.get("user_id");
    try {
      const out = await refreshMlQuestionFromApi({
        mlQuestionId: mq,
        mlUserId: mu != null && String(mu).trim() !== "" ? mu : null,
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Sincronizar todas las filas pending con la API (answered en ML → salen de pending). */
  if (req.method === "GET" && isPreguntasMlSyncPendingPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    const limRaw = url.searchParams.get("limit");
    const limNum = limRaw != null && String(limRaw).trim() !== "" ? Number(limRaw) : 50;
    try {
      const out = await syncAllPendingQuestionsFromApi({ limit: limNum });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Preguntas ML: tablas ml_questions_pending y ml_questions_answered. */
  if (req.method === "GET" && isPreguntasMlPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Preguntas ML</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Preguntas ML</title><p>Acceso denegado. Usa <code>/preguntas-ml?k=TU_CLAVE</code>.</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const tablaRaw = (url.searchParams.get("tabla") || "pending").toLowerCase();
    const tabla = tablaRaw === "answered" ? "answered" : "pending";
    let rows;
    try {
      rows =
        tabla === "answered"
          ? await listMlQuestionsAnswered(lim, 2000)
          : await listMlQuestionsPending(lim, 2000);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    const kForLinks = k;
    const limForLinks = lim && String(lim).trim() !== "" ? String(lim) : "";
    function preguntasMlQuery(tablaKey) {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      if (limForLinks) p.set("limit", limForLinks);
      if (tablaKey !== "pending") p.set("tabla", tablaKey);
      return `/preguntas-ml?${p.toString()}`;
    }
    function preguntasMlSyncPendingUrl() {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      p.set("limit", limForLinks || "100");
      return `/preguntas-ml-sync-pending?${p.toString()}`;
    }
    function preguntasMlIaRetryUrl() {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      p.set("limit", "50");
      return `/preguntas-ia-auto-retry?${p.toString()}`;
    }
    function preguntasMlIaStatusUrl() {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      return `/preguntas-ia-auto-status?${p.toString()}`;
    }
    function preguntasMlIaLogUrl() {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      p.set("format", "json");
      p.set("limit", "80");
      return `/preguntas-ia-auto-log?${p.toString()}`;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, tabla, count: rows.length, items: rows }));
      return;
    }
    const navPending = tabla === "pending" ? "active" : "";
    const navAnswered = tabla === "answered" ? "active" : "";
    const tableHead =
      tabla === "answered"
        ? "<thead><tr><th>id</th><th>ml_question_id</th><th>user_id</th><th>item_id</th><th>buyer_id</th><th>phone_1</th><th>phone_2</th><th>pregunta</th><th>respuesta</th><th>status</th><th>date_created</th><th>Δs</th><th>answered_at</th></tr></thead>"
        : "<thead><tr><th>id</th><th>ml_question_id</th><th>user_id</th><th>item_id</th><th>buyer_id</th><th>phone_1</th><th>phone_2</th><th>pregunta</th><th>status</th><th>tipo F WhatsApp</th><th>date_created</th><th>updated_at</th><th>ia_auto_route_detail</th></tr></thead>";
    function buyerPhoneCell(val) {
      if (val == null || String(val).trim() === "") return "—";
      return escapeHtml(String(val));
    }
    const tableRows =
      rows.length === 0
        ? `<tr><td colspan="13">Sin registros.</td></tr>`
        : tabla === "answered"
          ? rows
              .map((r) => {
                const qt =
                  r.question_text && String(r.question_text).length > 120
                    ? `${escapeHtml(String(r.question_text).slice(0, 120))}…`
                    : escapeHtml(r.question_text);
                const at =
                  r.answer_text && String(r.answer_text).length > 80
                    ? `${escapeHtml(String(r.answer_text).slice(0, 80))}…`
                    : escapeHtml(r.answer_text);
                const dts =
                  r.response_time_sec != null && String(r.response_time_sec).trim() !== ""
                    ? escapeHtml(String(r.response_time_sec))
                    : "—";
                const qdc =
                  r.date_created != null && String(r.date_created).trim() !== ""
                    ? escapeHtml(String(r.date_created))
                    : "—";
                return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td>${escapeHtml(r.ml_question_id)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.item_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td class="muted mono">${buyerPhoneCell(r.buyer_phone_1)}</td>
  <td class="muted mono">${buyerPhoneCell(r.buyer_phone_2)}</td>
  <td class="muted">${qt}</td>
  <td class="muted">${at}</td>
  <td>${escapeHtml(r.ml_status)}</td>
  <td class="muted" title="date_created de la pregunta (API ML)">${qdc}</td>
  <td class="muted" title="segundos entre date_created pregunta y respuesta (API ML)">${dts}</td>
  <td class="muted">${escapeHtml(r.answered_at)}</td>
</tr>`;
              })
              .join("")
          : rows
              .map((r) => {
                const qt =
                  r.question_text && String(r.question_text).length > 120
                    ? `${escapeHtml(String(r.question_text).slice(0, 120))}…`
                    : escapeHtml(r.question_text);
                const qdcP =
                  r.date_created != null && String(r.date_created).trim() !== ""
                    ? escapeHtml(String(r.date_created))
                    : "—";
                const rawIa = r.ia_auto_route_detail != null ? String(r.ia_auto_route_detail) : "";
                const iaPreview =
                  rawIa.trim() !== ""
                    ? `${escapeHtml(rawIa.length > 140 ? `${rawIa.slice(0, 140)}…` : rawIa)}`
                    : "—";
                const wf =
                  r.whatsapp_tipo_f === "enviado"
                    ? '<span title="Hay envío tipo F con éxito en ml_whatsapp_wasender_log">enviado</span>'
                    : '<span title="Aún no hay envío tipo F con éxito">pendiente</span>';
                return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td>${escapeHtml(r.ml_question_id)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.item_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td class="muted mono">${buyerPhoneCell(r.buyer_phone_1)}</td>
  <td class="muted mono">${buyerPhoneCell(r.buyer_phone_2)}</td>
  <td class="muted">${qt}</td>
  <td>${escapeHtml(r.ml_status)}</td>
  <td class="muted">${wf}</td>
  <td class="muted" title="date_created de la pregunta (API ML)">${qdcP}</td>
  <td class="muted">${escapeHtml(r.updated_at)}</td>
  <td class="muted mono" title="${escapeAttr(rawIa)}">${iaPreview}</td>
</tr>`;
              })
              .join("");
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Preguntas ML</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1rem; }
    .lead { color: #8b98a5; font-size: 0.95rem; }
    a { color: #1d9bf0; }
    a.active { font-weight: 600; text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    .muted { color: #8b98a5; max-width: 28rem; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.75rem; max-width: 36rem; word-break: break-word; }
  </style>
</head>
<body>
  <h1>Preguntas Mercado Libre</h1>
  <p class="lead">Tabla <code>${tabla === "answered" ? "ml_questions_answered" : "ml_questions_pending"}</code> · ${rows.length} fila(s). JSON: <code>?format=json</code> · <code>?tabla=pending</code> o <code>?tabla=answered</code></p>
  ${
    tabla === "pending"
      ? `<p class="lead"><strong>Cómo funciona (3 pasos):</strong> (1) webhook <code>questions</code> + GET del recurso. (2) Si UNANSWERED y <code>ML_QUESTIONS_IA_AUTO_ENABLED=1</code> → intento inmediato <code>POST /answers</code> (plantilla aleatoria); si no o si falla el envío → pending. (3) Si la pregunta queda respondida en ML → fila en <code>ml_questions_answered</code> y se borra de pending. Con <code>ML_WEBHOOK_FETCH_RESOURCE=1</code> y automático activo se intenta <code>POST /answers</code> sin depender de horario. La columna <code>ia_auto_route_detail</code> documenta por qué sigue en pending. WhatsApp tipo F (Wasender): <code>ML_WHATSAPP_TIPO_F_ENABLED=1</code> + <code>WASENDER_*</code>; ver <code>ml-whatsapp-tipo-ef.js</code>.</p>
  <p class="lead">Para <strong>borrar todas las filas pending</strong> en esta base (solo copia local; las preguntas siguen en ML): <code>DELETE /admin/ml-questions-pending</code> con cabecera <code>X-Admin-Secret</code> (mismo valor que variable de entorno).</p>
  <p class="lead">Si en Mercado Libre ya está <strong>respondida</strong> y aquí sigue en pending: la BD está desactualizada. <a href="${escapeAttr(preguntasMlSyncPendingUrl())}">Sincronizar pending con la API</a> (JSON; recargá esta página después).</p>
  <p class="lead">Si <strong>no</strong> responde automático: en el servidor (p. ej. Render) tenés que definir las mismas variables que <code>ML_QUESTIONS_IA_AUTO_*</code> y <code>ML_WEBHOOK_FETCH_RESOURCE=1</code> que en tu <code>oauth-env.json</code> local. <a href="${escapeAttr(preguntasMlIaStatusUrl())}">Estado IA (modo / prueba)</a> · <a href="${escapeAttr(preguntasMlIaRetryUrl())}">Reintentar POST /answers sobre pending</a> · <a href="${escapeAttr(preguntasMlIaLogUrl())}">Log (errores API / excepciones)</a>. Las reglas IA son <strong>globales</strong> para todo el servidor; cada fila usa el <code>user_id</code> del <strong>vendedor</strong> de esa notificación (multicuenta). Cada vendedor debe tener token en <code>ml_accounts</code>; si el número no coincide o falta la cuenta, el POST falla para esa pregunta.</p>`
      : ""
  }
  <p><a href="${escapeAttr(preguntasMlQuery("pending"))}" class="${navPending}">Por responder (pending)</a>
     · <a href="${escapeAttr(preguntasMlQuery("answered"))}" class="${navAnswered}">Respondidas (answered)</a></p>
  <table>
    ${tableHead}
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Log: respuesta IA automática omitida o error. Tabla ml_questions_ia_auto_log. */
  if (req.method === "GET" && isPreguntasIaAutoLogPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Log IA auto preguntas</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Log IA auto preguntas</title><p>Acceso denegado. Usa <code>/preguntas-ia-auto-log?k=TU_CLAVE</code>.</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    let rows;
    try {
      rows = await listMlQuestionsIaAutoLog(lim, 2000);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, count: rows.length, items: rows }));
      return;
    }
    const tableRows =
      rows.length === 0
        ? '<tr><td colspan="9">Sin registros.</td></tr>'
        : rows
            .map((r) => {
              const rd =
                r.reason_detail != null && String(r.reason_detail).length > 160
                  ? `${escapeHtml(String(r.reason_detail).slice(0, 160))}…`
                  : escapeHtml(r.reason_detail);
              const rdTitle =
                r.reason_detail != null && String(r.reason_detail).length > 160
                  ? escapeAttr(String(r.reason_detail))
                  : "";
              return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.ml_question_id)}</td>
  <td>${escapeHtml(r.item_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.outcome)}</td>
  <td class="muted" title="${rdTitle}">${rd}</td>
  <td class="muted">${escapeHtml(r.notification_id)}</td>
</tr>`;
            })
            .join("");
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Log IA auto (preguntas)</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1rem; }
    .lead { color: #8b98a5; font-size: 0.95rem; }
    a { color: #1d9bf0; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    .muted { color: #8b98a5; max-width: 36rem; }
  </style>
</head>
<body>
  <h1>Log respuestas IA automáticas (omitidas)</h1>
  <p class="lead">Tabla <code>ml_questions_ia_auto_log</code> · ${rows.length} fila(s). JSON: <code>?format=json</code> · <code>?limit=200</code></p>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>ml_user_id</th><th>ml_question_id</th><th>item_id</th><th>buyer_id</th><th>outcome</th><th>reason_detail</th><th>notification_id</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Estado IA preguntas: modo manual/automático, hora local, env y texto para prueba. */
  if (req.method === "GET" && isPreguntasIaAutoStatusPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    try {
      const body = getQuestionsIaAutoDiagnostics();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Reintenta respuesta IA para pending (cron dentro de la ventana). */
  if (req.method === "GET" && isPreguntasIaAutoRetryPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "define ADMIN_SECRET en el servidor" }));
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
      return;
    }
    const limRaw = url.searchParams.get("limit");
    const limNum = limRaw != null && String(limRaw).trim() !== "" ? Number(limRaw) : 50;
    try {
      const out = await retryPendingQuestionsIaAuto({ limit: limNum });
      const diag = getQuestionsIaAutoDiagnostics();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ...out,
          al_momento: {
            modo: diag.modo,
            modo_confirmacion: diag.modo_confirmacion,
            prueba: diag.prueba,
            evaluation: diag.evaluation,
          },
        })
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Publicaciones ML: ml_listings + ml_listing_sync_state (multicuenta). */
  if (req.method === "GET" && isPublicacionesMlPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Publicaciones ML</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Publicaciones ML</title><p>Acceso denegado. Usa <code>/publicaciones-ml?k=TU_CLAVE</code>.</p>"
      );
      return;
    }
    const limRaw = url.searchParams.get("limit");
    const limNum = Math.min(
      10000,
      Math.max(1, Number(limRaw) || 500)
    );
    const cuentaRaw = url.searchParams.get("cuenta");
    const cuentaFilter =
      cuentaRaw != null && String(cuentaRaw).trim() !== ""
        ? Number(String(cuentaRaw).trim())
        : null;
    const useCuenta =
      cuentaFilter != null && Number.isFinite(cuentaFilter) && cuentaFilter > 0
        ? cuentaFilter
        : null;
    const statusRaw = url.searchParams.get("status");
    const statusFilter =
      statusRaw != null && String(statusRaw).trim() !== ""
        ? String(statusRaw).trim()
        : null;
    const listOpts = statusFilter ? { status: statusFilter } : {};

    let accounts;
    let counts;
    let syncStates;
    let listings;
    try {
      accounts = await listMlAccounts();
      counts = await listMlListingCountsByUser();
      syncStates = await listMlListingSyncStatesAll();
      listings = useCuenta
        ? await listMlListingsByUser(useCuenta, limNum, 10000, listOpts)
        : await listMlListingsAll(limNum, 10000, listOpts);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }

    const countMap = new Map(
      counts.map((c) => [Number(c.ml_user_id), Number(c.total)])
    );
    const nickByUser = new Map(
      accounts.map((a) => [Number(a.ml_user_id), a.nickname != null ? String(a.nickname) : ""])
    );

    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          cuenta_filter: useCuenta,
          status_filter: statusFilter,
          limit: limNum,
          accounts,
          counts_by_user: counts,
          sync_states: syncStates,
          listings_count: listings.length,
          listings,
        })
      );
      return;
    }

    const kForLinks = k;
    function pubQuery(extra = {}) {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      p.set("limit", String(limNum));
      const cuenta =
        extra.cuenta !== undefined ? extra.cuenta : useCuenta;
      if (cuenta != null && Number.isFinite(Number(cuenta)) && Number(cuenta) > 0) {
        p.set("cuenta", String(cuenta));
      }
      const st =
        extra.status !== undefined ? extra.status : statusFilter;
      if (st != null && String(st).trim() !== "") {
        p.set("status", String(st).trim());
      }
      return `/publicaciones-ml?${p.toString()}`;
    }

    const summaryRows = accounts
      .map((a) => {
        const uid = Number(a.ml_user_id);
        const n = countMap.get(uid) ?? 0;
        const nick = nickByUser.get(uid) || "—";
        const active = useCuenta === uid ? "active" : "";
        const link = pubQuery({ cuenta: uid });
        return `<tr>
  <td>${escapeHtml(uid)}</td>
  <td class="muted">${escapeHtml(nick)}</td>
  <td>${escapeHtml(n)}</td>
  <td><a href="${escapeAttr(link)}" class="${active}">Ver solo esta cuenta</a></td>
</tr>`;
      })
      .join("");

    const syncRows =
      syncStates.length === 0
        ? `<tr><td colspan="6">Sin filas en <code>ml_listing_sync_state</code> (el job de descarga aún no ha guardado progreso por cuenta).</td></tr>`
        : syncStates
            .map((s) => {
              return `<tr>
  <td>${escapeHtml(s.ml_user_id)}</td>
  <td class="muted">${escapeHtml(s.last_sync_status || "—")}</td>
  <td>${escapeHtml(s.last_batch_total != null ? s.last_batch_total : "—")}</td>
  <td class="muted">${escapeHtml(s.last_sync_at || "—")}</td>
  <td class="muted">${escapeHtml(s.last_scroll_id != null ? String(s.last_scroll_id).slice(0, 40) : "—")}</td>
  <td class="muted">${escapeHtml(s.last_error || "—")}</td>
</tr>`;
            })
            .join("");

    const listingRows =
      listings.length === 0
        ? `<tr><td colspan="9">Sin publicaciones en <code>ml_listings</code>. Las tablas existen; los datos aparecen cuando un proceso llame a <code>upsertMlListing</code> (descarga desde la API ML).</td></tr>`
        : listings
            .map((r) => {
              const title =
                r.title && String(r.title).length > 80
                  ? `${escapeHtml(String(r.title).slice(0, 80))}…`
                  : escapeHtml(r.title);
              const price =
                r.price != null && String(r.price).trim() !== ""
                  ? escapeHtml(String(r.price))
                  : "—";
              const nick = nickByUser.get(Number(r.ml_user_id)) || "—";
              return `<tr>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td class="muted">${nick}</td>
  <td>${escapeHtml(r.item_id)}</td>
  <td>${escapeHtml(r.status || "—")}</td>
  <td class="muted">${title}</td>
  <td>${price}</td>
  <td>${escapeHtml(r.currency_id || "—")}</td>
  <td class="muted">${escapeHtml(r.updated_at || "—")}</td>
  <td class="muted">${r.raw_json != null ? String(r.raw_json).length : 0}</td>
</tr>`;
            })
            .join("");

    const filterNote = [
      useCuenta
        ? `Cuenta: <strong>${escapeHtml(useCuenta)}</strong> · <a href="${escapeAttr(
            pubQuery({ cuenta: null })
          )}">Ver todas las cuentas</a>`
        : "Todas las cuentas (orden: <code>ml_user_id</code>, luego <code>updated_at</code> desc.).",
      statusFilter
        ? `Estado: <strong>${escapeHtml(statusFilter)}</strong> · <a href="${escapeAttr(
            pubQuery({ status: null })
          )}">Quitar filtro de estado</a>`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    const statusLink = (value, label) => {
      const active =
        value === null
          ? !statusFilter
          : statusFilter &&
            String(statusFilter).toLowerCase() === String(value).toLowerCase();
      return `<a href="${escapeAttr(pubQuery({ status: value }))}" class="${
        active ? "active" : ""
      }">${escapeHtml(label)}</a>`;
    };

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Publicaciones ML</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1rem; }
    .lead { color: #8b98a5; font-size: 0.95rem; }
    a { color: #1d9bf0; }
    a.active { font-weight: 600; text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    .muted { color: #8b98a5; max-width: 22rem; }
    h2 { font-size: 1.1rem; margin-top: 1.25rem; }
    .status-filters {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem;
      margin: 0.75rem 0 1rem; padding: 0.65rem 0.75rem;
      background: #1e2732; border: 1px solid #38444d; border-radius: 8px; font-size: 0.95rem;
    }
    .status-filters strong { color: #e7e9ea; margin-right: 0.25rem; }
    .status-filters a {
      display: inline-block; padding: 0.2rem 0.55rem; border-radius: 6px;
      background: #15202b; border: 1px solid #38444d; text-decoration: none;
    }
    .status-filters a:hover { border-color: #1d9bf0; }
    .status-filters a.active { border-color: #1d9bf0; font-weight: 600; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Publicaciones Mercado Libre</h1>
  <div class="status-filters" role="group" aria-label="Filtro por estado de publicación">
    <strong>Estado:</strong>
    ${statusLink(null, "Todos")}
    ${statusLink("active", "active")}
    ${statusLink("paused", "paused")}
    ${statusLink("closed", "closed")}
  </div>
  <p class="lead">Tablas <code>ml_listings</code> y <code>ml_listing_sync_state</code>. JSON: <code>?format=json</code> · <code>?limit=${escapeHtml(
    limNum
  )}</code> · <code>?cuenta=ml_user_id</code> · <code>?status=</code> (ej. active, paused, closed)</p>
  <p class="lead">${filterNote}</p>
  <p class="lead">La descarga masiva desde la API no está automatizada en este servidor todavía: aquí ves lo ya guardado en BD. <code>ml_listing_sync_state</code> refleja el último lote cuando un job actualice ese estado.</p>

  <h2>Resumen por cuenta (ml_accounts)</h2>
  <table>
    <thead><tr><th>ml_user_id</th><th>nickname</th><th>publicaciones en BD</th><th></th></tr></thead>
    <tbody>${accounts.length === 0 ? `<tr><td colspan="4">No hay cuentas en <code>ml_accounts</code>.</td></tr>` : summaryRows}</tbody>
  </table>

  <h2>Estado de sincronización (último lote por cuenta)</h2>
  <table>
    <thead><tr><th>ml_user_id</th><th>last_sync_status</th><th>last_batch_total</th><th>last_sync_at</th><th>scroll (recorte)</th><th>last_error</th></tr></thead>
    <tbody>${syncRows}</tbody>
  </table>

  <h2>Publicaciones (${listings.length} fila(s) mostrada(s))</h2>
  <table>
    <thead><tr><th>cuenta</th><th>nickname</th><th>item_id</th><th>status</th><th>título</th><th>precio</th><th>moneda</th><th>updated_at</th><th>chars raw_json</th></tr></thead>
    <tbody>${listingRows}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Cambios de publicación: log webhook + acuses de procesado (ml_listing_change_ack). */
  if (isListingChangeAckPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Acuses ML</title><p>Define <code>ADMIN_SECRET</code> y reinicia.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Acuses ML</title><p>Acceso denegado. <code>/listing-change-ack?k=…</code></p>"
      );
      return;
    }

    const ackLabelEs = {
      activate: "Activar",
      add_stock: "Agregar stock",
      pause: "Pausar",
      delete: "Eliminar",
      dismiss: "Archivar / visto",
    };

    if (req.method === "POST") {
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const row = {
        ml_user_id: body.ml_user_id,
        item_id: body.item_id,
        action: body.action,
        note: body.note,
        webhook_log_id: body.webhook_log_id,
      };
      let id;
      try {
        id = await insertMlListingChangeAck(row);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        return;
      }
      if (id == null) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error:
              "acción o datos inválidos: ml_user_id, item_id y action requeridos; action ∈ " +
              ML_LISTING_CHANGE_ACK_ACTIONS.join(", "),
            actions: ML_LISTING_CHANGE_ACK_ACTIONS,
          })
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, id }));
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "usa GET o POST" }));
      return;
    }

    const limRaw = url.searchParams.get("limit");
    const limNum = Math.min(2000, Math.max(1, Number(limRaw) || 200));
    const cuentaFilter =
      url.searchParams.get("cuenta") != null && String(url.searchParams.get("cuenta")).trim() !== ""
        ? Number(String(url.searchParams.get("cuenta")).trim())
        : null;
    const useCuenta =
      cuentaFilter != null && Number.isFinite(cuentaFilter) && cuentaFilter > 0
        ? cuentaFilter
        : null;
    const itemFilter =
      url.searchParams.get("item_id") != null && String(url.searchParams.get("item_id")).trim() !== ""
        ? String(url.searchParams.get("item_id")).trim()
        : null;
    const listOpts = {};
    if (useCuenta != null) listOpts.ml_user_id = useCuenta;
    if (itemFilter != null) listOpts.item_id = itemFilter;

    let acks;
    let webhookLog;
    try {
      acks = await listMlListingChangeAck(limNum, 5000, listOpts);
      webhookLog =
        url.searchParams.get("include_webhook_log") === "1" ||
        url.searchParams.get("include_webhook_log") === "true"
          ? await listMlListingWebhookLog(limNum, 5000)
          : null;
      if (webhookLog && useCuenta != null) {
        webhookLog = webhookLog.filter((w) => Number(w.ml_user_id) === useCuenta);
      }
      if (webhookLog && itemFilter != null) {
        webhookLog = webhookLog.filter((w) => String(w.item_id) === itemFilter);
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }

    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          actions: ML_LISTING_CHANGE_ACK_ACTIONS,
          action_labels_es: ackLabelEs,
          limit: limNum,
          filters: { cuenta: useCuenta, item_id: itemFilter },
          acks,
          ...(webhookLog != null ? { webhook_log: webhookLog } : {}),
        })
      );
      return;
    }

    const ackRows = (acks || [])
      .map((a) => {
        const lab = ackLabelEs[a.action] || a.action;
        return `<tr>
  <td>${escapeHtml(a.id)}</td>
  <td>${escapeHtml(a.ml_user_id)}</td>
  <td>${escapeHtml(a.item_id)}</td>
  <td>${escapeHtml(lab)} <span class="muted">(${escapeHtml(a.action)})</span></td>
  <td>${escapeHtml(a.webhook_log_id != null ? a.webhook_log_id : "—")}</td>
  <td class="muted">${escapeHtml(a.note || "—")}</td>
  <td class="muted">${escapeHtml(a.created_at || "—")}</td>
</tr>`;
      })
      .join("");

    const whRows =
      webhookLog && webhookLog.length
        ? webhookLog
            .map(
              (w) => `<tr>
  <td>${escapeHtml(w.id)}</td>
  <td>${escapeHtml(w.ml_user_id)}</td>
  <td>${escapeHtml(w.item_id)}</td>
  <td>${escapeHtml(w.upsert_ok ? "sí" : "no")}</td>
  <td class="muted">${escapeHtml(w.fetched_at || "—")}</td>
</tr>`
            )
            .join("")
        : "";

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Acuses publicaciones ML</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1rem; }
    .lead { color: #8b98a5; font-size: 0.95rem; }
    code { background: #1e2732; padding: 0.1rem 0.35rem; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    .muted { color: #8b98a5; }
    h2 { font-size: 1.1rem; margin-top: 1.25rem; }
  </style>
</head>
<body>
  <h1>Acuses de cambios en publicaciones</h1>
  <p class="lead">Tabla <code>ml_listing_change_ack</code>: qué hiciste tras ver un cambio (no ejecuta la API de ML). JSON: <code>?format=json</code> · <code>?limit=</code> · <code>?cuenta=ml_user_id</code> · <code>?item_id=</code> · log de webhooks: <code>?include_webhook_log=1</code></p>
  <p class="lead"><strong>POST</strong> (mismo <code>?k=</code>) cuerpo JSON ejemplo:<br/>
  <code>{"ml_user_id":9309737,"item_id":"MLA123","action":"pause","note":"revisado stock","webhook_log_id":42}</code><br/>
  Acciones: <code>${escapeHtml(ML_LISTING_CHANGE_ACK_ACTIONS.join(", "))}</code></p>

  <h2>Acuses (${acks.length})</h2>
  <table>
    <thead><tr><th>id</th><th>cuenta</th><th>item_id</th><th>acción</th><th>webhook_log_id</th><th>nota</th><th>created_at</th></tr></thead>
    <tbody>${acks.length === 0 ? `<tr><td colspan="7">Sin filas.</td></tr>` : ackRows}</tbody>
  </table>

  ${
    webhookLog != null
      ? `<h2>Log webhook ítems (ml_listing_webhook_log, ${webhookLog.length})</h2>
  <table>
    <thead><tr><th>id</th><th>cuenta</th><th>item_id</th><th>upsert_ok</th><th>fetched_at</th></tr></thead>
    <tbody>${whRows || `<tr><td colspan="5">Sin filas.</td></tr>`}</tbody>
  </table>`
      : `<p class="muted">Añade <code>?include_webhook_log=1</code> para ver también <code>ml_listing_webhook_log</code> en esta página.</p>`
  }
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Órdenes ML descargadas (ml_orders; npm run sync-orders). */
  if (req.method === "GET" && isOrdenesMlPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Órdenes ML</title><p>Define <code>ADMIN_SECRET</code> y reinicia.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Órdenes ML</title><p>Acceso denegado. <code>/ordenes-ml?k=…</code></p>"
      );
      return;
    }
    const limRaw = url.searchParams.get("limit");
    const limNum = Math.min(10000, Math.max(1, Number(limRaw) || 500));
    const cuentaRaw = url.searchParams.get("cuenta");
    const cuentaFilter =
      cuentaRaw != null && String(cuentaRaw).trim() !== ""
        ? Number(String(cuentaRaw).trim())
        : null;
    const useCuenta =
      cuentaFilter != null && Number.isFinite(cuentaFilter) && cuentaFilter > 0
        ? cuentaFilter
        : null;
    const statusRaw = url.searchParams.get("status");
    const statusFilter =
      statusRaw != null && String(statusRaw).trim() !== ""
        ? String(statusRaw).trim()
        : null;
    const listOpts = statusFilter ? { status: statusFilter } : {};

    let accounts;
    let countRows;
    let orderCountsByUser;
    let orders;
    try {
      accounts = await listMlAccounts();
      countRows = await listMlOrderCountsByUserStatus();
      orderCountsByUser = await listMlOrderCountsByUser();
      orders = useCuenta
        ? await listMlOrdersByUser(useCuenta, limNum, 10000, listOpts)
        : await listMlOrdersAll(limNum, 10000, listOpts);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }

    const nickByUser = new Map(
      accounts.map((a) => [Number(a.ml_user_id), a.nickname != null ? String(a.nickname) : ""])
    );

    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          cuenta_filter: useCuenta,
          status_filter: statusFilter,
          limit: limNum,
          accounts,
          counts_by_user: orderCountsByUser,
          counts_by_user_status: countRows,
          orders_count: orders.length,
          orders,
        })
      );
      return;
    }

    function ordQuery(overrides = {}) {
      const p = new URLSearchParams();
      p.set("k", k);
      p.set("limit", String(limNum));
      const cuenta =
        overrides.cuenta !== undefined ? overrides.cuenta : useCuenta;
      if (cuenta != null && Number.isFinite(Number(cuenta)) && Number(cuenta) > 0) {
        p.set("cuenta", String(cuenta));
      }
      const st =
        overrides.status !== undefined ? overrides.status : statusFilter;
      if (st != null && String(st).trim() !== "") {
        p.set("status", String(st).trim());
      }
      return `/ordenes-ml?${p.toString()}`;
    }

    function packMsgHrefForOrder(mlUid, oid) {
      const p = new URLSearchParams();
      p.set("k", k);
      p.set("ml_user_id", String(mlUid));
      p.set("order_id", String(oid));
      return `/mensajes-pack-orden?${p.toString()}`;
    }

    const orderCountMap = new Map(
      orderCountsByUser.map((c) => [Number(c.ml_user_id), Number(c.total)])
    );

    const accountSummaryRows = accounts
      .map((a) => {
        const uid = Number(a.ml_user_id);
        const n = orderCountMap.get(uid) ?? 0;
        const nick = nickByUser.get(uid) || "—";
        const active = useCuenta === uid ? "active" : "";
        const link = ordQuery({ cuenta: uid });
        return `<tr>
  <td>${escapeHtml(uid)}</td>
  <td class="muted">${escapeHtml(nick)}</td>
  <td>${escapeHtml(n)}</td>
  <td><a href="${escapeAttr(link)}" class="${active}">Ver solo esta cuenta</a></td>
</tr>`;
      })
      .join("");

    const statusBreakdownRows = countRows
      .map((r) => {
        const uid = Number(r.ml_user_id);
        const nick = nickByUser.get(uid) || "—";
        return `<tr>
  <td>${escapeHtml(uid)}</td>
  <td class="muted">${escapeHtml(nick)}</td>
  <td>${escapeHtml(r.status || "—")}</td>
  <td>${escapeHtml(r.total)}</td>
</tr>`;
      })
      .join("");

    const orderRows =
      orders.length === 0
        ? `<tr><td colspan="13">Sin órdenes en <code>ml_orders</code>. Ejecuta <code>npm run sync-orders</code> o <code>npm run sync-orders-all</code> (todas las cuentas; en PowerShell a veces <code>-- --all</code> no llega al script).</td></tr>`
        : orders
            .map((o) => {
              const nick = nickByUser.get(Number(o.ml_user_id)) || "—";
              const amt =
                o.total_amount != null && String(o.total_amount).trim() !== ""
                  ? escapeHtml(String(o.total_amount))
                  : "—";
              const vTel = o.buyer_phone_registered;
              const telReg =
                vTel === true || vTel === 1
                  ? "sí"
                  : vTel === false || vTel === 0
                    ? "no"
                    : "—";
              const fbSale = o.feedback_sale != null && String(o.feedback_sale).trim() !== ""
                ? escapeHtml(String(o.feedback_sale))
                : "—";
              const fbPur = o.feedback_purchase != null && String(o.feedback_purchase).trim() !== ""
                ? escapeHtml(String(o.feedback_purchase))
                : "—";
              const fpv = o.feedback_purchase_value;
              const fpvS =
                fpv != null && fpv !== "" && Number.isFinite(Number(fpv))
                  ? escapeHtml(String(fpv))
                  : "—";
              const packHref = packMsgHrefForOrder(Number(o.ml_user_id), o.order_id);
              return `<tr>
  <td>${escapeHtml(o.ml_user_id)}</td>
  <td class="muted">${nick}</td>
  <td>${escapeHtml(o.order_id)}</td>
  <td>${escapeHtml(o.status || "—")}</td>
  <td>${amt}</td>
  <td>${escapeHtml(o.currency_id || "—")}</td>
  <td class="muted">${escapeHtml(o.date_created || "—")}</td>
  <td class="muted">${escapeHtml(o.buyer_id != null ? o.buyer_id : "—")}</td>
  <td title="phone_1 en ml_buyers">${escapeHtml(telReg)}</td>
  <td title="Nuestra calificación al comprador (feedback.sale)">${fbSale}</td>
  <td title="Calificación del comprador hacia nosotros (feedback.purchase.rating)">${fbPur}</td>
  <td title="Valor numérico: 1=positive, 0=neutral, -1=negative">${fpvS}</td>
  <td><a href="${escapeAttr(packHref)}" title="Mensajes post-venta en BD">pack</a></td>
</tr>`;
            })
            .join("");

    const filterNote = [
      useCuenta
        ? `Cuenta: <strong>${escapeHtml(useCuenta)}</strong> · <a href="${escapeAttr(
            ordQuery({ cuenta: null })
          )}">Ver todas las cuentas</a>`
        : "Todas las cuentas (orden: <code>ml_user_id</code>, luego <code>date_created</code> desc.).",
      statusFilter
        ? `Estado ML: <strong>${escapeHtml(statusFilter)}</strong> · <a href="${escapeAttr(
            ordQuery({ status: null })
          )}">Quitar filtro</a>`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Órdenes ML</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1rem; }
    .lead { color: #8b98a5; font-size: 0.95rem; }
    code { background: #1e2732; padding: 0.1rem 0.35rem; border-radius: 4px; }
    a { color: #1d9bf0; }
    a.active { font-weight: 600; text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.75rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    .muted { color: #8b98a5; }
    h2 { font-size: 1.1rem; margin-top: 1.25rem; }
  </style>
</head>
<body>
  <h1>Órdenes Mercado Libre</h1>
  <p class="lead">Tabla <code>ml_orders</code>: <code>npm run sync-orders</code> · todas las cuentas: <code>npm run sync-orders-all</code> (o <code>ML_ORDERS_SYNC_ALL=1</code>) · solo órdenes creadas hoy (API ML <code>order.date_created</code>): <code>npm run sync-orders-today-all</code> (<code>--today</code>). Con <code>ML_WEBHOOK_FETCH_RESOURCE=1</code>, cada GET OK de webhook <code>orders_v2</code> también hace upsert de la orden en esta tabla. JSON: <code>?format=json</code> · <code>?limit=</code> · <code>?cuenta=</code> · <code>?status=</code></p>
  <p class="lead">${filterNote}</p>
  <p class="lead">Filtros rápidos: <a href="${escapeAttr(ordQuery({ status: "confirmed" }))}">confirmed</a> · <a href="${escapeAttr(
    ordQuery({ status: "paid" })
  )}">paid</a> · <a href="${escapeAttr(ordQuery({ status: "payment_required" }))}">payment_required</a> · <a href="${escapeAttr(
    ordQuery({ status: "payment_in_process" })
  )}">payment_in_process</a> · <a href="${escapeAttr(
    ordQuery({ status: "cancelled" })
  )}">cancelled</a> · <a href="${escapeAttr(ordQuery({ status: "invalid" }))}">invalid</a> · <a href="${escapeAttr(
    ordQuery({ status: null })
  )}">todos</a></p>

  <h2>Resumen por cuenta (ml_accounts)</h2>
  <table>
    <thead><tr><th>ml_user_id</th><th>nickname</th><th>órdenes en BD</th><th></th></tr></thead>
    <tbody>${accounts.length === 0 ? `<tr><td colspan="4">No hay cuentas en <code>ml_accounts</code>.</td></tr>` : accountSummaryRows}</tbody>
  </table>

  <h2>Desglose por estado (ml_orders)</h2>
  <table>
    <thead><tr><th>ml_user_id</th><th>nickname</th><th>status (ML)</th><th>cantidad</th></tr></thead>
    <tbody>${countRows.length === 0 ? `<tr><td colspan="4">Sin datos. Ejecuta <code>npm run sync-orders-all</code> o <code>npm run sync-orders</code>.</td></tr>` : statusBreakdownRows}</tbody>
  </table>

  <h2>Órdenes (${orders.length} fila(s))</h2>
  <table>
    <thead><tr><th>cuenta</th><th>nickname</th><th>order_id</th><th>status</th><th>total</th><th>moneda</th><th>date_created</th><th>buyer_id</th><th>tel comprador</th><th>feedback venta→comprador</th><th>feedback compra→nosotros</th><th>valor compra→nosotros</th><th>mensajes</th></tr></thead>
    <tbody>${orderRows}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Mensajes post-venta por orden (ml_order_pack_messages; npm run sync-pack-messages). */
  if (req.method === "GET" && isMensajesPackOrdenPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Mensajes pack</title><p>Define <code>ADMIN_SECRET</code> y reinicia.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Mensajes pack</title><p>Acceso denegado. <code>/mensajes-pack-orden?k=…&amp;ml_user_id=…</code></p>"
      );
      return;
    }
    const limRaw = url.searchParams.get("limit");
    const limNum = Math.min(5000, Math.max(1, Number(limRaw) || 500));
    const mlUidRaw = url.searchParams.get("ml_user_id");
    const mlUserId =
      mlUidRaw != null && String(mlUidRaw).trim() !== ""
        ? Number(String(mlUidRaw).trim())
        : NaN;
    const orderIdRaw = url.searchParams.get("order_id");
    let orderIdOpt = null;
    if (orderIdRaw != null && String(orderIdRaw).trim() !== "") {
      const o = Number(String(orderIdRaw).trim());
      if (Number.isFinite(o) && o > 0) orderIdOpt = o;
    }

    function packMsgQuery(overrides = {}) {
      const p = new URLSearchParams();
      p.set("k", k);
      const uid =
        overrides.ml_user_id !== undefined ? overrides.ml_user_id : mlUserId;
      if (uid != null && Number.isFinite(Number(uid)) && Number(uid) > 0) {
        p.set("ml_user_id", String(uid));
      }
      const oid =
        overrides.order_id !== undefined ? overrides.order_id : orderIdOpt;
      if (oid != null && Number.isFinite(Number(oid)) && Number(oid) > 0) {
        p.set("order_id", String(oid));
      }
      const lim =
        overrides.limit !== undefined ? overrides.limit : limNum;
      if (lim != null) p.set("limit", String(lim));
      return `/mensajes-pack-orden?${p.toString()}`;
    }

    if (!Number.isFinite(mlUserId) || mlUserId <= 0) {
      let accounts = [];
      let countsByUser = [];
      let totalBd = 0;
      try {
        accounts = await listMlAccounts();
        countsByUser = await listMlOrderPackMessageCountsByUser();
        totalBd = await countMlOrderPackMessagesTotal();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
        return;
      }
      const countMap = new Map(countsByUser.map((c) => [Number(c.ml_user_id), Number(c.total)]));
      if (url.searchParams.get("format") === "json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            total_messages_saved: totalBd,
            by_account: accounts.map((a) => {
              const uid = Number(a.ml_user_id);
              return {
                ml_user_id: uid,
                nickname: a.nickname != null ? String(a.nickname) : null,
                messages_saved: countMap.get(uid) ?? 0,
              };
            }),
          })
        );
        return;
      }
      const accRows = accounts
        .map((a) => {
          const uid = Number(a.ml_user_id);
          const nMsg = countMap.get(uid) ?? 0;
          const href = packMsgQuery({ ml_user_id: uid, order_id: null, limit: limNum });
          return `<tr><td>${escapeHtml(uid)}</td><td class="muted">${escapeHtml(
            a.nickname != null ? String(a.nickname) : "—"
          )}</td><td style="text-align:right">${escapeHtml(String(nMsg))}</td><td><a href="${escapeAttr(
            href
          )}">Ver mensajes</a></td></tr>`;
        })
        .join("");
      const pickerHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mensajes pack (órdenes)</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1.5rem; }
    .lead { color: #8b98a5; font-size: 0.95rem; }
    code { background: #1e2732; padding: 0.1rem 0.35rem; border-radius: 4px; }
    a { color: #1d9bf0; }
    table { border-collapse: collapse; width: 100%; max-width: 820px; margin-top: 1rem; font-size: 0.9rem; }
    th, td { border: 1px solid #38444d; padding: 0.4rem 0.55rem; text-align: left; }
    th { background: #1e2732; }
    th.num, td.num { text-align: right; }
    .muted { color: #8b98a5; }
  </style>
</head>
<body>
  <h1>Mensajes post-venta por orden</h1>
  <p class="lead">Tabla <code>ml_order_pack_messages</code> · <strong>Total guardado en BD: ${escapeHtml(
    String(totalBd)
  )}</strong> mensaje(s). Elige cuenta o abre con <code>?k=…&amp;ml_user_id=ID</code> y opcional <code>&amp;order_id=…</code>. JSON: <code>?format=json</code>. Sync: <code>npm run sync-pack-messages</code>.</p>
  <table>
    <thead><tr><th>ml_user_id</th><th>nickname</th><th class="num">mensajes guardados</th><th></th></tr></thead>
    <tbody>${
      accounts.length === 0
        ? `<tr><td colspan="4">No hay cuentas en <code>ml_accounts</code>.</td></tr>`
        : accRows
    }</tbody>
  </table>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pickerHtml);
      return;
    }

    let rows;
    let totalCuentaBd = 0;
    let totalOrdenBd = null;
    let ordersForRows = [];
    let buyersForRows = [];
    let tipoELogsForRows = [];
    let sellerIdsForRows = new Set();
    try {
      rows = await listMlOrderPackMessagesByUser(mlUserId, limNum, {
        order_id: orderIdOpt,
      });
      totalCuentaBd = await countMlOrderPackMessagesForMlUser(mlUserId);
      if (orderIdOpt != null) {
        totalOrdenBd = await countMlOrderPackMessagesForOrder(mlUserId, orderIdOpt);
      }
      const orderIdsForRows = [...new Set(rows.map((r) => Number(r.order_id)).filter((n) => Number.isFinite(n) && n > 0))];
      if (orderIdsForRows.length > 0) {
        ordersForRows = await listMlOrdersByUserAndOrderIds(mlUserId, orderIdsForRows);
        const buyerIdsForRows = [
          ...new Set(
            ordersForRows
              .map((o) => Number(o.buyer_id))
              .filter((n) => Number.isFinite(n) && n > 0)
          ),
        ];
        if (buyerIdsForRows.length > 0) {
          buyersForRows = await listMlBuyersByIds(buyerIdsForRows);
        }
        tipoELogsForRows = await listMlWhatsappWasenderLogByUserAndOrderIds(mlUserId, orderIdsForRows, {
          message_kind: "E",
          limit: 2000,
        });
      }
      sellerIdsForRows = await getRegisteredSellerIdSet();
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }

    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          ml_user_id: mlUserId,
          order_id: orderIdOpt,
          limit: limNum,
          total_messages_saved_account: totalCuentaBd,
          total_messages_saved_order:
            orderIdOpt != null ? totalOrdenBd : undefined,
          count_rows_returned: rows.length,
          items: rows,
        })
      );
      return;
    }

    const totalLine =
      orderIdOpt != null && totalOrdenBd != null
        ? `Guardados en BD: <strong>${escapeHtml(String(totalOrdenBd))}</strong> en esta orden · <strong>${escapeHtml(
            String(totalCuentaBd)
          )}</strong> en total para la cuenta. Mostrando hasta <strong>${escapeHtml(
            String(limNum)
          )}</strong> filas.`
        : `Guardados en BD para esta cuenta: <strong>${escapeHtml(
            String(totalCuentaBd)
          )}</strong> mensaje(s). Mostrando hasta <strong>${escapeHtml(
            String(limNum)
          )}</strong> filas (orden reciente).`;

    const filterNote = orderIdOpt
      ? `Cuenta <strong>${escapeHtml(mlUserId)}</strong> · orden <strong>${escapeHtml(
          orderIdOpt
        )}</strong> · ${totalLine} · <a href="${escapeAttr(
          packMsgQuery({ order_id: null })
        )}">Quitar filtro de orden (todas las recientes)</a>`
      : `Cuenta <strong>${escapeHtml(mlUserId)}</strong>. ${totalLine}`;

    const orderMapForRows = new Map(ordersForRows.map((o) => [Number(o.order_id), o]));
    const buyerMapForRows = new Map(buyersForRows.map((b) => [Number(b.buyer_id), b]));
    const tipoELogByOrder = new Map();
    for (const logRow of tipoELogsForRows) {
      const oid = Number(logRow.order_id);
      if (!Number.isFinite(oid) || oid <= 0) continue;
      const prev = tipoELogByOrder.get(oid);
      if (!prev) {
        tipoELogByOrder.set(oid, logRow);
        continue;
      }
      const prevTs = Date.parse(String(prev.created_at || ""));
      const curTs = Date.parse(String(logRow.created_at || ""));
      const prevInternal = String(prev.tipo_e_activation_source || "").trim() === "mensajeria_interna_ord";
      const curInternal = String(logRow.tipo_e_activation_source || "").trim() === "mensajeria_interna_ord";
      if (curInternal && !prevInternal) {
        tipoELogByOrder.set(oid, logRow);
        continue;
      }
      if (curInternal === prevInternal && Number.isFinite(curTs) && (!Number.isFinite(prevTs) || curTs > prevTs)) {
        tipoELogByOrder.set(oid, logRow);
      }
    }

    const tableRows = rows
      .map((r) => {
        const txt =
          r.message_text != null && String(r.message_text).length > 200
            ? `${escapeHtml(String(r.message_text).slice(0, 200))}…`
            : escapeHtml(r.message_text || "—");
        const rawPrev =
          r.raw_json != null && String(r.raw_json).length > 120
            ? `${escapeHtml(String(r.raw_json).slice(0, 120))}…`
            : escapeHtml(r.raw_json || "—");
        const ord = orderMapForRows.get(Number(r.order_id)) || null;
        const buyer = ord && ord.buyer_id != null ? buyerMapForRows.get(Number(ord.buyer_id)) || null : null;
        const fromUserIdNum =
          r.from_user_id != null && Number.isFinite(Number(r.from_user_id)) ? Number(r.from_user_id) : null;
        const ignoreBySeller =
          fromUserIdNum != null && fromUserIdNum > 0 && sellerIdsForRows.has(fromUserIdNum);
        const detectedPhone = extractFirstMobile04(r.message_text != null ? String(r.message_text) : "") || null;
        const detectedE164 = detectedPhone ? normalizePhoneToE164(detectedPhone, "58") : null;
        const buyerPhoneUpdated = (() => {
          if (ignoreBySeller) return "omitido · from seller";
          if (!buyer || !detectedPhone) return "no";
          const p1 = buyer.phone_1 != null ? String(buyer.phone_1).trim() : "";
          const p2 = buyer.phone_2 != null ? String(buyer.phone_2).trim() : "";
          if (p1 && (p1 === detectedPhone || normalizePhoneToE164(p1, "58") === detectedE164)) {
            return "sí";
          }
          if (p2 && (p2 === detectedPhone || normalizePhoneToE164(p2, "58") === detectedE164)) {
            return "sí";
          }
          return "no";
        })();
        const buyerPhoneCol =
          ignoreBySeller
            ? "omitido · from seller"
            : detectedPhone != null
            ? `${escapeHtml(detectedPhone)} · ${escapeHtml(buyerPhoneUpdated)}`
            : "—";
        const tipoELog = tipoELogByOrder.get(Number(r.order_id)) || null;
        const tipoECol = (() => {
          if (ignoreBySeller) return "omitido · from seller";
          if (!tipoELog) return "—";
          const out = tipoELog.outcome != null && String(tipoELog.outcome).trim() !== "" ? String(tipoELog.outcome).trim() : "—";
          const phone = tipoELog.phone_e164 != null && String(tipoELog.phone_e164).trim() !== "" ? String(tipoELog.phone_e164).trim() : "—";
          const src =
            tipoELog.tipo_e_activation_source != null && String(tipoELog.tipo_e_activation_source).trim() !== ""
              ? String(tipoELog.tipo_e_activation_source).trim()
              : "—";
          return `${escapeHtml(out)} · ${escapeHtml(phone)} · ${escapeHtml(src)}`;
        })();
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.ml_message_id)}</td>
  <td>${escapeHtml(r.from_user_id != null ? r.from_user_id : "—")}</td>
  <td>${escapeHtml(r.to_user_id != null ? r.to_user_id : "—")}</td>
  <td class="msg">${txt}</td>
  <td>${buyerPhoneCol}</td>
  <td>${tipoECol}</td>
  <td class="muted">${escapeHtml(r.date_created || "—")}</td>
  <td>${escapeHtml(r.status || "—")}</td>
  <td>${escapeHtml(r.tag || "—")}</td>
  <td class="muted">${escapeHtml(r.fetched_at || "—")}</td>
  <td><pre class="payload">${rawPrev}</pre></td>
</tr>`;
      })
      .join("");

    const htmlOut = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Mensajes pack órdenes</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #15202b; color: #e7e9ea; margin: 1rem; }
    h1 { font-size: 1.2rem; }
    .lead { color: #8b98a5; font-size: 0.9rem; margin-top: 0.5rem; }
    code { background: #1e2732; padding: 0.1rem 0.35rem; border-radius: 4px; }
    a { color: #1d9bf0; }
    table { border-collapse: collapse; width: 100%; max-width: 1600px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.75rem; }
    td.msg { max-width: 280px; word-break: break-word; }
    pre.payload { margin: 0; max-height: 80px; overflow: auto; font-size: 0.7rem; white-space: pre-wrap; word-break: break-word; color: #c4cfda; }
  </style>
</head>
<body>
  <h1>Mensajes post-venta (pack)</h1>
  <p class="lead">${filterNote} · <code>?limit=${escapeHtml(
    limNum
  )}</code> · JSON: <code>?format=json</code> · <a href="${escapeAttr(
    packMsgQuery({ ml_user_id: null })
  )}">Elegir otra cuenta</a></p>
  <p class="lead">Orden concreta: añade <code>&amp;order_id=NUM</code> a la URL. La columna <code>buyer_phone_updated</code> muestra el teléfono detectado en el texto (<code>04XXXXXXXXX</code> o <code>04XX-XXXXXXX</code>) y si ese número quedó aplicado en <code>ml_buyers.phone_1/phone_2</code> (<code>sí</code> o <code>no</code>); <code>tipo_e_invocado</code> muestra el último log tipo E de la orden. Datos: <code>npm run sync-pack-messages</code> / <code>sync-pack-messages-all</code>.</p>
  <table>
    <thead><tr><th>id</th><th>order_id</th><th>ml_message_id</th><th>from</th><th>to</th><th>texto</th><th>buyer_phone_updated</th><th>tipo_e_invocado</th><th>date_created</th><th>status</th><th>tag</th><th>fetched_at</th><th>raw (preview)</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="13">Sin mensajes en BD para este filtro.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlOut);
    return;
  }

  /** Historial de intentos de envío automático post-venta (ml_post_sale_auto_send_log). */
  if (req.method === "GET" && isPostSaleEnviosPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Envíos</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Envíos</title><p>Acceso denegado. Usa <code>/envios-postventa?k=TU_CLAVE</code>.</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const outcomeRaw = url.searchParams.get("outcome") || "default";
    const validOutcomes = new Set(["default", "all", "success", "skipped", "api_error"]);
    const curOutcome = validOutcomes.has(String(outcomeRaw).toLowerCase())
      ? String(outcomeRaw).toLowerCase()
      : "default";
    let rows;
    try {
      rows = await listPostSaleAutoSendLog(lim, 2000, { outcome: curOutcome });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    const kForLinks = k;
    const limForLinks = lim && String(lim).trim() !== "" ? String(lim) : "";
    function enviosPostventaQuery(outcomeKey) {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      if (limForLinks) p.set("limit", limForLinks);
      if (outcomeKey && outcomeKey !== "default") p.set("outcome", outcomeKey);
      return `/envios-postventa?${p.toString()}`;
    }
    const enviosFilterDefs = [
      { key: "default", label: "Por defecto (todos)" },
      { key: "all", label: "Todos" },
      { key: "success", label: "success" },
      { key: "skipped", label: "skipped" },
      { key: "api_error", label: "api_error" },
    ];
    const enviosFilterNav = enviosFilterDefs
      .map((f) => {
        const active = curOutcome === f.key ? ' class="active"' : "";
        return `<a href="${escapeAttr(enviosPostventaQuery(f.key))}"${active}>${escapeHtml(f.label)}</a>`;
      })
      .join("\n    ");
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          outcome: curOutcome,
          count: rows.length,
          items: rows,
        })
      );
      return;
    }
    const tableRows = rows
      .map((r) => {
        const prev =
          r.response_body && r.response_body.length > 160
            ? `${escapeHtml(r.response_body.slice(0, 160))}…`
            : escapeHtml(r.response_body);
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.topic)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.outcome)}</td>
  <td>${escapeHtml(r.skip_reason)}</td>
  <td>${escapeHtml(r.http_status)}</td>
  <td>${escapeHtml(r.option_id)}</td>
  <td>${escapeHtml(r.error_message)}</td>
  <td><pre class="payload">${prev || "—"}</pre></td>
</tr>`;
      })
      .join("");
    const enviosHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Log envíos post-venta</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1400px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.75rem; }
    pre.payload { margin: 0; max-height: 100px; overflow: auto; font-size: 0.72rem; white-space: pre-wrap; word-break: break-word; color: #c4cfda; }
    .filter-nav { margin-top: 0.75rem; line-height: 1.8; font-size: 0.85rem; }
    .filter-nav a { color: #1d9bf0; text-decoration: none; margin-right: 0.35rem; }
    .filter-nav a:hover { text-decoration: underline; }
    .filter-nav a.active { font-weight: 600; color: #e7e9ea; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Log envíos automáticos post-venta</h1>
  <p class="lead">Tabla <code>ml_post_sale_auto_send_log</code> · <code>order_id</code> = id de orden en la URL de mensajería ML. ${rows.length} fila(s) con el filtro actual. JSON: <code>?format=json&amp;outcome=…</code>. Reintento: <code>POST /envios-postventa/retry?k=…</code> con JSON <code>order_id</code>, <code>ml_user_id</code>, opcional <code>buyer_id</code>, <code>force</code> (borra deduplicación). Pruebas repetidas sin tocar BD: variable <code>ML_POST_SALE_DISABLE_DEDUP=1</code>.</p>
  <nav class="filter-nav" aria-label="Filtro por outcome">
    ${enviosFilterNav}
  </nav>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>user_id</th><th>topic</th><th>order_id</th><th>outcome</th><th>skip_reason</th><th>http</th><th>option</th><th>error</th><th>response (preview)</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="11">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(enviosHtml);
    return;
  }

  /** Log POST FileMaker tipo G — `ml_filemaker_tipo_g_log`. */
  if (req.method === "GET" && isMensajesTipoGPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Mensajes tipo G</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Mensajes tipo G</title><p>Acceso denegado. <code>/mensajes-tipo-g?k=…</code></p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    let rows;
    try {
      rows = await listFilemakerTipoGLog(lim, 2000);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, rows }));
      return;
    }
    const tableRows = rows
      .map((r) => {
        const prev =
          r.tipo_e_detail && r.tipo_e_detail.length > 180
            ? `${escapeHtml(r.tipo_e_detail.slice(0, 180))}…`
            : escapeHtml(r.tipo_e_detail);
        const reqPrev =
          r.request_json && r.request_json.length > 120
            ? `${escapeHtml(r.request_json.slice(0, 120))}…`
            : escapeHtml(r.request_json);
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.tipo_e_activation_source)}</td>
  <td>${escapeHtml(r.phone_in)}</td>
  <td>${escapeHtml(r.tipo_retiro)}</td>
  <td>${escapeHtml(r.outcome)}</td>
  <td>${escapeHtml(r.skip_reason)}</td>
  <td><pre class="payload">${prev || "—"}</pre></td>
  <td><pre class="payload">${reqPrev || "—"}</pre></td>
</tr>`;
      })
      .join("");
    const tipoGHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Log mensajes tipo G (FileMaker)</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1600px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.72rem; word-break: break-all; }
    pre.payload { margin: 0; max-height: 100px; overflow: auto; font-size: 0.7rem; white-space: pre-wrap; word-break: break-word; color: #c4cfda; }
  </style>
</head>
<body>
  <h1>Log mensajes tipo G (FileMaker)</h1>
  <p class="lead">Tabla <code>ml_filemaker_tipo_g_log</code>: cada POST a <code>/filemaker/tipo-g</code> o <code>/mensajes-tipo-g</code> con <code>FILEMAKER_TIPO_G_SECRET</code>. Tras actualizar <code>ml_buyers</code> se intenta el envío tipo E (Wasender); el detalle del intento va en <code>tipo_e_detail</code>. Columna <code>tipo_e_activation_source</code> (motivo/origen): p. ej. <code>filemaker_tipo_g</code>. ${rows.length} fila(s). JSON: <code>?format=json</code>.</p>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>order_id</th><th>buyer_id</th><th>ml_user_id</th><th>motivo_activación</th><th>phone_in</th><th>tipo_retiro</th><th>outcome</th><th>skip_reason</th><th>tipo_e_detail</th><th>request_json</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="12">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(tipoGHtml);
    return;
  }

  /** Log unificado: tipo A (post-venta orden), B (retiro), C (calificación) — `ml_message_kind_send_log`. */
  if (req.method === "GET" && isEnviosTiposAbcPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Envíos A/B/C</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Envíos A/B/C</title><p>Acceso denegado. <code>/envios-tipos-abc?k=…</code></p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const kindRaw = (url.searchParams.get("kind") || "all").trim().toLowerCase();
    const validKinds = new Set(["all", "a", "b", "c"]);
    const curKind = validKinds.has(kindRaw) ? kindRaw : "all";
    const messageKindOpt =
      curKind === "a" ? "A" : curKind === "b" ? "B" : curKind === "c" ? "C" : "ALL";
    const outcomeRaw = url.searchParams.get("outcome") || "default";
    const validOutcomes = new Set(["default", "all", "success", "skipped", "api_error"]);
    const curOutcome = validOutcomes.has(String(outcomeRaw).toLowerCase())
      ? String(outcomeRaw).toLowerCase()
      : "default";
    const outcomeOpt =
      curOutcome === "all" || curOutcome === "default" ? "all" : curOutcome;
    let rows;
    try {
      rows = await listMlMessageKindSendLog(lim, 2000, {
        message_kind: messageKindOpt,
        outcome: outcomeOpt,
      });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    const kForLinks = k;
    const limForLinks = lim && String(lim).trim() !== "" ? String(lim) : "";
    function tiposAbcQuery(kindKey, outcomeKey) {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      if (limForLinks) p.set("limit", limForLinks);
      if (kindKey && kindKey !== "all") p.set("kind", kindKey);
      if (outcomeKey && outcomeKey !== "default") p.set("outcome", outcomeKey);
      return `/envios-tipos-abc?${p.toString()}`;
    }
    const kindNav = ["all", "a", "b", "c"]
      .map((kindKey) => {
        const active = curKind === kindKey ? ' class="active"' : "";
        const label =
          kindKey === "all"
            ? "Todos (A+B+C)"
            : kindKey === "a"
              ? "Solo A"
              : kindKey === "b"
                ? "Solo B"
                : "Solo C";
        return `<a href="${escapeAttr(tiposAbcQuery(kindKey, curOutcome))}"${active}>${escapeHtml(label)}</a>`;
      })
      .join("\n    ");
    const outcomeNav = ["default", "all", "success", "skipped", "api_error"]
      .map((outKey) => {
        const active = curOutcome === outKey ? ' class="active"' : "";
        const label =
          outKey === "default"
            ? "Outcome (todos)"
            : outKey === "all"
              ? "all"
              : outKey;
        return `<a href="${escapeAttr(tiposAbcQuery(curKind, outKey))}"${active}>${escapeHtml(label)}</a>`;
      })
      .join("\n    ");
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          kind: curKind,
          outcome: curOutcome,
          count: rows.length,
          items: rows,
        })
      );
      return;
    }
    const tableRows = rows
      .map((r) => {
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td><strong>${escapeHtml(r.message_kind)}</strong></td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.outcome)}</td>
  <td>${escapeHtml(r.skip_reason)}</td>
  <td>${escapeHtml(r.http_status)}</td>
  <td>${escapeHtml(r.detail)}</td>
</tr>`;
      })
      .join("");
    const htmlOut = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Log envíos tipo A / B / C</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1200px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.75rem; }
    .filter-nav { margin-top: 0.75rem; line-height: 1.8; font-size: 0.85rem; }
    .filter-nav a { color: #1d9bf0; text-decoration: none; margin-right: 0.35rem; }
    .filter-nav a:hover { text-decoration: underline; }
    .filter-nav a.active { font-weight: 600; color: #e7e9ea; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Log unificado: mensajes tipo A, B y C</h1>
  <p class="lead">Tabla <code>ml_message_kind_send_log</code> · A = post-venta orden · B = retiro tienda · C = recordatorio calificación. ${rows.length} fila(s). JSON: <code>?format=json</code> · <code>?kind=a|b|c|all</code> · <code>?outcome=success|skipped|api_error|all</code></p>
  <nav class="filter-nav" aria-label="Tipo"><span class="muted">Tipo:</span> ${kindNav}</nav>
  <nav class="filter-nav" aria-label="Outcome"><span class="muted">Outcome:</span> ${outcomeNav}</nav>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>tipo</th><th>ml_user_id</th><th>buyer_id</th><th>order_id</th><th>outcome</th><th>skip_reason</th><th>http</th><th>detail</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="10">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlOut);
    return;
  }

  /** Log envíos WhatsApp Wasender tipo E / F (`ml_whatsapp_wasender_log`). */
  if (req.method === "GET" && isEnviosWhatsappTipoEPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Envíos WhatsApp E/F</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Envíos WhatsApp E/F</title><p>Acceso denegado. <code>/envios-whatsapp-tipo-e?k=…</code></p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const kindRaw = (url.searchParams.get("kind") || "e").trim().toLowerCase();
    const validKinds = new Set(["e", "f", "all"]);
    const curKind = validKinds.has(kindRaw) ? kindRaw : "e";
    const outcomeRaw = (url.searchParams.get("outcome") || "all").trim().toLowerCase();
    const validOutcomes = new Set(["all", "success", "skipped", "api_error"]);
    const curOutcome = validOutcomes.has(outcomeRaw) ? outcomeRaw : "all";
    const outcomeOpt = curOutcome === "all" ? null : curOutcome;
    const listOpts = { maxAllowed: 2000, outcome: outcomeOpt };
    if (curKind === "e") listOpts.message_kind = "E";
    else if (curKind === "f") listOpts.message_kind = "F";
    let rows;
    try {
      rows = await listMlWhatsappWasenderLog(lim, listOpts);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          kind: curKind,
          outcome: curOutcome,
          count: rows.length,
          items: rows,
        })
      );
      return;
    }
    const kForLinks = k;
    const limForLinks = lim && String(lim).trim() !== "" ? String(lim) : "";
    function waQuery(kindKey, outcomeKey) {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      if (limForLinks) p.set("limit", limForLinks);
      if (kindKey && kindKey !== "e") p.set("kind", kindKey);
      if (outcomeKey && outcomeKey !== "all") p.set("outcome", outcomeKey);
      return `/envios-whatsapp-tipo-e?${p.toString()}`;
    }
    const kindNav = ["e", "f", "all"]
      .map((kindKey) => {
        const active = curKind === kindKey ? ' class="active"' : "";
        const label =
          kindKey === "e" ? "E (imagen+ubicación)" : kindKey === "f" ? "F (pregunta)" : "E + F";
        return `<a href="${escapeAttr(waQuery(kindKey, curOutcome))}"${active}>${escapeHtml(label)}</a>`;
      })
      .join("\n    ");
    const outcomeNav = ["all", "success", "skipped", "api_error"]
      .map((outKey) => {
        const active = curOutcome === outKey ? ' class="active"' : "";
        return `<a href="${escapeAttr(waQuery(curKind, outKey))}"${active}>${escapeHtml(outKey)}</a>`;
      })
      .join("\n    ");
    function fmtWaCreated(r) {
      const t = r.created_at;
      if (t instanceof Date) return t.toISOString();
      return t != null ? String(t) : "—";
    }
    const tableRows = rows
      .map((r) => {
        const prev =
          r.text_preview && String(r.text_preview).length > 120
            ? `${escapeHtml(String(r.text_preview).slice(0, 120))}…`
            : escapeHtml(r.text_preview || "—");
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(fmtWaCreated(r))}</td>
  <td><strong>${escapeHtml(r.message_kind)}</strong></td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.ml_question_id)}</td>
  <td>${escapeHtml(r.phone_e164)}</td>
  <td>${escapeHtml(r.tipo_e_step)}</td>
  <td>${escapeHtml(r.tipo_e_activation_source)}</td>
  <td>${escapeHtml(r.outcome)}</td>
  <td>${escapeHtml(r.skip_reason)}</td>
  <td>${escapeHtml(r.http_status)}</td>
  <td>${prev}</td>
</tr>`;
      })
      .join("");
    const htmlWa = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Log WhatsApp tipo E / F</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1400px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.75rem; }
    .filter-nav { margin-top: 0.75rem; line-height: 1.8; font-size: 0.85rem; }
    .filter-nav a { color: #1d9bf0; text-decoration: none; margin-right: 0.35rem; }
    .filter-nav a:hover { text-decoration: underline; }
    .filter-nav a.active { font-weight: 600; color: #e7e9ea; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Log envíos WhatsApp Wasender (tipo E y F)</h1>
  <p class="lead">Tabla <code>ml_whatsapp_wasender_log</code> · E = imagen + ubicación por orden · F = texto por pregunta. Columna <code>tipo_e_activation_source</code> (motivo/origen tipo E): p. ej. <code>filemaker_tipo_g</code>, <code>mensajeria_interna_ord</code>. ${rows.length} fila(s). JSON: <code>?format=json</code> · <code>?kind=e|f|all</code> · <code>?outcome=success|skipped|api_error|all</code></p>
  <nav class="filter-nav" aria-label="Tipo"><span class="muted">Tipo:</span> ${kindNav}</nav>
  <nav class="filter-nav" aria-label="Outcome"><span class="muted">Outcome:</span> ${outcomeNav}</nav>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>kind</th><th>ml_user_id</th><th>buyer_id</th><th>order_id</th><th>ml_question_id</th><th>phone_e164</th><th>tipo_e_step</th><th>motivo_activación</th><th>outcome</th><th>skip_reason</th><th>http</th><th>text_preview</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="14">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlWa);
    return;
  }

  /** Log envíos recordatorio calificación (ml_rating_request_log; job rating-request-daily). */
  if (req.method === "GET" && isRecordatoriosCalificacionPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Recordatorios</title><p>Define <code>ADMIN_SECRET</code> y reinicia el servidor.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Recordatorios</title><p>Acceso denegado. <code>/recordatorios-calificacion?k=…</code> o <code>/recordatorios?k=…</code> (misma clave que <code>ADMIN_SECRET</code>).</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const outcomeRaw = url.searchParams.get("outcome") || "all";
    const validOutcomes = new Set(["all", "success", "api_error"]);
    const curOutcome = validOutcomes.has(String(outcomeRaw).toLowerCase())
      ? String(outcomeRaw).toLowerCase()
      : "all";
    let rows;
    try {
      rows = await listMlRatingRequestLog(lim, 2000, { outcome: curOutcome });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    const kForLinks = k;
    const limForLinks = lim && String(lim).trim() !== "" ? String(lim) : "";
    function recordatoriosQuery(outcomeKey) {
      const p = new URLSearchParams();
      p.set("k", kForLinks);
      if (limForLinks) p.set("limit", limForLinks);
      if (outcomeKey && outcomeKey !== "all") p.set("outcome", outcomeKey);
      return `/recordatorios-calificacion?${p.toString()}`;
    }
    const filtDefs = [
      { key: "all", label: "Todos" },
      { key: "success", label: "success (API OK)" },
      { key: "api_error", label: "api_error" },
    ];
    const filtNav = filtDefs
      .map((f) => {
        const active = curOutcome === f.key ? ' class="active"' : "";
        return `<a href="${escapeAttr(recordatoriosQuery(f.key))}"${active}>${escapeHtml(f.label)}</a>`;
      })
      .join("\n    ");
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          outcome: curOutcome,
          count: rows.length,
          items: rows,
        })
      );
      return;
    }
    const tableRows = rows
      .map((r) => {
        const prev =
          r.response_body && r.response_body.length > 160
            ? `${escapeHtml(r.response_body.slice(0, 160))}…`
            : escapeHtml(r.response_body);
        const fb = r.purchase_feedback_now;
        const fbS =
          fb != null && String(fb).trim() !== "" && String(fb).toLowerCase() !== "pending"
            ? escapeHtml(String(fb))
            : "—";
        const pv = r.purchase_rating_value;
        const pvS =
          pv != null && pv !== "" && Number.isFinite(Number(pv))
            ? escapeHtml(String(pv))
            : "—";
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.outcome)}</td>
  <td>${escapeHtml(r.http_status)}</td>
  <td>${fbS}</td>
  <td title="feedback_purchase_value: 1=positive, 0=neutral, -1=negative">${pvS}</td>
  <td class="muted">${escapeHtml(r.request_path)}</td>
  <td>${escapeHtml(r.error_message)}</td>
  <td><pre class="payload">${prev || "—"}</pre></td>
</tr>`;
      })
      .join("");
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Recordatorios calificación</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1400px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.75rem; }
    pre.payload { margin: 0; max-height: 100px; overflow: auto; font-size: 0.72rem; white-space: pre-wrap; word-break: break-word; color: #c4cfda; }
    .filter-nav { margin-top: 0.75rem; line-height: 1.8; font-size: 0.85rem; }
    .filter-nav a { color: #1d9bf0; text-decoration: none; margin-right: 0.35rem; }
    .filter-nav a:hover { text-decoration: underline; }
    .filter-nav a.active { font-weight: 600; color: #e7e9ea; text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Log recordatorios de calificación</h1>
  <p class="lead">Tabla <code>ml_rating_request_log</code> (cada POST a mensajería ML del job <code>npm run rating-request-daily</code>). <strong>feedback comprador</strong> = snapshot desde <code>ml_orders</code> tras el último sync (si ya calificó, verás positive/neutral/etc.). ${rows.length} fila(s). JSON: <code>?format=json</code> · <code>?outcome=success|api_error</code></p>
  <nav class="filter-nav" aria-label="Filtro">
    ${filtNav}
  </nav>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>ml_user_id</th><th>order_id</th><th>buyer_id</th><th>outcome</th><th>http</th><th>feedback comprador (sync)</th><th>valor (1/0/-1)</th><th>request_path</th><th>error</th><th>response (preview)</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="12">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  /** Snapshots GET detalle ventas .ve (HTML en ml_ventas_detalle_web). */
  if (req.method === "GET" && isVentasDetalleWebPath(url.pathname)) {
    const adminSecret = process.env.ADMIN_SECRET;
    const k = url.searchParams.get("k") || url.searchParams.get("secret");
    if (!adminSecret) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Ventas detalle</title><p>Define <code>ADMIN_SECRET</code>.</p>"
      );
      return;
    }
    if (k !== adminSecret) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>Ventas detalle</title><p>Acceso denegado.</p>"
      );
      return;
    }
    const lim = url.searchParams.get("limit");
    const includeRaw =
      url.searchParams.get("include_raw") === "1" || url.searchParams.get("include_raw") === "true";
    let rows;
    try {
      rows = await listMlVentasDetalleWeb(lim, 500, includeRaw);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><p>${escapeHtml(e.message)}</p>`);
      return;
    }
    if (url.searchParams.get("format") === "json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, count: rows.length, items: rows }));
      return;
    }
    const tableRows = rows
      .map((r) => {
        const prev =
          r.resultado_g && r.resultado_g.length > 200
            ? `${escapeHtml(r.resultado_g.slice(0, 200))}…`
            : escapeHtml(r.resultado_g);
        return `<tr>
  <td>${escapeHtml(r.id)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td>${escapeHtml(r.ml_user_id)}</td>
  <td>${escapeHtml(r.order_id)}</td>
  <td>${escapeHtml(r.celular)}</td>
  <td>${escapeHtml(r.pos_buyer_info_text)}</td>
  <td>${escapeHtml(r.pos_label)}</td>
  <td class="muted">${escapeHtml(r.request_url)}</td>
  <td>${escapeHtml(r.http_status)}</td>
  <td>${escapeHtml(r.body_len)}</td>
  <td>${escapeHtml(r.error)}</td>
  <td><pre class="payload">${prev || "—"}</pre></td>
</tr>`;
      })
      .join("");
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Detalle ventas web ML</title>
  <style>
    body { font-family: system-ui, Segoe UI, sans-serif; margin: 2rem; background: #0f1419; color: #e7e9ea; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p.lead { color: #71767b; font-size: 0.9rem; margin-top: 0.5rem; }
    table { border-collapse: collapse; width: 100%; max-width: 1400px; margin-top: 1rem; font-size: 0.78rem; }
    th, td { border: 1px solid #38444d; padding: 0.35rem 0.45rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.72rem; word-break: break-all; }
    pre.payload { margin: 0; max-height: 120px; overflow: auto; font-size: 0.72rem; white-space: pre-wrap; word-break: break-word; color: #c4cfda; }
  </style>
</head>
<body>
  <h1>GET detalle ventas (.ve) con cookies</h1>
  <p class="lead">Tabla <code>ml_ventas_detalle_web</code> · <code>raw</code> = HTML completo; <code>pos_buyer_info_text</code> = índice 0-based de <code>buyer_info_text</code>; <code>pos_label</code> = desplazamiento desde ahí hasta la primera <code>label</code> (no índice absoluto). ${rows.length} fila(s). JSON: <code>?format=json&amp;include_raw=1</code>. Prueba: <code>POST /ventas-detalle-web/retry?k=…</code> con JSON <code>write_log: true</code> para generar <code>log.txt</code> en la carpeta del proyecto. Borrar todos: <code>DELETE /admin/ventas-detalle-web</code> con cabecera <code>X-Admin-Secret</code>.</p>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>user_id</th><th>order_id</th><th>celular</th><th>pos_buyer_info_text</th><th>pos_label</th><th>url</th><th>http</th><th>body_len</th><th>error</th><th>resultado_g</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="12">Sin registros.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "POST" && url.pathname === WEBHOOK_PATH) {
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      respondJsonBodyParseError(res, e);
      return;
    }
    body = unwrapJsonBodyIfNeeded(body);
    if (isWasenderWebhookPayload(body, req)) {
      await handleWasenderWebhookPost(req, res, body, "webhook");
      return;
    }

    logWebhook(body, req);

    scheduleTopicFetchFromWebhook(body);

    if (
      !ML_WEBHOOK_FETCH_RESOURCE &&
      process.env.ML_WEBHOOK_FETCH_ORDER === "1" &&
      body.user_id &&
      body.resource
    ) {
      setImmediate(() => {
        const path = normalizeMlResourcePath(body.topic, String(body.resource));
        if (!path) return;
        mercadoLibreGetForUser(body.user_id, path).catch((e) =>
          console.error("[ml] API cuenta user_id=%s: %s", body.user_id, e.message)
        );
      });
    }

    try {
      const id = await insertWebhook(body);
      console.log("[db] webhook guardado id=%s", id);
    } catch (e) {
      console.error("[db] webhook no guardado:", e.message);
    }

    forwardWebhookToTargets(body);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, received: true }));
    return;
  }

  /** Webhooks Wasender API (alias de ruta; mismo handler que POST /webhook cuando detecta Wasender). */
  if (req.method === "POST" && matchesWasenderWebhookPostPath(url.pathname)) {
    let body;
    try {
      body = await parseJsonBody(req);
      body = unwrapJsonBodyIfNeeded(body);
    } catch (e) {
      respondJsonBodyParseError(res, e);
      return;
    }
    await handleWasenderWebhookPost(req, res, body, "path");
    return;
  }

  /** Vacía todas las filas de ml_topic_fetches (Respuestas API /fetches). */
  if (url.pathname === "/admin/topic-fetches") {
    if (req.method === "DELETE") {
      if (rejectAdminSecret(req, res)) return;
      try {
        const deleted = await deleteAllTopicFetches();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "usa DELETE" }));
    return;
  }

  /** Vacía snapshots GET detalle ventas .ve (tabla ml_ventas_detalle_web). */
  if (url.pathname === "/admin/ventas-detalle-web") {
    if (req.method === "DELETE") {
      if (rejectAdminSecret(req, res)) return;
      try {
        const deleted = await deleteAllMlVentasDetalleWeb();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "usa DELETE" }));
    return;
  }

  /** Vacía ml_questions_pending (solo base local; las preguntas siguen en Mercado Libre). */
  if (url.pathname === "/admin/ml-questions-pending" || url.pathname === "/admin/ml-questions-pending/") {
    if (req.method === "DELETE") {
      if (rejectAdminSecret(req, res)) return;
      try {
        const deleted = await deleteAllMlQuestionsPending();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "usa DELETE" }));
    return;
  }

  /**
   * Intercambia el `code` de la URL de autorización ML por tokens y guarda en ml_accounts.
   * - GET: redirect de ML (?code= / ?error=) — mismo path que Redirect URI registrada; sin X-Admin-Secret.
   * - POST JSON: { "code": "..." } cabecera X-Admin-Secret; opcional "redirect_uri".
   */
  if (url.pathname === "/admin/oauth-exchange" || url.pathname === "/admin/oauth-exchange/") {
    function oauthRedirectUriForExchange() {
      const env = process.env.OAUTH_REDIRECT_URI || process.env.ML_REDIRECT_URI;
      if (env && String(env).trim() !== "") return String(env).trim();
      const host = req.headers.host || "";
      const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
      let pathOnly = url.pathname;
      if (pathOnly.length > 1 && pathOnly.endsWith("/")) pathOnly = pathOnly.slice(0, -1);
      return `${proto}://${host}${pathOnly}`;
    }

    if (req.method === "GET") {
      const errParam = url.searchParams.get("error");
      const codeGet = url.searchParams.get("code");
      if (errParam) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!DOCTYPE html><meta charset="utf-8"/><title>OAuth ML</title><p>Mercado Libre: <code>${escapeHtml(
            errParam
          )}</code></p>`
        );
        return;
      }
      if (!codeGet || !String(codeGet).trim()) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!DOCTYPE html><meta charset="utf-8"/><title>OAuth ML</title><p>Abre la URL de autorización de la app ML. Tras aceptar, volverás aquí con <code>?code=...</code>.</p>`
        );
        return;
      }
      const redirect_uri = oauthRedirectUriForExchange();
      try {
        const data = await exchangeAuthorizationCode({
          code: String(codeGet).trim(),
          redirect_uri,
        });
        const uid = Number(data.user_id);
        const rt = data.refresh_token;
        if (!Number.isFinite(uid) || uid <= 0 || typeof rt !== "string" || !rt.trim()) {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!DOCTYPE html><meta charset="utf-8"/><p>Respuesta ML incompleta. Revisa OAUTH_CLIENT_ID/SECRET y que Redirect URI coincida con <code>${escapeHtml(
              redirect_uri
            )}</code>.</p>`
          );
          return;
        }
        const nick =
          typeof data.nickname === "string" && data.nickname.trim() !== ""
            ? data.nickname.trim()
            : null;
        await upsertMlAccount(uid, rt.trim(), nick);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!DOCTYPE html><meta charset="utf-8"/><title>Cuenta conectada</title><p>OK · <strong>user_id</strong> ${escapeHtml(
            String(uid)
          )}${nick ? ` · ${escapeHtml(nick)}` : ""}</p>`
        );
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!DOCTYPE html><meta charset="utf-8"/><p>Error al intercambiar code: ${escapeHtml(
            e.message || String(e)
          )}</p><p>Comprueba que <code>OAUTH_REDIRECT_URI</code> en el servidor sea idéntica a la Redirect URI en la app ML.</p>`
        );
      }
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "usa GET (callback ML) o POST (JSON + X-Admin-Secret)" }));
      return;
    }
    if (rejectAdminSecret(req, res)) return;
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
      return;
    }
    const code = body.code != null ? String(body.code).trim() : "";
    if (!code) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "requiere code (authorization code de la URL tras autorizar en ML)",
        })
      );
      return;
    }
    const redirect_uri =
      body.redirect_uri != null && String(body.redirect_uri).trim() !== ""
        ? String(body.redirect_uri).trim()
        : undefined;
    try {
      const data = await exchangeAuthorizationCode({ code, redirect_uri });
      const uid = Number(data.user_id);
      const rt = data.refresh_token;
      if (!Number.isFinite(uid) || uid <= 0 || typeof rt !== "string" || !rt.trim()) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "respuesta ML sin user_id o refresh_token válidos",
            debug: { keys: data && typeof data === "object" ? Object.keys(data) : [] },
          })
        );
        return;
      }
      const nick =
        typeof data.nickname === "string" && data.nickname.trim() !== ""
          ? data.nickname.trim()
          : null;
      await upsertMlAccount(uid, rt.trim(), nick);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          ml_user_id: uid,
          nickname: nick,
          expires_in: data.expires_in != null ? Number(data.expires_in) : null,
        })
      );
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  /** Varias cuentas ML: registrar refresh por user_id (misma app, distintos vendedores). */
  if (url.pathname === "/admin/ml-accounts") {
    if (req.method === "GET") {
      if (rejectAdminSecret(req, res)) return;
      try {
        const accounts = await listMlAccounts();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, accounts }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === "POST") {
      if (rejectAdminSecret(req, res)) return;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const mlUid = Number(body.ml_user_id);
      const rt = body.refresh_token;
      if (!Number.isFinite(mlUid) || mlUid <= 0 || typeof rt !== "string" || !rt.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "requiere ml_user_id (numero) y refresh_token",
          })
        );
        return;
      }
      try {
        await upsertMlAccount(mlUid, rt.trim(), typeof body.nickname === "string" ? body.nickname : null);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ml_user_id: mlUid }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === "DELETE") {
      if (rejectAdminSecret(req, res)) return;
      const uid = Number(url.searchParams.get("ml_user_id"));
      if (!Number.isFinite(uid) || uid <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?ml_user_id=123" }));
        return;
      }
      try {
        const deleted = await deleteMlAccount(uid);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted: deleted > 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  /** Cookies Netscape para GET detalle ventas (.ve); se guardan en ml_accounts.cookies_netscape. */
  if (url.pathname === "/admin/ml-web-cookies" || url.pathname === "/admin/ml-web-cookies/") {
    if (req.method === "POST") {
      if (rejectAdminSecret(req, res)) return;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const mlUid = Number(body.ml_user_id);
      let netscape = null;
      if (typeof body.cookies_netscape === "string") netscape = body.cookies_netscape;
      else if (typeof body.netscape === "string") netscape = body.netscape;
      else if (typeof body.cookies === "string") netscape = body.cookies;
      else if (Array.isArray(body.cookies)) netscape = JSON.stringify(body.cookies);
      else if (body.cookies != null && typeof body.cookies === "object")
        netscape = JSON.stringify(body.cookies);
      if (!Number.isFinite(mlUid) || mlUid <= 0 || netscape == null || String(netscape).trim() === "") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error:
              "requiere ml_user_id (numero) y cookies: cookies_netscape o netscape (texto), o cookies (string|array JSON tipo Cookie-Editor)",
          })
        );
        return;
      }
      try {
        const updated = await setMlAccountCookiesNetscape(mlUid, netscape);
        if (updated === 0) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "no hay cuenta en ml_accounts para ese ml_user_id; registra primero con POST /admin/ml-accounts",
            })
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ml_user_id: mlUid, updated }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (req.method === "DELETE") {
      if (rejectAdminSecret(req, res)) return;
      const uid = Number(url.searchParams.get("ml_user_id"));
      if (!Number.isFinite(uid) || uid <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?ml_user_id=123" }));
        return;
      }
      try {
        const deleted = await clearMlAccountCookiesNetscape(uid);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ml_user_id: uid, cleared: deleted > 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "usa POST o DELETE" }));
    return;
  }

  /** Sustituye al antiguo reg.php: POST guarda JSON, GET lista, DELETE borra por id(s). */
  if (matchesRegPath(url.pathname)) {
    if (req.method === "POST") {
      if (rejectIngestSecret(req, res)) return;
      let body;
      try {
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      try {
        const id = await insertWebhook(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, id }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET") {
      if (rejectIngestSecret(req, res)) return;
      const limit = url.searchParams.get("limit");
      try {
        const items = await listWebhooks(limit);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, items }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "DELETE") {
      if (rejectIngestSecret(req, res)) return;
      const idsParam = url.searchParams.get("ids") || url.searchParams.get("id");
      if (!idsParam || !idsParam.trim()) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "usa ?ids=1,2 o ?id=1" }));
        return;
      }
      const ids = idsParam
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => n > 0);
      try {
        const deleted = await deleteWebhooks(ids);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, deleted }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "metodo no permitido" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "no encontrado" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[db] PostgreSQL: ${dbPath}`);
  const forwards = getForwardPostUrls();
  console.log(`Escuchando en http://localhost:${PORT} (todas las interfaces, para tunel loclx/ngrok)`);
  console.log(`Webhook POST: http://localhost:${PORT}${WEBHOOK_PATH}`);
  console.log(
    `Wasender webhook: mismo POST que ML ${WEBHOOK_PATH} (detección por cuerpo) o dedicadas: ${Array.from(
      getWasenderWebhookPostPaths()
    )
      .map((p) => `http://localhost:${PORT}${p}`)
      .join(" · ")}`
  );
  console.log(
    `Registro (DB): POST|GET|DELETE http://localhost:${PORT}${REG_PATH} o .../reg.php`
  );
  if (forwards.length) {
    console.log(`Reenvío: ${forwards.length} POST(s) configurados`);
  } else {
    console.log("Reenvío: ninguno (define POST_URL_1…4 o POST_WEBHOOK_URLS)");
  }

  console.log("[config] cada POST /webhook guarda el JSON en webhook_events (tabla de /hooks)");
  if (ML_WEBHOOK_FETCH_RESOURCE) {
    console.log("[config] ML_WEBHOOK_FETCH_RESOURCE=1: tras cada webhook se hace GET a ML y se guarda en ml_topic_fetches");
  } else {
    console.warn(
      "[config] ML_WEBHOOK_FETCH_RESOURCE no es 1: no se programa fetch ni filas en ml_topic_fetches (pon ML_WEBHOOK_FETCH_RESOURCE=1)"
    );
  }

  const hasOAuth = Boolean(
    (process.env.OAUTH_CLIENT_ID || process.env.ML_CLIENT_ID) &&
      (process.env.OAUTH_CLIENT_SECRET || process.env.ML_CLIENT_SECRET) &&
      (process.env.OAUTH_REFRESH_TOKEN ||
        process.env.ML_REFRESH_TOKEN ||
        process.env.OAUTH_TOKEN_FILE)
  );
  if (hasOAuth) {
    getAccessToken()
      .then(() => console.log("OAuth: conexión OK (access_token listo)"))
      .catch((e) => console.error("OAuth:", e.message));
  }
  warmAllMlAccountsRefresh().catch((e) => console.error("[OAuth warm accounts]", e.message));
  if (process.env.ML_AUTO_SEND_POST_SALE === "1") {
    console.log(
      `[post-sale] envío automático ON (ML_AUTO_SEND_TOPICS=${process.env.ML_AUTO_SEND_TOPICS || "orders_v2"})`
    );
  }
  if (process.env.ML_QUESTIONS_IA_AUTO_ENABLED === "1") {
    try {
      const d = getQuestionsIaAutoDiagnostics();
      console.log(
        "[questions ia-auto] Arranque — modo=%s · hora local %s · ML_WEBHOOK_FETCH_RESOURCE=%s",
        d.modo_confirmacion,
        d.hora_local,
        d.checks.webhook_fetch_resource ? "OK" : "OFF (poner 1)"
      );
      console.log("[questions ia-auto] Prueba:", d.prueba);
    } catch (e) {
      console.error("[questions ia-auto] diagnóstico arranque:", e.message || e);
    }
    startQuestionsIaAutoPoll();
  }
  if (process.env.ADMIN_SECRET) {
    console.log(`Vaciar fetches ML: DELETE http://localhost:${PORT}/admin/topic-fetches (cabecera X-Admin-Secret)`);
    console.log(
      `Vaciar detalle ventas .ve: DELETE http://localhost:${PORT}/admin/ventas-detalle-web (cabecera X-Admin-Secret)`
    );
    console.log(
      `Vaciar preguntas pending (solo BD): DELETE http://localhost:${PORT}/admin/ml-questions-pending (cabecera X-Admin-Secret)`
    );
    console.log(`Cuentas ML: GET|POST|DELETE http://localhost:${PORT}/admin/ml-accounts (cabecera X-Admin-Secret)`);
    console.log(`OAuth code→cuenta: POST http://localhost:${PORT}/admin/oauth-exchange (JSON code + X-Admin-Secret)`);
    console.log(`Cuentas (navegador): http://localhost:${PORT}/cuentas?k=TU_ADMIN_SECRET`);
    console.log(`Hooks guardados: http://localhost:${PORT}/hooks?k=TU_ADMIN_SECRET`);
    console.log(`Wasender webhooks: http://localhost:${PORT}/wasender-webhooks?k=TU_ADMIN_SECRET`);
    console.log(`Fetches ML: http://localhost:${PORT}/fetches?k=TU_ADMIN_SECRET (ML_WEBHOOK_FETCH_RESOURCE=1)`);
    console.log(`Compradores ML: http://localhost:${PORT}/buyers?k=TU_ADMIN_SECRET`);
    console.log(`Inventario productos: http://localhost:${PORT}/inventario-productos?k=TU_ADMIN_SECRET`);
    console.log(`Mensajes post-venta: http://localhost:${PORT}/mensajes-postventa?k=TU_ADMIN_SECRET`);
    console.log(`WhatsApp tipo E (config): http://localhost:${PORT}/mensajes-tipo-e-whatsapp?k=TU_ADMIN_SECRET`);
    console.log(`WhatsApp tipo F (config): http://localhost:${PORT}/mensajes-tipo-f-whatsapp?k=TU_ADMIN_SECRET`);
    console.log(`Log WhatsApp Wasender E/F: http://localhost:${PORT}/envios-whatsapp-tipo-e?k=TU_ADMIN_SECRET`);
    console.log(`Log envíos post-venta: http://localhost:${PORT}/envios-postventa?k=TU_ADMIN_SECRET`);
    console.log(`Log tipos A/B/C (unificado): http://localhost:${PORT}/envios-tipos-abc?k=TU_ADMIN_SECRET`);
    console.log(`Log tipo G FileMaker: http://localhost:${PORT}/mensajes-tipo-g?k=TU_ADMIN_SECRET`);
    console.log(
      `Log recordatorios calificación: http://localhost:${PORT}/recordatorios-calificacion?k=TU_ADMIN_SECRET (alias: /recordatorios?k=…)`
    );
    console.log(`Preguntas ML (pending/answered): http://localhost:${PORT}/preguntas-ml?k=TU_ADMIN_SECRET`);
    console.log(`Sync pregunta ML→BD: http://localhost:${PORT}/preguntas-ml-refresh?k=TU_ADMIN_SECRET&ml_question_id=ID`);
    console.log(`Sync todo pending: http://localhost:${PORT}/preguntas-ml-sync-pending?k=TU_ADMIN_SECRET&limit=100`);
    console.log(`Log IA auto preguntas (omitidas): http://localhost:${PORT}/preguntas-ia-auto-log?k=TU_ADMIN_SECRET`);
    console.log(`Estado IA prueba (modo/hora): http://localhost:${PORT}/preguntas-ia-auto-status?k=TU_ADMIN_SECRET`);
    console.log(`Reintentar IA sobre pending (JSON): http://localhost:${PORT}/preguntas-ia-auto-retry?k=TU_ADMIN_SECRET`);
    console.log(`Publicaciones ML (listings por cuenta): http://localhost:${PORT}/publicaciones-ml?k=TU_ADMIN_SECRET`);
    console.log(`Banesco (conexión / monitor): http://localhost:${PORT}/banesco?k=TU_ADMIN_SECRET`);
    console.log(`Banesco JSON conexión: http://localhost:${PORT}/banesco-connection?k=TU_ADMIN_SECRET`);
    console.log(`Extractos bank_statements: http://localhost:${PORT}/statements?k=TU_ADMIN_SECRET`);
    console.log(`Acuses cambios listings: http://localhost:${PORT}/listing-change-ack?k=TU_ADMIN_SECRET`);
    console.log(`Órdenes ML (sync-orders): http://localhost:${PORT}/ordenes-ml?k=TU_ADMIN_SECRET`);
    console.log(`Mensajes pack órdenes (BD): http://localhost:${PORT}/mensajes-pack-orden?k=TU_ADMIN_SECRET`);
    console.log(`Detalle ventas web (.ve): http://localhost:${PORT}/ventas-detalle-web?k=TU_ADMIN_SECRET`);
  } else {
    console.warn(
      "[config] ADMIN_SECRET vacío o no cargado: /cuentas /hooks /wasender-webhooks /fetches /buyers /inventario-productos /mensajes-postventa /mensajes-tipo-e-whatsapp /mensajes-tipo-f-whatsapp /envios-whatsapp-tipo-e /envios-postventa /envios-tipos-abc /mensajes-tipo-g /mensajes-pack-orden /recordatorios-calificacion /preguntas-ml /preguntas-ml-refresh /preguntas-ml-sync-pending /preguntas-ia-auto-log /preguntas-ia-auto-status /preguntas-ia-auto-retry /publicaciones-ml /banesco /ventas-detalle-web responderán 503. " +
        "Si está en oauth-env.json, reinicia Node; si Windows tiene ADMIN_SECRET vacío, quítalo o rellénalo."
    );
  }
  if (process.env.FILEMAKER_TIPO_G_SECRET && String(process.env.FILEMAKER_TIPO_G_SECRET).trim() !== "") {
    console.log(
      `POST FileMaker tipo G: http://localhost:${PORT}/filemaker/tipo-g o http://localhost:${PORT}/mensajes-tipo-g (cabecera o ?secret= con FILEMAKER_TIPO_G_SECRET)`
    );
  } else {
    console.log("[config] FILEMAKER_TIPO_G_SECRET no definido: POST /filemaker/tipo-g responde 503.");
  }
  if (
    process.env.FILEMAKER_INVENTARIO_PRODUCTOS_SECRET &&
    String(process.env.FILEMAKER_INVENTARIO_PRODUCTOS_SECRET).trim() !== ""
  ) {
    console.log(
      `POST FileMaker inventario productos: http://localhost:${PORT}/filemaker/inventario-productos o http://localhost:${PORT}/mensajes-inventario-productos (FILEMAKER_INVENTARIO_PRODUCTOS_SECRET)`
    );
  } else {
    console.log(
      "[config] FILEMAKER_INVENTARIO_PRODUCTOS_SECRET no definido: POST /filemaker/inventario-productos responde 503."
    );
  }
  console.log(
    `API pública (frontend): GET http://localhost:${PORT}/api/v1 · /api/v1/health — catálogo: /api/v1/catalog + cabecera X-API-KEY (FRONTEND_API_KEY)`
  );
  if (!process.env.FRONTEND_API_KEY || String(process.env.FRONTEND_API_KEY).trim() === "") {
    console.log("[config] FRONTEND_API_KEY no definido: GET /api/v1/catalog responde 503.");
  }
  console.log(`Token (enmascarado): GET http://localhost:${PORT}/oauth/token-status`);
});

startBanescoMonitor();
