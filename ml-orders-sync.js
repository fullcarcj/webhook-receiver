/**
 * Descarga órdenes por cuenta vía GET /orders/search (filtro order.status).
 * Uso: node ml-orders-sync.js [--user=ML_USER_ID] [--all] [--status=paid,cancelled] [--max-pages=N] [--today]
 * --today: solo órdenes con date_created en el día calendario actual (ML: order.date_created.from/to).
 *   Zona: ML_ORDERS_SYNC_TZ (def. America/Caracas). Desfase: ML_ORDERS_SYNC_TODAY_OFFSET_MINUTES (def. -240 = UTC-4).
 * En Windows, si `npm run sync-orders -- --all` no pasa el flag, usa: npm run sync-orders-all
 *   o: node ml-orders-sync.js --all   o env ML_ORDERS_SYNC_ALL=1
 * Env: ML_ORDERS_SYNC_STATUSES  ML_ORDERS_SYNC_MAX_PAGES  ML_ORDERS_SYNC_PAGE_DELAY_MS
 *      ML_ORDERS_SYNC_TODAY=1 equivale a --today
 * Requiere DATABASE_URL, cuenta en ml_accounts y token válido.
 */
require("./load-env-local");

const { mercadoLibreFetchForUser } = require("./oauth-token");
const { orderRowFromMlApi, feedbackDetailRowsFromOrder } = require("./ml-order-map");
const { defaultStatusesCsv } = require("./ml-order-statuses");
const { listMlAccounts, upsertMlOrder, upsertMlOrderFeedback } = require("./db");

const PAGE_LIMIT = 50;

const DEFAULT_STATUSES = (process.env.ML_ORDERS_SYNC_STATUSES || defaultStatusesCsv())
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function sleep(ms) {
  return new Promise((r) => setTimeout(r));
}

