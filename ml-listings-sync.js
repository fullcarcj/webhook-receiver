/**
 * Descarga masiva de publicaciones por cuenta (GET /users/{id}/items/search + GET /items/{id}).
 * Uso: node ml-listings-sync.js [--user=ML_USER_ID | --user ML_USER_ID] [--all] [--max-batches=N]
 * Alternativa: ML_SYNC_USER_ID=... (env). En PowerShell si npm no reenvía args: ejecutar node directo o
 *   $env:ML_SYNC_USER_ID="663838076"; npm run sync-listings
 * Requiere DATABASE_URL, cuenta en ml_accounts y tokens válidos.
 */
require("./load-env-local");

const { mercadoLibreFetchForUser } = require("./oauth-token");
const { listingRowFromMlItemApi } = require("./ml-listing-map");
const {
  listMlAccounts,
  upsertMlListing,
  upsertMlListingSyncState,
} = require("./db");

const DEFAULT_LIMIT = 100;
const DELAY_MS_BETWEEN_ITEMS = Number(process.env.ML_LISTINGS_SYNC_ITEM_DELAY_MS || 80);
const DELAY_MS_BETWEEN_BATCHES = Number(process.env.ML_LISTINGS_SYNC_BATCH_DELAY_MS || 400);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function itemIdFromResult(r) {
  if (r == null) return null;
  if (typeof r === "string" && r.trim()) return r.trim();
  if (typeof r === "object" && r.id != null) return String(r.id).trim();
  return null;
}

/** GET /items/{id}?api_version=4 */
function itemDetailPath(itemId) {
  const id = String(itemId).trim();
  if (!id) return null;
  const enc = encodeURI(id);
  return `/items/${enc}?api_version=4`;
}

/**
 * Primera página o siguiente con scroll_id.
 * @see https://developers.mercadolibre.com.ar/en_us/items-and-searches
 */
