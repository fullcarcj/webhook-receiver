/**
 * Sincroniza mensajería post-venta (pack) por orden desde la API de Mercado Libre hacia PostgreSQL.
 *
 * GET /messages/packs/{order_id}/sellers/{seller_id}?tag=post_sale&api_version=4&limit=&offset=&mark_as_read=false
 * (el id del pack en post-venta suele ser el order_id; multicuenta: un seller_id por fila en ml_accounts).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * LÍMITES DE API (no hay “sync sin límite” real)
 * ═══════════════════════════════════════════════════════════════════════════════════
 * La documentación de Mercado Libre indica un tope del orden de ~18.000 solicitudes/hora por
 * aplicación (y además límites por recurso, p. ej. ~500 rpm en consultas). Este job hace UNA
 * o más GET por cada orden que proceses; si recorres todo el histórico sin paginar cuentas,
 * puedes acercarte o superar el tope.
 *
 * Recomendaciones:
 *   • ML_PACK_MESSAGES_SYNC_DELAY_MS — pausa entre cada GET (p. ej. 250 ms ≈ 4 req/s ≈ 14.400/h).
 *   • ML_PACK_MESSAGES_SYNC_ORDER_LIMIT — máximo de órdenes por cuenta y ejecución (default 300).
 *   • --since-days=N — solo órdenes cuya date_created en ml_orders sea reciente (reduce GETs).
 *   • Ejecutar con menor frecuencia o por cuenta (--user) en horas valle.
 *   • mark_as_read=false (por defecto aquí) para no marcar leídos al archivar.
 *
 * Uso:
 *   node ml-pack-messages-sync.js [--user=ML_USER_ID] [--all] [--since-days=7] [--order-limit=300]
 *   npm run sync-pack-messages-all
 *
 * Env: ML_PACK_MESSAGES_SYNC_TAG (default post_sale)  ML_PACK_MESSAGES_SYNC_PAGE_SIZE (default 50)
 *      ML_PACK_MESSAGES_SYNC_DELAY_MS  ML_PACK_MESSAGES_SYNC_ORDER_LIMIT
 *      ML_APPLICATION_ID / OAUTH_CLIENT_ID (query application_id, alineado con post-venta)
 */
require("./load-env-local");

const { mercadoLibreFetchForUser } = require("./oauth-token");
const {
  messagesArrayFromPackBody,
  pagingTotalFromPackBody,
  orderPackMessageRowFromApi,
  orderPackMessageRowFromWebhookMessageGet,
} = require("./ml-pack-messages-map");
const { listMlAccounts, listMlOrdersByUser, upsertMlOrderPackMessage } = require("./db");

