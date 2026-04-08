/**
 * GET /orders/{ORDER_ID}/feedback por cada orden en BD: upsert en ml_order_feedback y
 * actualización de feedback_sale / feedback_purchase en ml_orders (mismo criterio que order_search).
 *
 * Para órdenes confirmadas (todas las cuentas):
 *   node ml-order-feedback-sync.js --all --status=confirmed
 *
 * Uso: node ml-order-feedback-sync.js [--user=ML_USER_ID] [--all] [--limit=500] [--delay-ms=350] [--status=confirmed]
 * Env: ML_ORDER_FEEDBACK_SYNC_DELAY_MS  ML_ORDER_FEEDBACK_SYNC_LIMIT  DATABASE_URL
 */
require("./load-env-local");

const { mercadoLibreFetchForUser } = require("./oauth-token");
const { feedbackDetailRowsFromOrder, feedbackSummaryFromOrder } = require("./ml-order-map");
const {
  listMlAccounts,
  listMlOrdersByUser,
  upsertMlOrder,
  upsertMlOrderFeedback,
  updateMlOrderFeedbackSummary,
} = require("./db");

function sleep(ms) {
  return new Promise((r) => setTimeout(r));
}

function defaultLimit() {
  const n = Number(process.env.ML_ORDER_FEEDBACK_SYNC_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

function defaultDelayMs() {
  const n = Number(process.env.ML_ORDER_FEEDBACK_SYNC_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 350;
}

/**
 * Persista en BD el JSON de GET /orders/{id}/feedback (o el cuerpo ya obtenido por webhook orders_feedback).
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {object} data - cuerpo JSON API (sale/purchase en raíz o bajo `feedback`)
 * @param {string} fetchedAt
 * @param {string} [source] - origen para ml_order_feedback.source
 * @returns {Promise<{ ok: boolean, upserted: number, err?: string }>}
 */
async function upsertOrderFeedbackFromApiResponse(
  mlUserId,
  orderId,
  data,
  fetchedAt,
  source = "orders_feedback_get"
) {
  const oid = orderId != null ? Number(orderId) : NaN;
  const uid = Number(mlUserId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return { ok: false, upserted: 0, err: "ids inválidos" };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, upserted: 0, err: "respuesta sin JSON objeto" };
  }

  const feedbackRoot =
    data.feedback && typeof data.feedback === "object" ? data.feedback : data;

  const rows = feedbackDetailRowsFromOrder(uid, oid, feedbackRoot, {
    fetched_at: fetchedAt,
    source,
  });

  let upserted = 0;
  for (const row of rows) {
    await upsertMlOrderFeedback(row);
    upserted++;
  }

  const summary = feedbackSummaryFromOrder({ feedback: feedbackRoot });
  let orderRowsUpdated = await updateMlOrderFeedbackSummary(
    uid,
    oid,
    summary.feedback_sale,
    summary.feedback_purchase
  );
  /** Si la orden aún no estaba en `ml_orders` (sync pendiente), crear/actualizar fila mínima con la calificación del comprador. */
  if (orderRowsUpdated === 0) {
    const now = new Date().toISOString();
    let rawJson;
    try {
      rawJson = JSON.stringify({
        order_id: oid,
        feedback: feedbackRoot,
        _source: "orders_feedback_api",
      });
    } catch {
      rawJson = "{}";
    }
    await upsertMlOrder({
      ml_user_id: uid,
      order_id: oid,
      status: null,
      date_created: null,
      total_amount: null,
      currency_id: null,
      buyer_id: null,
      feedback_sale: summary.feedback_sale,
      feedback_purchase: summary.feedback_purchase,
      raw_json: rawJson,
      http_status: null,
      sync_error: null,
      fetched_at: fetchedAt,
      updated_at: now,
    });
    orderRowsUpdated = 1;
  }

  if (process.env.SALES_ML_IMPORT_ENABLED === "1") {
    setImmediate(() => {
      try {
        const salesService = require("./src/services/salesService");
        salesService.syncMercadolibreSalesAfterMlOrderChange({ mlUserId: uid, orderId: oid }).catch((e) => {
          console.error("[sales ml sync]", e && e.message ? e.message : e);
        });
      } catch (e) {
        console.error("[sales ml sync]", e && e.message ? e.message : e);
      }
    });
  }

  return { ok: true, upserted, orderRowsUpdated };
}

/**
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {string} fetchedAt
 * @returns {Promise<{ ok: boolean, upserted: number, status?: number, err?: string }>}
 */
async function fetchAndUpsertOrderFeedback(mlUserId, orderId, fetchedAt) {
  const oid = orderId != null ? Number(orderId) : NaN;
  const uid = Number(mlUserId);
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return { ok: false, upserted: 0, err: "ids inválidos" };
  }

  const path = `/orders/${oid}/feedback`;
  const res = await mercadoLibreFetchForUser(uid, path);

  if (!res.ok) {
    const errPreview = (res.rawText || `HTTP ${res.status}`).slice(0, 400);
    return { ok: false, upserted: 0, status: res.status, err: errPreview };
  }

  const data = res.data && typeof res.data === "object" ? res.data : null;
  if (!data) {
    return { ok: false, upserted: 0, err: "respuesta sin JSON objeto" };
  }

  const out = await upsertOrderFeedbackFromApiResponse(uid, oid, data, fetchedAt, "orders_feedback_get");
  return out.ok ? { ok: true, upserted: out.upserted } : out;
}

/**
 * @param {number} mlUserId
 * @param {{ limit?: number, delayMs?: number, status?: string|null }} [options]
 */
async function syncOrderFeedbackForMlUser(mlUserId, options = {}) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    return {
      ok: false,
      orders_seen: 0,
      api_ok: 0,
      api_fail: 0,
      feedback_rows: 0,
      error: "ml_user_id inválido",
    };
  }

  const limit =
    options.limit != null && Number.isFinite(Number(options.limit))
      ? Math.max(1, Math.min(10000, Number(options.limit)))
      : defaultLimit();
  const delayMs =
    options.delayMs != null && Number.isFinite(Number(options.delayMs))
      ? Math.max(0, Number(options.delayMs))
      : defaultDelayMs();
  const st =
    options.status != null && String(options.status).trim() !== ""
      ? String(options.status).trim()
      : null;
  const listOpts = st ? { status: st } : {};

  const orders = await listMlOrdersByUser(mlUid, limit, 10000, listOpts);

  let apiOk = 0;
  let apiFail = 0;
  let feedbackRows = 0;

  for (const o of orders) {
    const fetchedAt = new Date().toISOString();
    const r = await fetchAndUpsertOrderFeedback(mlUid, o.order_id, fetchedAt);
    if (r.ok) {
      apiOk++;
      feedbackRows += r.upserted;
    } else {
      apiFail++;
      if (r.status !== 404) {
        console.warn(
          "[ml-order-feedback-sync] ml_user_id=%s order_id=%s status=%s %s",
          mlUid,
          o.order_id,
          r.status ?? "—",
          r.err || ""
        );
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    ok: true,
    orders_seen: orders.length,
    api_ok: apiOk,
    api_fail: apiFail,
    feedback_rows: feedbackRows,
  };
}

function parseStatusesArg(str) {
  if (str == null || String(str).trim() === "") return null;
  return String(str)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  let userId =
    process.env.ML_ORDER_FEEDBACK_SYNC_USER_ID != null
      ? Number(process.env.ML_ORDER_FEEDBACK_SYNC_USER_ID)
      : null;
  let all =
    process.env.ML_ORDER_FEEDBACK_SYNC_ALL === "1" ||
    process.env.ML_ORDER_FEEDBACK_SYNC_ALL === "true";
  let limit = null;
  let delayMs = null;
  let status = null;
  const cleaned = argv.map((a) => String(a).replace(/^\uFEFF/, "").trim());
  for (const a of cleaned) {
    const lower = a.toLowerCase();
    if (lower === "--all" || lower === "-a") {
      all = true;
    } else if (a.startsWith("--user=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) userId = n;
    } else if (a.startsWith("--limit=")) {
      const n = Number(a.slice(8));
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (a.startsWith("--delay-ms=")) {
      const n = Number(a.slice(11));
      if (Number.isFinite(n) && n >= 0) delayMs = n;
    } else if (a.startsWith("--status=")) {
      const parts = parseStatusesArg(a.slice(9));
      status = parts && parts.length === 1 ? parts[0] : null;
      if (parts && parts.length > 1) {
        console.warn("[ml-order-feedback-sync] usa un solo --status=; se tomó el primero");
        status = parts[0];
      }
    }
  }
  return { userId, all, limit, delayMs, status };
}

async function main() {
  const { userId, all, limit, delayMs, status } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[ml-order-feedback-sync] DATABASE_URL no definida.");
    process.exit(1);
  }

  const accounts = await listMlAccounts();
  if (!accounts.length) {
    console.error("[ml-order-feedback-sync] No hay cuentas en ml_accounts.");
    process.exit(1);
  }

  let targets = [];
  if (all) {
    targets = accounts.map((a) => Number(a.ml_user_id));
  } else if (userId != null && Number.isFinite(userId) && userId > 0) {
    targets = [userId];
  } else {
    targets = [Number(accounts[0].ml_user_id)];
    console.log(
      "[ml-order-feedback-sync] Sin --user ni --all: usando primera cuenta %s",
      targets[0]
    );
  }

  const opts = {};
  if (limit != null) opts.limit = limit;
  if (delayMs != null) opts.delayMs = delayMs;
  if (status != null) opts.status = status;

  console.log(
    "[ml-order-feedback-sync] limit=%s delay_ms=%s status=%s",
    opts.limit ?? defaultLimit(),
    opts.delayMs ?? defaultDelayMs(),
    status || "—"
  );

  const results = [];
  for (const uid of targets) {
    console.log("[ml-order-feedback-sync] ml_user_id=%s …", uid);
    const r = await syncOrderFeedbackForMlUser(uid, opts);
    results.push({ ml_user_id: uid, ...r });
    console.log(
      "[ml-order-feedback-sync] ml_user_id=%s ok=%s orders=%s api_ok=%s api_fail=%s filas_feedback=%s err=%s",
      uid,
      r.ok,
      r.orders_seen,
      r.api_ok,
      r.api_fail,
      r.feedback_rows,
      r.error || "—"
    );
  }

  const failed = results.filter((x) => !x.ok);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ml-order-feedback-sync]", e);
    process.exit(1);
  });
}

module.exports = {
  syncOrderFeedbackForMlUser,
  fetchAndUpsertOrderFeedback,
  upsertOrderFeedbackFromApiResponse,
};
