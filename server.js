require("./load-env-local");
const { ensureMlCookiesDir } = require("./ml-cookies-path");
ensureMlCookiesDir();
const http = require("http");
const pkg = require("./package.json");
const { extractSkuTitleFromMlResponse } = require("./ml-payload-extract");
const { extractOrderIdFromOrder } = require("./ml-pack-extract");
const { extractBuyerFromOrderPayload } = require("./ml-buyer-extract");
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
  listMlBuyers,
  updateMlBuyerPhones,
  listPostSaleMessages,
  insertPostSaleMessage,
  updatePostSaleMessage,
  deletePostSaleMessage,
  listPostSaleAutoSendLog,
  listMlVentasDetalleWeb,
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

function isOrdersV2Notification(body) {
  return (
    body &&
    typeof body === "object" &&
    typeof body.topic === "string" &&
    typeof body.resource === "string" &&
    (body.topic === "orders_v2" || body.topic.startsWith("orders"))
  );
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
                  await upsertMlBuyer(buyer);
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
                setImmediate(() => {
                  fetchVentasDetalleAndStore({ mlUserId, orderId: ventasOrderId }).catch((e) =>
                    console.error("[ventas-detalle]", e.message)
                  );
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
          "POST /admin/ml-accounts (cabecera X-Admin-Secret) registra refresh por ml_user_id",
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
        buyers_ml:
          "GET /buyers?k=ADMIN_SECRET (compradores). PUT /buyers?k=… JSON {buyer_id, phone_1?, phone_2?} (cabecera X-Admin-Secret alternativa)",
        mensajes_postventa:
          "GET|POST|DELETE /mensajes-postventa?k=ADMIN_SECRET (plantillas post-venta; JSON en POST/DELETE)",
        envio_auto_postventa:
          "ML_AUTO_SEND_POST_SALE=1, ML_AUTO_SEND_TOPICS=… · ML_POST_SALE_TOTAL_MESSAGES=1|2|3 (plantillas por id en post_sale_messages) · ML_POST_SALE_EXTRA_DELAY_MS · placeholders {{order_id}} {{buyer_id}} {{seller_id}}",
        log_envios_postventa:
          "GET /envios-postventa?k=ADMIN_SECRET (historial). POST /envios-postventa/retry?k=… JSON {order_id,ml_user_id,buyer_id?} opcional force, topic",
        cookies_ml_web:
          "ML_COOKIES_DIR: carpeta con cookies por cuenta ({ml_user_id}.txt). Por defecto carpeta data/ (ignorada en git).",
        ventas_detalle_web:
          "ml_ventas_detalle_web.raw = HTML; resultado_g = preview. GET /ventas-detalle-web?k= & format=json&include_raw=1 — POST .../ventas-detalle-web/retry prueba",
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
        return `<tr>
  <td>${escapeHtml(row.ml_user_id)}</td>
  <td>${escapeHtml(row.nickname)}</td>
  <td>${badge}</td>
  <td>${tokenCell}</td>
  <td>${caduca}</td>
  <td>${seg}</td>
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
      <th>Caduca (UTC)</th><th>Seg. restantes</th><th>Actualizado (DB)</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="7">No hay cuentas registradas.</td></tr>'}</tbody>
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
        body = await parseJsonBody(req);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "body debe ser JSON" }));
        return;
      }
      const buyerId = Number(body.buyer_id);
      if (!Number.isFinite(buyerId) || buyerId <= 0) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "buyer_id inválido" }));
        return;
      }
      try {
        const buyer = await updateMlBuyerPhones(buyerId, {
          phone_1: body.phone_1,
          phone_2: body.phone_2,
        });
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
    try {
      rows = await listMlBuyers(lim, 2000);
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
    const buyerRows = rows
      .map(
        (r) => `<tr>
  <td>${escapeHtml(r.buyer_id)}</td>
  <td>${escapeHtml(r.nickname)}</td>
  <td>${escapeHtml(r.phone_1)}</td>
  <td>${escapeHtml(r.phone_2)}</td>
  <td class="muted">${escapeHtml(r.created_at)}</td>
  <td class="muted">${escapeHtml(r.updated_at)}</td>
</tr>`
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
  <p class="lead">${rows.length} registro(s). Se rellenan al guardar fetches de <code>orders_v2</code> (objeto <code>buyer</code> de la API). JSON: <code>?format=json</code>.</p>
  <table>
    <thead><tr><th>buyer_id</th><th>nickname</th><th>phone_1</th><th>phone_2</th><th>created_at</th><th>updated_at</th></tr></thead>
    <tbody>${buyerRows || '<tr><td colspan="6">No hay compradores guardados.</td></tr>'}</tbody>
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
    if (!Number.isFinite(mlUserId) || mlUserId <= 0 || !Number.isFinite(orderId) || orderId <= 0) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "ml_user_id y order_id numéricos requeridos" }));
      return;
    }
    try {
      const result = await fetchVentasDetalleAndStore({ mlUserId, orderId });
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
  <p class="lead">Tabla <code>ml_ventas_detalle_web</code> · columna <code>raw</code> = HTML completo. ${rows.length} fila(s). JSON: <code>?format=json&amp;include_raw=1</code> para traer <code>raw</code>. Prueba: <code>POST /ventas-detalle-web/retry?k=…</code>.</p>
  <table>
    <thead><tr><th>id</th><th>created_at</th><th>user_id</th><th>order_id</th><th>celular</th><th>url</th><th>http</th><th>body_len</th><th>error</th><th>resultado_g</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="10">Sin registros.</td></tr>'}</tbody>
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

    if (!isOrdersV2Notification(body)) {
      forwardWebhookToTargets(body);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, received: true, note: "payload sin formato orders_v2 esperado" }));
      return;
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
