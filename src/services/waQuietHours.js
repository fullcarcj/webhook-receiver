'use strict';

/**
 * Ventana horaria configurable para considerar “fuera de hora” los envíos Wasender
 * (p. ej. 00:00–05:00 en Caracas = mensajes repetidos en horario incómodo).
 *
 * Parámetros (solo lectura; no bloquean el envío salvo WA_QUIET_HOURS_BLOCK_SEND=1):
 *   WA_QUIET_HOURS_TZ     — IANA, default America/Caracas (alineado con waThrottle)
 *   WA_QUIET_HOURS_START  — HH:MM, default 00:00 (inicio inclusive)
 *   WA_QUIET_HOURS_END    — HH:MM, default 05:00 (fin exclusive: a las 05:00 ya no aplica)
 *   WA_QUIET_HOURS_BLOCK_SEND — si 1/true, wasender-client no llama a la API en esa ventana
 */

const DEFAULT_TZ = 'America/Caracas';
const DEFAULT_START = '00:00';
const DEFAULT_END = '05:00';

function parseHm(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesNowInTz(date, timeZone) {
  const d = date instanceof Date ? date : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/**
 * @returns {{ tz: string, start: string, end: string, startMin: number, endMin: number, blockSend: boolean }}
 */
function getWaQuietHoursConfig() {
  const tz = String(process.env.WA_QUIET_HOURS_TZ || DEFAULT_TZ).trim() || DEFAULT_TZ;
  const start = String(process.env.WA_QUIET_HOURS_START || DEFAULT_START).trim() || DEFAULT_START;
  const end = String(process.env.WA_QUIET_HOURS_END || DEFAULT_END).trim() || DEFAULT_END;
  let startMin = parseHm(start);
  let endMin = parseHm(end);
  if (startMin == null) startMin = parseHm(DEFAULT_START);
  if (endMin == null) endMin = parseHm(DEFAULT_END);
  const blockRaw = process.env.WA_QUIET_HOURS_BLOCK_SEND;
  const blockSend = blockRaw === '1' || String(blockRaw).toLowerCase() === 'true';
  return { tz, start, end, startMin, endMin, blockSend };
}

/**
 * @param {Date} [date]
 * @returns {boolean} true si la hora local en WA_QUIET_HOURS_TZ está en [start, end)
 */
function isWaQuietHoursNow(date) {
  const { tz, startMin, endMin } = getWaQuietHoursConfig();
  const now = minutesNowInTz(date, tz);
  if (now == null || startMin == null || endMin == null) return false;
  if (startMin < endMin) {
    return now >= startMin && now < endMin;
  }
  // Ventana que cruza medianoche, p. ej. 22:00–05:00
  return now >= startMin || now < endMin;
}

module.exports = {
  getWaQuietHoursConfig,
  isWaQuietHoursNow,
};
