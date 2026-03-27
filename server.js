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
const { extractOrderIdFromOrder } = require("./ml-pack-extract");
const { extractBuyerFromOrderPayload } = require("./ml-buyer-extract");
const { upsertBuyerFromOrdersV2Webhook } = require("./ml-buyer-order-sync");
const {
  normalizeBuyerPrefEntrega,
  BUYER_PREF_ENTREGA_VALUES,
  normalizeCambioDatos,
  normalizeNombreApellido,
} = require("./ml-buyer-pref");
const { fetchVentasDetalleAndStore } = require("./ml-ventas-detalle-fetch");
const { enrichNicknameForFetches } = require("./ml-nickname-enrich");
const { renderPostSaleMessagesPage } = require("./post-sale-messages-html");
const { trySendDefaultPostSaleMessage } = require("./ml-post-sale-send");
const {
  getAccessToken,
  getAccessTokenForMlUser,
  mercadoLibreGetForUser,
  mercadoLibreFetchForUser,
  normalizeMlResourcePath,
  warmAllMlAccountsRefresh,
  getTokenStatus,
  getTokenStatusForMlUser,
} = require("./oauth-token");
const {
  insertWebhook,
  listWebhooks,
  deleteWebhooks,
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
  listMlVentasDetalleWeb,
  deleteAllMlVentasDetalleWeb,
  getMlAccount,
  deletePostSaleSent,
  dbPath,
} = require("./db");

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook";
const REG_PATH = process.env.REG_PATH || "/reg";
const WEBHOOK_SAVE_DB = process.env.WEBHOOK_SAVE_DB === "1";
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

function isFetchesPath(pathname) {
  return pathname === "/fetches" || pathname === "/fetches/";
}

function isBuyersPath(pathname) {
  return pathname === "/buyers" || pathname === "/buyers/";
}

function isPostSaleMessagesPath(pathname) {
  return pathname === "/mensajes-postventa" || pathname === "/mensajes-postventa/";
}

function isPostSaleEnviosPath(pathname) {
  return pathname === "/envios-postventa" || pathname === "/envios-postventa/";
}

function isVentasDetalleWebPath(pathname) {
  return pathname === "/ventas-detalle-web" || pathname === "/ventas-detalle-web/";
}

