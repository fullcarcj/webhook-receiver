/**
 * Normaliza respuestas de la API de ítems ML (GET /items/:id o fila de búsqueda)
 * al objeto esperado por `upsertMlListing` (PostgreSQL vía db-postgres).
 * Multicuenta: siempre incluir el `ml_user_id` de la cuenta que sincroniza.
 */

/**
 * @param {number} mlUserId - user_id del vendedor (ml_accounts)
 * @param {object} item - JSON ítem ML
 * @param {object} [options]
 * @param {string} [options.searchJson] - JSON crudo de lista/búsqueda si aplica
 * @param {number} [options.http_status]
 * @param {string|null} [options.sync_error]
 * @param {string} [options.fetched_at] - ISO
 * @returns {object|null}
 */
function listingRowFromMlItemApi(mlUserId, item, options = {}) {
  if (!item || typeof item !== "object") return null;
  const id = item.id != null ? String(item.id).trim() : "";
  if (!id) return null;
  const uid = Number(mlUserId);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  let thumbnail = null;
  const pics = item.pictures;
  if (Array.isArray(pics) && pics[0] && typeof pics[0] === "object" && pics[0].secure_url != null) {
    thumbnail = String(pics[0].secure_url);
  } else if (item.thumbnail != null) {
    thumbnail = String(item.thumbnail);
  }

  const listingType =
    item.listing_type_id != null
      ? String(item.listing_type_id)
      : item.listing_type != null
        ? String(item.listing_type)
        : null;

  let rawJson;
  try {
    rawJson = JSON.stringify(item);
  } catch {
    rawJson = "{}";
  }

  const now = new Date().toISOString();
  return {
    ml_user_id: uid,
    item_id: id,
    site_id: item.site_id != null ? String(item.site_id) : null,
    seller_id: item.seller_id != null ? Number(item.seller_id) : null,
    status: item.status != null ? String(item.status) : null,
    title: item.title != null ? String(item.title) : null,
    price: item.price != null ? item.price : null,
    currency_id: item.currency_id != null ? String(item.currency_id) : null,
    available_quantity:
      item.available_quantity != null ? Number(item.available_quantity) : null,
    sold_quantity: item.sold_quantity != null ? Number(item.sold_quantity) : null,
    category_id: item.category_id != null ? String(item.category_id) : null,
    listing_type: listingType,
    permalink: item.permalink != null ? String(item.permalink) : null,
    thumbnail,
    raw_json: rawJson,
    search_json: options.searchJson != null ? String(options.searchJson) : null,
    http_status: options.http_status != null ? Number(options.http_status) : null,
    sync_error: options.sync_error != null ? String(options.sync_error) : null,
    fetched_at: options.fetched_at != null ? String(options.fetched_at) : now,
    updated_at: now,
  };
}

module.exports = {
  listingRowFromMlItemApi,
};
