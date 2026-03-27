/**
 * Preferencia de entrega en ml_buyers.pref_entrega (columna lógica Pref_Entrega).
 */
const BUYER_PREF_ENTREGA_VALUES = Object.freeze(["Pickup", "Envio Courier", "Delivery"]);
/** Valor por defecto en BD y cuando el webhook no envía preferencia. */
const BUYER_PREF_ENTREGA_DEFAULT = "Pickup";

/**
 * @param {unknown} v
 * @returns {string|null} valor permitido o null (omitir / desconocido)
 */
function normalizeBuyerPrefEntrega(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (BUYER_PREF_ENTREGA_VALUES.includes(s)) return s;
  const key = s
    .toLowerCase()
    .replace(/\u00ad/g, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  /** Sinónimos (p. ej. FileMaker en español) → valor en BD */
  const aliases = {
    retiro: "Pickup",
    pickup: "Pickup",
    "envio courier": "Envio Courier",
    envio: "Envio Courier",
    courier: "Envio Courier",
    delivery: "Delivery",
  };
  return aliases[key] || null;
}

const NOMBRE_APELLIDO_MAX = 500;

/**
 * ml_buyers.nombre_apellido (columna lógica "Nombre y Apellido").
 * @param {unknown} v
 * @returns {string|null}
 */
function normalizeNombreApellido(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (s === "") return null;
  return s.length > NOMBRE_APELLIDO_MAX ? s.slice(0, NOMBRE_APELLIDO_MAX) : s;
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

/**
 * @param {{ pref_entrega?: unknown }} row
 * @returns {string|null} Pickup si no viene clave; null si se borra explícitamente; valor normalizado si viene.
 */
function resolvePrefEntregaForUpsert(row) {
  if (row.pref_entrega === undefined) return BUYER_PREF_ENTREGA_DEFAULT;
  return normalizeBuyerPrefEntrega(row.pref_entrega);
}

module.exports = {
  BUYER_PREF_ENTREGA_VALUES,
  BUYER_PREF_ENTREGA_DEFAULT,
  normalizeBuyerPrefEntrega,
  normalizeCambioDatos,
  normalizeNombreApellido,
  resolvePrefEntregaForUpsert,
};