function userItemsScanPath(mlUserId, scrollId, limit) {
  const uid = encodeURIComponent(String(mlUserId));
  const lim = Math.min(100, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const p = new URLSearchParams();
  p.set("search_type", "scan");
  p.set("limit", String(lim));
  if (scrollId != null && String(scrollId).trim() !== "") {
    p.set("scroll_id", String(scrollId));
  }
  return `/users/${uid}/items/search?${p.toString()}`;
}

/**
 * Fallback: offset/limit si scan no aplica.
 */
function userItemsOffsetPath(mlUserId, offset, limit) {
  const uid = encodeURIComponent(String(mlUserId));
  const lim = Math.min(100, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const off = Math.max(0, Number(offset) || 0);
  const p = new URLSearchParams();
  p.set("limit", String(lim));
  p.set("offset", String(off));
  return `/users/${uid}/items/search?${p.toString()}`;
}

/**
 * @param {number} mlUserId
 * @param {{ maxBatches?: number, useOffsetFallback?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, upserted: number, batches: number, error?: string }>}
 */
async function syncListingsForMlUser(mlUserId, options = {}) {
  const mlUid = Number(mlUserId);
  if (!Number.isFinite(mlUid) || mlUid <= 0) {
    return { ok: false, upserted: 0, batches: 0, error: "ml_user_id inválido" };
  }
  const maxBatches =
    options.maxBatches != null && Number.isFinite(Number(options.maxBatches))
      ? Math.max(1, Number(options.maxBatches))
      : 5000;
  let upserted = 0;
  let batches = 0;
  const now = () => new Date().toISOString();

  try {
    await upsertMlListingSyncState({
      ml_user_id: mlUid,
      last_sync_status: "running",
      last_error: null,
      last_sync_at: now(),
      updated_at: now(),
    });

    let scrollId = null;
    let usedOffsetFallback = false;
    let offset = 0;

    for (;;) {
      if (batches >= maxBatches) {
        await upsertMlListingSyncState({
          ml_user_id: mlUid,
          last_scroll_id: scrollId,
          last_offset: offset,
          last_batch_total: 0,
          last_sync_at: now(),
          last_sync_status: "partial",
          last_error: `Límite de lotes alcanzado (${maxBatches}). Usa --max-batches=N o ML_SYNC_MAX_BATCHES.`,
          updated_at: now(),
        });
        return { ok: true, upserted, batches, error: "max_batches" };
      }

      const searchPath = usedOffsetFallback
        ? userItemsOffsetPath(mlUid, offset, DEFAULT_LIMIT)
        : userItemsScanPath(mlUid, scrollId, DEFAULT_LIMIT);

      const searchRes = await mercadoLibreFetchForUser(mlUid, searchPath);
      if (!searchRes.ok) {
        const errText = (searchRes.rawText || `HTTP ${searchRes.status}`).slice(0, 4000);
        if (!usedOffsetFallback && searchRes.status === 400) {
          usedOffsetFallback = true;
          scrollId = null;
          offset = 0;
          batches = 0;
          console.warn("[ml-listings-sync] scan no disponible, usando offset/limit");
          continue;
        }
        await upsertMlListingSyncState({
          ml_user_id: mlUid,
          last_sync_status: "error",
          last_error: errText,
          last_sync_at: now(),
          updated_at: now(),
        });
        return { ok: false, upserted, batches, error: errText };
      }

      const data = searchRes.data && typeof searchRes.data === "object" ? searchRes.data : {};
      const results = Array.isArray(data.results) ? data.results : [];
      const nextScroll =
        data.scroll_id != null && String(data.scroll_id).trim() !== ""
          ? String(data.scroll_id)
          : null;

      for (const raw of results) {
        const iid = itemIdFromResult(raw);
        if (!iid) continue;
        const path = itemDetailPath(iid);
        if (!path) continue;
        const itemRes = await mercadoLibreFetchForUser(mlUid, path);
        if (itemRes.ok && itemRes.data && typeof itemRes.data === "object") {
          const row = listingRowFromMlItemApi(mlUid, itemRes.data, {
            http_status: itemRes.status,
            sync_error: null,
            fetched_at: now(),
          });
          if (row) {
            await upsertMlListing(row);
            upserted++;
          }
        } else {
          const errMsg = (itemRes.rawText || `HTTP ${itemRes.status}`).slice(0, 2000);
          const stub = {
            id: iid,
            status: "unknown",
            title: `(error al obtener ítem)`,
          };
          const row = listingRowFromMlItemApi(mlUid, stub, {
            http_status: itemRes.status,
            sync_error: errMsg,
            fetched_at: now(),
          });
          if (row) await upsertMlListing(row);
        }
        if (DELAY_MS_BETWEEN_ITEMS > 0) await sleep(DELAY_MS_BETWEEN_ITEMS);
      }

      batches++;
      await upsertMlListingSyncState({
        ml_user_id: mlUid,
        last_scroll_id: nextScroll || scrollId,
        last_offset: usedOffsetFallback ? offset : null,
        last_batch_total: results.length,
        last_sync_at: now(),
        last_sync_status: "partial",
        last_error: null,
        updated_at: now(),
      });

      if (usedOffsetFallback) {
        if (results.length === 0) break;
        offset += results.length;
        if (results.length < DEFAULT_LIMIT) break;
      } else {
        if (!nextScroll || results.length === 0) break;
        scrollId = nextScroll;
      }

      if (DELAY_MS_BETWEEN_BATCHES > 0) await sleep(DELAY_MS_BETWEEN_BATCHES);
    }

    await upsertMlListingSyncState({
      ml_user_id: mlUid,
      last_scroll_id: scrollId,
      last_offset: usedOffsetFallback ? offset : null,
      last_batch_total: 0,
      last_sync_at: now(),
      last_sync_status: "ok",
      last_error: null,
      updated_at: now(),
    });

    return { ok: true, upserted, batches };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    await upsertMlListingSyncState({
      ml_user_id: mlUid,
      last_sync_status: "error",
      last_error: msg.slice(0, 4000),
      last_sync_at: now(),
      updated_at: now(),
    });
    return { ok: false, upserted, batches, error: msg };
  }
}

function parseArgs(argv) {
  let userId = process.env.ML_SYNC_USER_ID != null ? Number(process.env.ML_SYNC_USER_ID) : null;
  let all = false;
  let maxBatches = process.env.ML_SYNC_MAX_BATCHES != null ? Number(process.env.ML_SYNC_MAX_BATCHES) : null;
  const cleaned = argv.map((a) => String(a).replace(/^\uFEFF/, "").trim());
  for (let i = 0; i < cleaned.length; i++) {
    const a = cleaned[i];
    if (a === "--all") all = true;
    else if (a.startsWith("--user=")) {
      const n = Number(a.slice(7));
      if (Number.isFinite(n) && n > 0) userId = n;
    } else if (a === "--user" && cleaned[i + 1] != null) {
      const n = Number(String(cleaned[i + 1]).trim());
      if (Number.isFinite(n) && n > 0) {
        userId = n;
        i++;
      }
    } else if (a.startsWith("--max-batches=")) {
      const n = Number(a.slice(14));
      if (Number.isFinite(n) && n > 0) maxBatches = n;
    } else if (a === "--max-batches" && cleaned[i + 1] != null) {
      const n = Number(String(cleaned[i + 1]).trim());
      if (Number.isFinite(n) && n > 0) {
        maxBatches = n;
        i++;
      }
    }
  }
  return { userId, all, maxBatches };
}

async function main() {
  const { userId, all, maxBatches } = parseArgs(process.argv.slice(2));
  const opts =
    maxBatches != null && Number.isFinite(maxBatches) ? { maxBatches } : {};

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[ml-listings-sync] DATABASE_URL no definida.");
    process.exit(1);
  }

  let accounts = await listMlAccounts();
  if (!accounts.length) {
    console.error("[ml-listings-sync] No hay cuentas en ml_accounts.");
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
      "[ml-listings-sync] Sin --user ni --all: usando primera cuenta %s",
      targets[0]
    );
  }

  const results = [];
  for (const uid of targets) {
    console.log("[ml-listings-sync] Sincronizando ml_user_id=%s …", uid);
    const r = await syncListingsForMlUser(uid, opts);
    results.push({ ml_user_id: uid, ...r });
    console.log(
      "[ml-listings-sync] ml_user_id=%s ok=%s upserted=%s batches=%s err=%s",
      uid,
      r.ok,
      r.upserted,
      r.batches,
      r.error || "—"
    );
  }

  const failed = results.filter((x) => !x.ok);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ml-listings-sync]", e);
    process.exit(1);
  });
}

module.exports = {
  syncListingsForMlUser,
};
