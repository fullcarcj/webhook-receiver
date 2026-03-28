/**
 * Tope de mensajería automática ML por comprador y por día civil (zona horaria configurable):
 * post-venta (cada paso cuenta), recordatorio de calificación y retiro/despacho.
 *
 * Env:
 *   ML_AUTO_MESSAGE_MAX=3              — máximo de mensajes automáticos al mismo comprador el mismo día (default 3)
 *   ML_AUTO_MESSAGE_TIMEZONE=America/Caracas — día civil para el conteo (también se lee ML_RETIRO_TIMEZONE si existe)
 *   ML_AUTO_MESSAGE_DISABLE_CAP=1      — solo pruebas: sin tope
 */
const { countMlAutoMessagesForBuyerToday } = require("./db");

function getMlAutoMessageMax() {
  const n = Number(process.env.ML_AUTO_MESSAGE_MAX ?? 3);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.min(50, Math.floor(n));
}

function getMlAutoMessageTimezone() {
  const a = process.env.ML_AUTO_MESSAGE_TIMEZONE;
  const b = process.env.ML_RETIRO_TIMEZONE;
  const t = a != null && String(a).trim() !== "" ? String(a).trim() : b;
  return t != null && String(t).trim() !== "" ? String(t).trim() : "America/Caracas";
}

function isAutoMessageCapDisabled() {
  return process.env.ML_AUTO_MESSAGE_DISABLE_CAP === "1";
}

/**
 * Cuántos envíos automáticos aún se permiten hoy para este comprador (0 = ninguno).
 */
async function getAutoMessageBudgetForBuyerToday(mlUserId, buyerId) {
  if (isAutoMessageCapDisabled()) return 999;
  const used = await countMlAutoMessagesForBuyerToday(
    mlUserId,
    buyerId,
    getMlAutoMessageTimezone()
  );
  const max = getMlAutoMessageMax();
  return Math.max(0, max - used);
}

module.exports = {
  getMlAutoMessageMax,
  getMlAutoMessageTimezone,
  isAutoMessageCapDisabled,
  getAutoMessageBudgetForBuyerToday,
};
