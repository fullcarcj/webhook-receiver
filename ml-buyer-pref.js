/**
 * Preferencia de entrega en ml_buyers.pref_entrega (columna lógica Pref_Entrega).
 */
const BUYER_PREF_ENTREGA_VALUES = Object.freeze(["Pickup", "Envio Courier", "Delivery"]);

/**
 * @param {unknown} v
 * @returns {string|null} valor permitido o null (omitir / desconocido)
 */
function normalizeBuyerPrefEntrega(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return BUYER_PREF_ENTREGA_VALUES.includes(s) ? s : null;
}

const CAMBIO_DATOS_MAX = 4000;

/**
 * Texto libre para ml_buyers.cambio_datos (columna lógica Cambio_datos).
 * @param {unknown} v
 * @returns {string|null}
 */
function normalizeCambioDatos(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (s === "") return null;
  return s.length > CAMBIO_DATOS_MAX ? s.slice(0, CAMBIO_DATOS_MAX) : s;
}

module.exports = {
  BUYER_PREF_ENTREGA_VALUES,
  normalizeBuyerPrefEntrega,
  normalizeCambioDatos,
};