/** YYYY-MM-DD en la zona indicada (p. ej. America/Caracas). */
function calendarYmdInTimeZone(timeZone) {
  const tz = timeZone && String(timeZone).trim() ? String(timeZone).trim() : "America/Caracas";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

/**
 * ML docs: order.date_created.from / order.date_created.to (ISO con offset).
 * Usamos el día calendario en ML_ORDERS_SYNC_TZ y el offset en minutos (Venezuela -240).
 */
function orderDateCreatedRangeToday(options = {}) {
  const tz =
    options.timeZone != null && String(options.timeZone).trim() !== ""
      ? String(options.timeZone).trim()
      : process.env.ML_ORDERS_SYNC_TZ && String(process.env.ML_ORDERS_SYNC_TZ).trim() !== ""
        ? String(process.env.ML_ORDERS_SYNC_TZ).trim()
        : "America/Caracas";
  const offsetMinRaw =
    options.offsetMinutes != null
      ? Number(options.offsetMinutes)
      : process.env.ML_ORDERS_SYNC_TODAY_OFFSET_MINUTES != null &&
          String(process.env.ML_ORDERS_SYNC_TODAY_OFFSET_MINUTES).trim() !== ""
        ? Number(process.env.ML_ORDERS_SYNC_TODAY_OFFSET_MINUTES)
        : -240;
  const offsetMin = Number.isFinite(offsetMinRaw) ? offsetMinRaw : -240;
  const ymd = calendarYmdInTimeZone(tz);
  const sign = offsetMin <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const oh = Math.floor(abs / 60);
  const om = abs % 60;
  const offStr = `${sign}${String(oh).padStart(2, "0")}:${String(om).padStart(2, "0")}`;
  return {
    from: `${ymd}T00:00:00.000${offStr}`,
    to: `${ymd}T23:59:59.999${offStr}`,
    ymd,
    timeZone: tz,
  };
}

/**
 * @param {number} mlUserId - id vendedor (seller en ML = ml_user_id)
 * @param {number} offset
 * @param {number} limit
 * @param {string[]} statuses
 * @param {boolean} [withSort]
 * @param {{ from: string, to: string } | null} [dateCreatedRange] - order.date_created ML
 */
function ordersSearchPath(mlUserId, offset, limit, statuses, withSort = true, dateCreatedRange = null) {
  const p = new URLSearchParams();
  p.set("seller", String(mlUserId));
  p.set("offset", String(Math.max(0, offset)));
  p.set("limit", String(Math.min(PAGE_LIMIT, Math.max(1, limit))));
  for (const s of statuses) {
    if (s && String(s).trim()) p.append("order.status", String(s).trim());
  }
  if (dateCreatedRange && dateCreatedRange.from && dateCreatedRange.to) {
    p.set("order.date_created.from", String(dateCreatedRange.from));
    p.set("order.date_created.to", String(dateCreatedRange.to));
  }
  if (withSort) {
    p.set("sort", "date_desc");
  }
  return `/orders/search?${p.toString()}`;
}

/**
 * @param {number} mlUserId
 * @param {{ statuses?: string[], maxPages?: number, pageDelayMs?: number, dateCreatedRange?: { from: string, to: string } | null }} [options]
 */
async function syncOrdersForMlUser(mlUserId, options = {}) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    return { ok: false, upserted: 0, pages: 0, error: "ml_user_id inválido" };
  }

  const statuses =
    options.statuses != null && options.statuses.length
      ? options.statuses
      : DEFAULT_STATUSES;

  const maxPages =
    options.maxPages != null && Number.isFinite(Number(options.maxPages))
      ? Math.max(1, Number(options.maxPages))
      : Number(process.env.ML_ORDERS_SYNC_MAX_PAGES) > 0
        ? Number(process.env.ML_ORDERS_SYNC_MAX_PAGES)
        : 500;

  const pageDelayMs = Number(
    options.pageDelayMs != null
      ? options.pageDelayMs
      : process.env.ML_ORDERS_SYNC_PAGE_DELAY_MS || 350
  );

  const dateCreatedRange =
    options.dateCreatedRange != null &&
    options.dateCreatedRange.from &&
    options.dateCreatedRange.to
      ? { from: String(options.dateCreatedRange.from), to: String(options.dateCreatedRange.to) }
      : null;

  let upserted = 0;
  let pages = 0;
  let offset = 0;
  const now = () => new Date().toISOString();

  try {
    let useSort = true;
    for (;;) {
      if (pages >= maxPages) {
        return {
          ok: true,
          upserted,
          pages,
          error: `Límite de páginas (${maxPages}). Aumenta --max-pages o ML_ORDERS_SYNC_MAX_PAGES.`,
        };
      }

      const path = ordersSearchPath(mlUid, offset, PAGE_LIMIT, statuses, useSort, dateCreatedRange);
      const res = await mercadoLibreFetchForUser(mlUid, path);

      if (!res.ok && useSort && res.status === 400) {
        useSort = false;
        console.warn("[ml-orders-sync] reintentando sin sort=date_desc");
        continue;
      }

      if (!res.ok) {
        const errText = (res.rawText || `HTTP ${res.status}`).slice(0, 4000);
        return { ok: false, upserted, pages, error: errText };
      }

      const data = res.data && typeof res.data === "object" ? res.data : {};
      const results = Array.isArray(data.results) ? data.results : [];

      for (const ord of results) {
        const fetchedAt = now();
        const row = orderRowFromMlApi(mlUid, ord, {
          http_status: res.status,
          sync_error: null,
          fetched_at: fetchedAt,
        });
        if (row) {
          await upsertMlOrder(row);
          upserted++;
          if (process.env.SALES_ML_IMPORT_ENABLED === "1") {
            setImmediate(() => {
              try {
                const salesService = require("./src/services/salesService");
                salesService
                  .syncMercadolibreSalesAfterMlOrderChange({ mlUserId: mlUid, orderId: row.order_id })
                  .catch((e) => console.error("[sales ml sync]", e && e.message ? e.message : e));
              } catch (e) {
                console.error("[sales ml sync]", e && e.message ? e.message : e);
              }
            });
          }
          const fbRows = feedbackDetailRowsFromOrder(mlUid, ord.id, ord.feedback, {
            fetched_at: fetchedAt,
            source: "order_search",
          });
          for (const fr of fbRows) {
            await upsertMlOrderFeedback(fr);
          }
        }
      }

      pages++;

      if (results.length === 0) {
        break;
      }

      if (results.length < PAGE_LIMIT) {
        break;
      }

      offset += results.length;
      if (pageDelayMs > 0) await sleep(pageDelayMs);
    }

    return { ok: true, upserted, pages };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return { ok: false, upserted, pages, error: msg };
  }
}