function rejectIngestSecret(req, res) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  if (req.headers["x-ingest-secret"] !== secret) {
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
  if (req.headers["x-admin-secret"] !== secret) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "no autorizado" }));
    return true;
  }
  return false;
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
    const topic = typeof body.topic === "string" ? body.topic : null;
    const resourceStr = String(resource);
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
              (topic === "orders_v2" || String(topic).startsWith("orders"))
            ) {
              const buyer = extractBuyerFromOrderPayload(parsed);
              if (buyer) {
                try {
                  await upsertBuyerFromOrdersV2Webhook(buyer);
                } catch (errBuyer) {
                  console.error("[ml buyers]", errBuyer.message);
                }
              }
            }
            if (
              result.ok &&
              ML_WEBHOOK_FETCH_VENTAS_DETALLE &&
              topic &&
              (topic === "orders_v2" || String(topic).startsWith("orders"))
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

        const isOrderTopic =
          topic && (topic === "orders_v2" || String(topic).startsWith("orders"));
        /** Solo orders_v2 se considera “hook procesado” para el estado final; otros topics quedan en pendiente. */
        const isOrdersV2Topic = topic === "orders_v2";

        let processStatus = FETCH_PROCESS_STATUS_DONE;
        if (result.ok && isOrderTopic) {
          try {
            const ps = await trySendDefaultPostSaleMessage({
              mlUserId,
              topic,
              payload: parsed,
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
        if (result.ok && !isOrdersV2Topic) {
          processStatus = FETCH_PROCESS_STATUS_PENDING;
        }

        /** Post-venta automático para topics no-orden: solo `messages` (order_id en payload). No stock-locations ni otros. */
        if (result.ok && parsed && !isOrderTopic && topic === "messages") {
          setImmediate(() => {
            trySendDefaultPostSaleMessage({
              mlUserId,
              topic,
              payload: parsed,
              notificationId: notifId,
            }).catch((e) => console.error("[post-sale]", e.message));
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

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "webhook-receiver",
        version: pkg.version,
        database: {
          backend:
            process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()
              ? "postgresql"
              : "sqlite",
          info: dbPath,
        },
        webhook: WEBHOOK_PATH,
        multi_cuentas_ml:
          "POST /admin/ml-accounts (cabecera X-Admin-Secret) registra refresh por ml_user_id · POST /admin/ml-web-cookies JSON {ml_user_id, cookies_netscape} — cookies en BD; DELETE ?ml_user_id= — borra",
        oauth_token_status:
          "GET /oauth/token-status  o  ?ml_user_id=  (token enmascarado, sin secreto completo)",
        cuentas_ml:
          "GET /cuentas?k=ADMIN_SECRET (lista cuentas; mismo valor que variable ADMIN_SECRET)",
        hooks_recibidos:
          "GET /hooks?k=ADMIN_SECRET (webhooks guardados en DB; activar WEBHOOK_SAVE_DB o POST /reg)",
        topic_fetches_ml:
          "GET /fetches?k=ADMIN_SECRET (orden por topic; ?topic=orders_v2 filtra; ML_WEBHOOK_FETCH_RESOURCE=1)",
        borrar_todos_los_fetches:
          "DELETE /admin/topic-fetches (cabecera X-Admin-Secret) vacía tabla ml_topic_fetches",
        borrar_snapshots_ventas_detalle_ve:
          "DELETE /admin/ventas-detalle-web (cabecera X-Admin-Secret) vacía ml_ventas_detalle_web (GET detalle .ve con cookies)",
        buyers_ml:
          "GET /buyers?k=ADMIN_SECRET (ml_buyers: nombre_apellido, pref_entrega default Pickup, actualizacion ISO). POST/PUT JSON buyer_id + campos opcionales (cabecera X-Admin-Secret alternativa)",
        mensajes_postventa:
          "GET|POST|DELETE /mensajes-postventa?k=ADMIN_SECRET (plantillas post-venta; JSON en POST/DELETE)",
        envio_auto_postventa:
          "ML_AUTO_SEND_POST_SALE=1, ML_AUTO_SEND_TOPICS=… · ML_POST_SALE_TOTAL_MESSAGES=1|2|3 (plantillas por id en post_sale_messages) · ML_POST_SALE_EXTRA_DELAY_MS · placeholders {{order_id}} {{buyer_id}} {{seller_id}}",
        log_envios_postventa:
          "GET /envios-postventa?k=ADMIN_SECRET (historial). POST /envios-postventa/retry?k=… JSON {order_id,ml_user_id,buyer_id?} opcional force, topic",
        cookies_ml_web:
          "Cookies detalle .ve: prioridad (1) ml_accounts.cookies_netscape (POST /admin/ml-web-cookies), (2) archivo, (3) ML_COOKIE_NETSCAPE_*. Formatos: Netscape, JSON o Header String (Cookie-Editor).",
        ventas_detalle_web:
          "ml_ventas_detalle_web.raw = HTML; GET /ventas-detalle-web?k= & format=json&include_raw=1 — POST retry JSON write_log:true o ML_VENTAS_DETALLE_LOG_FILE=1 → log.txt (ML_VENTAS_DETALLE_LOG_PATH opcional) — DELETE /admin/ventas-detalle-web vacía la tabla",
      })
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
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

  /** Webhooks guardados en SQLite (misma clave ADMIN_SECRET que /cuentas). */
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
  <p class="lead">${items.length} registro(s). Solo aparecen los que se guardaron (POST a <code>/reg</code> o <code>WEBHOOK_SAVE_DB=1</code> en <code>/webhook</code>). Parametro <code>limit</code> (max 2000). Cuerpo completo del webhook: <code>?format=json</code> (API).</p>
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
  <p class="lead">${rows.length} registro(s)${topicFilter ? ` · filtro: <code>${escapeHtml(topicFilter)}</code>` : ""}. Cuerpo JSON de la respuesta ML (payload): <code>?format=json</code>. <strong>estado</strong>: con topic <code>orders_v2</code>, tras el GET a ML puede quedar <code>Completado</code> o <code>Fallo post-venta</code>. Si el topic <strong>no</strong> es <code>orders_v2</code>, tras un fetch OK sigue <code>Procesando...</code>. Orden: por topic (A→Z), id reciente primero.</p>
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
          return `<tr>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.nickname)}</td>
  <td>${escapeHtml(r.nombre_apellido)}</td>
  <td>${escapeHtml(r.phone_1)}</td>
  <td>${escapeHtml(r.phone_2)}</td>
  <td>${escapeHtml(r.pref_entrega)}</td>
  <td class="muted" style="max-width:280px;white-space:pre-wrap;word-break:break-word;">${cdShort || "—"}</td>
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
    table { border-collapse: collapse; width: 100%; max-width: 960px; margin-top: 1rem; font-size: 0.85rem; }
    th, td { border: 1px solid #38444d; padding: 0.45rem 0.55rem; text-align: left; vertical-align: top; }
    th { background: #1e2732; }
    tr:nth-child(even) td { background: #192734; }
    .muted { color: #8b98a5; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Compradores (ml_buyers)</h1>
  <p class="lead"><strong>${totalEnTabla}</strong> fila(s) en total en la tabla. Mostrando <strong>${rows.length}</strong> en esta vista (orden por última actualización; <code>?limit=</code> hasta 2000). <code>pref_entrega</code> por defecto <code>Pickup</code> si no viene en el webhook. <code>actualizacion</code> = última modificación (ISO). JSON: <code>?format=json</code> incluye <code>total</code> y <code>count</code> (filas devueltas).</p>
  <table>
    <thead><tr><th>buyer_id</th><th>nickname</th><th>nombre y apellido</th><th>phone_1</th><th>phone_2</th><th>pref_entrega</th><th>cambio_datos</th><th>actualizacion</th><th>created_at</th><th>updated_at</th></tr></thead>
    <tbody>${buyerRows || '<tr><td colspan="10">No hay compradores guardados.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buyersHtml);
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
      { key: "default", label: "Por defecto (error 1.er mensaje)" },
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
  <p class="lead">Tabla <code>ml_post_sale_auto_send_log</code> · <code>order_id</code> = id de orden en la URL de mensajería ML. ${rows.length} fila(s) con el filtro actual. JSON: <code>?format=json&amp;outcome=…</code>. Reintento: <code>POST /envios-postventa/retry?k=…</code> con JSON <code>order_id</code>, <code>ml_user_id</code>, opcional <code>buyer_id</code>, <code>force</code>.</p>
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
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
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

    if (WEBHOOK_SAVE_DB) {
      try {
        const id = await insertWebhook(body);
        console.log("[db] guardado id=%s", id);
      } catch (e) {
        console.error("[db]", e.message);
      }
    }

    forwardWebhookToTargets(body);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, received: true }));
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
  const dbKind =
    String(dbPath).startsWith("postgresql:") || String(dbPath).includes("postgresql://")
      ? "PostgreSQL"
      : "SQLite";
  console.log(`[db] ${dbKind}: ${dbPath}`);
  const forwards = getForwardPostUrls();
  console.log(`Escuchando en http://localhost:${PORT} (todas las interfaces, para tunel loclx/ngrok)`);
  console.log(`Webhook POST: http://localhost:${PORT}${WEBHOOK_PATH}`);
  console.log(
    `Registro (DB): POST|GET|DELETE http://localhost:${PORT}${REG_PATH} o .../reg.php`
  );
  if (forwards.length) {
    console.log(`Reenvío: ${forwards.length} POST(s) configurados`);
  } else {
    console.log("Reenvío: ninguno (define POST_URL_1…4 o POST_WEBHOOK_URLS)");
  }

  if (WEBHOOK_SAVE_DB) {
    console.log("[config] WEBHOOK_SAVE_DB=1: cada POST /webhook guarda el JSON en la tabla de webhooks");
  } else {
    console.warn(
      "[config] WEBHOOK_SAVE_DB no es 1: POST /webhook no persiste hooks (pon WEBHOOK_SAVE_DB=1 en el entorno u oauth-env.json)"
    );
  }
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
  if (process.env.ADMIN_SECRET) {
    console.log(`Vaciar fetches ML: DELETE http://localhost:${PORT}/admin/topic-fetches (cabecera X-Admin-Secret)`);
    console.log(
      `Vaciar detalle ventas .ve: DELETE http://localhost:${PORT}/admin/ventas-detalle-web (cabecera X-Admin-Secret)`
    );
    console.log(`Cuentas ML: GET|POST|DELETE http://localhost:${PORT}/admin/ml-accounts (cabecera X-Admin-Secret)`);
    console.log(`Cuentas (navegador): http://localhost:${PORT}/cuentas?k=TU_ADMIN_SECRET`);
    console.log(`Hooks guardados: http://localhost:${PORT}/hooks?k=TU_ADMIN_SECRET`);
    console.log(`Fetches ML: http://localhost:${PORT}/fetches?k=TU_ADMIN_SECRET (ML_WEBHOOK_FETCH_RESOURCE=1)`);
    console.log(`Compradores ML: http://localhost:${PORT}/buyers?k=TU_ADMIN_SECRET`);
    console.log(`Mensajes post-venta: http://localhost:${PORT}/mensajes-postventa?k=TU_ADMIN_SECRET`);
    console.log(`Log envíos post-venta: http://localhost:${PORT}/envios-postventa?k=TU_ADMIN_SECRET`);
    console.log(`Detalle ventas web (.ve): http://localhost:${PORT}/ventas-detalle-web?k=TU_ADMIN_SECRET`);
  } else {
    console.warn(
      "[config] ADMIN_SECRET vacío o no cargado: /cuentas /hooks /fetches /buyers /mensajes-postventa /envios-postventa /ventas-detalle-web responderán 503. " +
        "Si está en oauth-env.json, reinicia Node; si Windows tiene ADMIN_SECRET vacío, quítalo o rellénalo."
    );
  }
  console.log(`Token (enmascarado): GET http://localhost:${PORT}/oauth/token-status`);
});
