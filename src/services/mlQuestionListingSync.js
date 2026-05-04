"use strict";

/**
 * Tras persistir una pregunta ML (webhook o refresh): GET /items/{id} y upsert en ml_listings.
 * El frontend Bandeja no debe disparar esto; el backend lo hace en el mismo ciclo que el hook.
 */
const { mercadoLibreFetchForUser } = require("../../oauth-token");
const { listingRowFromMlItemApi } = require("../../ml-listing-map");
const { upsertMlListing } = require("../../db");

/**
 * @param {{ ml_user_id?: number|string|null, item_id?: string|null }} row
 * @returns {Promise<{ ok: boolean, skipped?: string, saved?: boolean, error?: string }>}
 */
async function syncMlListingForQuestionRow(row) {
  if (!row || typeof row !== "object") return { ok: false, skipped: "no_row" };
  const uid = Number(row.ml_user_id);
  const itemIdRaw = row.item_id != null ? String(row.item_id).trim() : "";
  if (!Number.isFinite(uid) || uid <= 0) return { ok: false, skipped: "no_ml_user_id" };
  if (!itemIdRaw) return { ok: false, skipped: "no_item_id" };

  try {
    const mlRes = await mercadoLibreFetchForUser(uid, `/items/${encodeURIComponent(itemIdRaw)}`);
    if (!mlRes.ok) {
      return {
        ok: false,
        error: `ML items HTTP ${mlRes.status}: ${String(mlRes.rawText || "").slice(0, 300)}`,
      };
    }
    if (!mlRes.data || typeof mlRes.data !== "object") {
      return { ok: false, error: "items_response_not_object" };
    }
    const listingRow = listingRowFromMlItemApi(uid, mlRes.data);
    if (!listingRow) {
      return { ok: false, error: "listingRowFromMlItemApi_null" };
    }
    await upsertMlListing(listingRow);
    return { ok: true, saved: true };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

module.exports = { syncMlListingForQuestionRow };