const DEFAULT_PAGE_SIZE = Math.min(
  50,
  Math.max(1, Number(process.env.ML_PACK_MESSAGES_SYNC_PAGE_SIZE) || 50)
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Guarda en `ml_order_pack_messages` el mensaje devuelto por GET /messages/{id} (webhook).
 * Necesario cuando el pack `/messages/packs/{order_id}/sellers/...` aún no existe (404 / vacío).
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {object} parsed — JSON del GET
 * @param {{ tag?: string, resourceStr?: string }} [opts]
 */
async function persistPackMessageFromWebhookFetch(mlUserId, orderId, parsed, opts = {}) {
  const tag = opts.tag != null ? String(opts.tag).trim() : "";
  const tagNorm =
    tag ||
    (process.env.ML_PACK_MESSAGES_SYNC_TAG || "post_sale").trim() ||
    "post_sale";
  const fetchedAt = new Date().toISOString();
  const row = orderPackMessageRowFromWebhookMessageGet(
    mlUserId,
    orderId,
    tagNorm,
    parsed,
    fetchedAt,
    opts.resourceStr
  );
  if (!row) {
    return { ok: false, reason: "no_mappable_message" };
  }
  await upsertMlOrderPackMessage(row);
  return { ok: true, ml_message_id: row.ml_message_id };
}

function packMessagesPath(mlUserId, orderId, offset, limit, tag, appId) {
  const p = new URLSearchParams();
  p.set("tag", tag);
  p.set("api_version", "4");
  p.set("limit", String(limit));
  p.set("offset", String(Math.max(0, offset)));
  p.set("mark_as_read", "false");
  if (appId) p.set("application_id", String(appId));
  return `/messages/packs/${orderId}/sellers/${mlUserId}?${p.toString()}`;
}

function orderDateForFilter(row, sinceCutoffMs) {
  if (sinceCutoffMs == null) return true;
  const dc = row.date_created;
  if (dc == null || String(dc).trim() === "") return true;
  const t = Date.parse(String(dc));
  if (!Number.isFinite(t)) return true;
  return t >= sinceCutoffMs;
}

/**
 * @param {number} mlUserId
 * @param {number} orderId
 * @param {{ tag: string, appId: string, pageSize: number, delayMs: number }} opts
 * @returns {Promise<{ ok: boolean, upserted: number, pages: number, error?: string }>}
 */
async function syncPackMessagesForOrder(mlUserId, orderId, opts) {
  const mlUid = Number(mlUserId);
  const oid = Number(orderId);
  if (!Number.isFinite(mlUid) || mlUid <= 0 || !Number.isFinite(oid) || oid <= 0) {
    return { ok: false, upserted: 0, pages: 0, error: "ml_user_id u order_id inválido" };
  }

  let upserted = 0;
  let pages = 0;
  let offset = 0;
  const now = () => new Date().toISOString();
  const tag = opts.tag;
  const pageSize = opts.pageSize;
  const delayMs = opts.delayMs;

  try {
    let totalKnown = null;
    for (;;) {
      const path = packMessagesPath(mlUid, oid, offset, pageSize, tag, opts.appId);
      const res = await mercadoLibreFetchForUser(mlUid, path);
      pages++;

      if (!res.ok) {
        const errText = (res.rawText || `HTTP ${res.status}`).slice(0, 2000);
        if (res.status === 404) {
          return { ok: true, upserted, pages, error: null, empty: true };
        }
        return { ok: false, upserted, pages, error: errText };
      }

      const data = res.data && typeof res.data === "object" ? res.data : {};
      if (totalKnown == null) {
        totalKnown = pagingTotalFromPackBody(data);
      }
      const msgs = messagesArrayFromPackBody(data);
      const fetchedAt = now();

      for (const m of msgs) {
        const row = orderPackMessageRowFromApi(mlUid, oid, tag, m, fetchedAt);
        if (row) {
          await upsertMlOrderPackMessage(row);
          upserted++;
        }
      }

      if (msgs.length < pageSize) {
        break;
      }
      if (totalKnown != null && offset + msgs.length >= totalKnown) {
        break;
      }
      offset += msgs.length;
      if (delayMs > 0) await sleep(delayMs);
    }

    return { ok: true, upserted, pages };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return { ok: false, upserted, pages, error: msg };
  }
}

function parseArgs(argv) {
  let userId =
    process.env.ML_PACK_MESSAGES_SYNC_USER_ID != null
      ? Number(process.env.ML_PACK_MESSAGES_SYNC_USER_ID)
      : null;
  let all =
    process.env.ML_PACK_MESSAGES_SYNC_ALL === "1" ||
    process.env.ML_PACK_MESSAGES_SYNC_ALL === "true";
  let sinceDays = null;
  let orderLimit = null;
  const cleaned = argv.map((a) => String(a).replace(/^\uFEFF/, "").trim());
  for (const a of cleaned) {
    const lower = a.toLowerCase();
    if (lower === "--all" || lower === "-a") all = true;
    else if (a.startsWith("--user=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) userId = n;
    } else if (a.startsWith("--since-days=")) {
      const n = Number(a.slice(13));
      if (Number.isFinite(n) && n >= 0) sinceDays = n;
    } else if (a.startsWith("--order-limit=")) {
      const n = Number(a.slice(14));
      if (Number.isFinite(n) && n > 0) orderLimit = n;
    }
  }
  return { userId, all, sinceDays, orderLimit };
}

async function main() {
  const { userId, all, sinceDays, orderLimit: orderLimitArg } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[ml-pack-messages-sync] DATABASE_URL no definida.");
    process.exit(1);
  }

  const accounts = await listMlAccounts();
  if (!accounts.length) {
    console.error("[ml-pack-messages-sync] No hay cuentas en ml_accounts.");
    process.exit(1);
  }

  let targets = [];
  if (all) {
    targets = accounts.map((a) => Number(a.ml_user_id));
  } else if (userId != null && Number.isFinite(userId) && userId > 0) {
    targets = [userId];
  } else {
    targets = [Number(accounts[0].ml_user_id)];
    console.log("[ml-pack-messages-sync] Sin --user ni --all: usando primera cuenta %s", targets[0]);
  }

  const tag = (process.env.ML_PACK_MESSAGES_SYNC_TAG || "post_sale").trim() || "post_sale";
  const appId = String(
    process.env.ML_APPLICATION_ID || process.env.OAUTH_CLIENT_ID || "1837222235616049"
  ).trim();
  const pageSize = DEFAULT_PAGE_SIZE;
  const delayMs = Math.max(0, Number(process.env.ML_PACK_MESSAGES_SYNC_DELAY_MS) || 0);
  const orderLimitEnv = Number(process.env.ML_PACK_MESSAGES_SYNC_ORDER_LIMIT);
  const orderLimit = Math.min(
    50000,
    Math.max(
      1,
      orderLimitArg != null && Number.isFinite(orderLimitArg)
        ? orderLimitArg
        : Number.isFinite(orderLimitEnv) && orderLimitEnv > 0
          ? orderLimitEnv
          : 300
    )
  );

  let sinceCutoffMs = null;
  if (sinceDays != null && sinceDays > 0) {
    sinceCutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  }

  const opts = { tag, appId, pageSize, delayMs };

  console.log(
    "[ml-pack-messages-sync] tag=%s order_limit=%s delay_ms=%s since_days=%s",
    tag,
    orderLimit,
    delayMs,
    sinceDays != null ? sinceDays : "—"
  );

  for (const uid of targets) {
    const rows = await listMlOrdersByUser(uid, orderLimit, 50000, {});
    let processed = 0;
    let upsertedTotal = 0;
    let errors = 0;
    for (const row of rows) {
      const oid = row.order_id != null ? Number(row.order_id) : NaN;
      if (!Number.isFinite(oid) || oid <= 0) continue;
      if (!orderDateForFilter(row, sinceCutoffMs)) continue;
      processed++;
      const r = await syncPackMessagesForOrder(uid, oid, opts);
      if (r.ok) {
        upsertedTotal += r.upserted;
      } else {
        errors++;
        console.warn(
          "[ml-pack-messages-sync] ml_user_id=%s order_id=%s err=%s",
          uid,
          oid,
          (r.error || "—").slice(0, 300)
        );
      }
      if (delayMs > 0) await sleep(delayMs);
    }
    console.log(
      "[ml-pack-messages-sync] ml_user_id=%s órdenes=%s mensajes_upsert=%s errores_http=%s",
      uid,
      processed,
      upsertedTotal,
      errors
    );
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ml-pack-messages-sync]", e);
    process.exit(1);
  });
}

module.exports = { syncPackMessagesForOrder, packMessagesPath, persistPackMessageFromWebhookFetch };
