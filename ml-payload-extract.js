/**
 * Extrae SKU y título útiles desde respuestas JSON de la API de Mercado Libre.
 * - orders_v2: primera línea de order_items (item del catálogo / publicación).
 * - items: recurso /items/{id}.
 */

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function extractSkuTitleFromMlResponse(topic, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { sku: null, title: null };
  }
  const t = topic != null ? String(topic) : "";

  if (t === "items" || t === "item") {
    const sku = firstNonEmpty(data.seller_sku, data.seller_custom_field, data.id);
    const title = data.title != null ? String(data.title) : null;
    return {
      sku: sku != null ? String(sku) : null,
      title,
    };
  }

  if (t === "orders_v2" || t.startsWith("orders")) {
    const orderItems = data.order_items;
    if (!Array.isArray(orderItems) || orderItems.length === 0) {
      return { sku: null, title: null };
    }
    for (const line of orderItems) {
      if (!line || typeof line !== "object") continue;
      const item = line.item && typeof line.item === "object" ? line.item : {};
      const sku = firstNonEmpty(
        line.seller_sku,
        item.seller_sku,
        line.seller_custom_field,
        item.seller_custom_field,
        item.id,
        line.item_id
      );
      const title = firstNonEmpty(item.title, line.title);
      if (sku != null || title != null) {
        return {
          sku: sku != null ? String(sku) : null,
          title: title != null ? String(title) : null,
        };
      }
    }
    return { sku: null, title: null };
  }

  return { sku: null, title: null };
}

module.exports = { extractSkuTitleFromMlResponse };