function parseStatusesArg(str) {
  if (str == null || String(str).trim() === "") return null;
  return String(str)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  let userId = process.env.ML_ORDERS_SYNC_USER_ID != null ? Number(process.env.ML_ORDERS_SYNC_USER_ID) : null;
  let all =
    process.env.ML_ORDERS_SYNC_ALL === "1" ||
    process.env.ML_ORDERS_SYNC_ALL === "true" ||
    process.env.ML_ORDERS_SYNC_ALL === "yes";
  let maxPages =
    process.env.ML_ORDERS_SYNC_MAX_PAGES != null ? Number(process.env.ML_ORDERS_SYNC_MAX_PAGES) : null;
  let statuses = null;
  let today =
    process.env.ML_ORDERS_SYNC_TODAY === "1" ||
    process.env.ML_ORDERS_SYNC_TODAY === "true" ||
    process.env.ML_ORDERS_SYNC_TODAY === "yes";
  const cleaned = argv.map((a) => String(a).replace(/^\uFEFF/, "").trim());
  for (const a of cleaned) {
    const lower = a.toLowerCase();
    if (lower === "--all" || lower === "-a" || lower === "/all") {
      all = true;
    } else if (lower === "--today" || lower === "-t") {
      today = true;
    } else if (a.startsWith("--user=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) userId = n;
    } else if (a.startsWith("--max-pages=")) {
      const n = Number(a.slice(12));
      if (Number.isFinite(n) && n > 0) maxPages = n;
    } else if (a.startsWith("--status=")) {
      statuses = parseStatusesArg(a.slice(9));
    }
  }
  return { userId, all, maxPages, statuses, today };
}

async function main() {
  const { userId, all, maxPages, statuses, today } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[ml-orders-sync] DATABASE_URL no definida.");
    process.exit(1);
  }

  const accounts = await listMlAccounts();
  if (!accounts.length) {
    console.error("[ml-orders-sync] No hay cuentas en ml_accounts.");
    process.exit(1);
  }

  let targets = [];
  if (all) {
    targets = accounts.map((a) => Number(a.ml_user_id));
  } else if (userId != null && Number.isFinite(userId) && userId > 0) {
    targets = [userId];
  } else {
    targets = [Number(accounts[0].ml_user_id)];
    console.log("[ml-orders-sync] Sin --user ni --all: usando primera cuenta %s", targets[0]);
  }

  const opts = {};
  if (maxPages != null && Number.isFinite(maxPages)) opts.maxPages = maxPages;
  if (statuses != null && statuses.length) opts.statuses = statuses;
  if (today) {
    const r = orderDateCreatedRangeToday();
    opts.dateCreatedRange = { from: r.from, to: r.to };
    console.log(
      "[ml-orders-sync] Solo día %s (%s): order.date_created.from / .to",
      r.ymd,
      r.timeZone
    );
  }

  console.log(
    "[ml-orders-sync] Estados: %s",
    (opts.statuses || DEFAULT_STATUSES).join(", ")
  );

  const results = [];
  for (const uid of targets) {
    console.log("[ml-orders-sync] ml_user_id=%s …", uid);
    const r = await syncOrdersForMlUser(uid, opts);
    results.push({ ml_user_id: uid, ...r });
    console.log(
      "[ml-orders-sync] ml_user_id=%s ok=%s upserted=%s pages=%s err=%s",
      uid,
      r.ok,
      r.upserted,
      r.pages,
      r.error || "—"
    );
  }

  const failed = results.filter((x) => !x.ok);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ml-orders-sync]", e);
    process.exit(1);
  });
}

module.exports = {
  syncOrdersForMlUser,
  ordersSearchPath,
  orderDateCreatedRangeToday,
  calendarYmdInTimeZone,
};
