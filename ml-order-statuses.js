/**
 * Estados posibles del campo `status` en el recurso **Order** de Mercado Libre
 * (GET /orders/{id}, GET /orders/search, notificaciones orders_v2).
 *
 * Lista alineada con la documentación de “Gestión de ventas / Orders” y respuestas reales de la API.
 * Pueden aparecer valores adicionales por sitio (MLA, MLV, etc.) o cambios de API; conviene
 * inspeccionar `SELECT DISTINCT status FROM ml_orders` tras sincronizar.
 *
 * Referencia general: developers.mercadolibre.com — recurso Order, atributo `status`.
 */

const ML_ORDER_STATUSES_KNOWN = Object.freeze([
  /** Orden creada / confirmada; aún sin pago acreditado (muy frecuente en búsquedas). */
  "confirmed",
  "payment_required",
  "payment_in_process",
  "partially_paid",
  "paid",
  "cancelled",
  /** Orden inválida o inconsistente según reglas ML. */
  "invalid",
]);

/** Cadena por defecto para ML_ORDERS_SYNC_STATUSES (todas las anteriores). */
function defaultStatusesCsv() {
  return ML_ORDER_STATUSES_KNOWN.join(",");
}

module.exports = {
  ML_ORDER_STATUSES_KNOWN,
  defaultStatusesCsv,
};
