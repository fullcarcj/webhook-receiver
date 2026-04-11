'use strict';

// Venezuela no tiene horario de verano — siempre UTC-4 (abolido en 2007).
const VET_OFFSET_MS = 4 * 60 * 60 * 1000;

// Ventana de downtime: 23:30 → 05:00 VET (cruza medianoche).
const DOWNTIME_START_HOUR   = 23;
const DOWNTIME_START_MINUTE = 30;
const DOWNTIME_END_HOUR     =  5;
const DOWNTIME_END_MINUTE   =  0;
const DOWNTIME_START_MIN    = DOWNTIME_START_HOUR * 60 + DOWNTIME_START_MINUTE; // 1410
const DOWNTIME_END_MIN      = DOWNTIME_END_HOUR   * 60 + DOWNTIME_END_MINUTE;   //  300

/**
 * Hora actual en VET (UTC-4) como objeto Date.
 * Usar .getUTCHours() / .getUTCMinutes() sobre el resultado.
 */
function getVetNow() {
  return new Date(Date.now() - VET_OFFSET_MS);
}

// Alias interno
const nowVET = getVetNow;

/**
 * ¿Estamos dentro de la ventana de downtime? (23:30 → 05:00 VET)
 * La ventana cruza medianoche, por lo que la lógica es OR no AND:
 *   totalMin >= 1410  →  downtime (parte nocturna)
 *   totalMin <   300  →  downtime (parte de madrugada)
 */
function isInDowntime() {
  const vet    = getVetNow();
  const total  = vet.getUTCHours() * 60 + vet.getUTCMinutes();
  return total >= DOWNTIME_START_MIN || total < DOWNTIME_END_MIN;
}

/**
 * Milisegundos hasta que el sistema vuelva (05:00 VET).
 * Retorna 0 si no estamos en downtime.
 */
function msUntilSystemUp() {
  if (!isInDowntime()) return 0;
  const vet   = getVetNow();
  const total = vet.getUTCHours() * 60 + vet.getUTCMinutes();
  let minsLeft;
  if (total >= DOWNTIME_START_MIN) {
    // Parte nocturna (23:30 → 00:00)
    minsLeft = (24 * 60 - total) + DOWNTIME_END_MIN;
  } else {
    // Parte de madrugada (00:00 → 05:00)
    minsLeft = DOWNTIME_END_MIN - total;
  }
  return Math.max(0, minsLeft) * 60 * 1000;
}

/**
 * Minutos hasta que el sistema vuelva (05:00 VET).
 * Retorna 0 si no estamos en downtime.
 */
function minutesUntilRestore() {
  return Math.ceil(msUntilSystemUp() / 60000);
}

/**
 * Objeto de estado completo del downtime.
 */
function getDowntimeInfo() {
  const inDowntime = isInDowntime();
  const mins       = inDowntime ? minutesUntilRestore() : null;
  return {
    inDowntime,
    currentTimeVet:      getVetNow().toISOString(),
    downtimeWindow:      '23:30 - 05:00 VET',
    minutesUntilRestore: mins,
    message: inDowntime
      ? `Sistema en mantenimiento. Vuelve a las 05:00 VET (en ${mins} minutos).`
      : 'Sistema operativo.',
  };
}

/**
 * Middleware helper para handlers de escritura.
 *
 * Si estamos en downtime → responde 503 y retorna TRUE  (el handler debe hacer return).
 * Si no → retorna FALSE (continuar normalmente).
 *
 * Uso: if (rejectDuringDowntime(req, res)) return;
 *
 * @param {*} _req  Request (no se usa; aceptado para compatibilidad con código existente)
 * @param {*} res   Response
 */
function rejectDuringDowntime(_req, res) {
  if (!isInDowntime()) return false;
  const info    = getDowntimeInfo();
  const secsLeft = Math.ceil(msUntilSystemUp() / 1000);
  res.writeHead(503, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After':  String(secsLeft),
  });
  res.end(JSON.stringify({
    error:               'SERVICE_UNAVAILABLE',
    message:             info.message,
    inDowntime:          true,
    downtimeWindow:      info.downtimeWindow,
    currentTimeVet:      info.currentTimeVet,
    minutesUntilRestore: info.minutesUntilRestore,
    retryAfterSeconds:   secsLeft,
  }));
  return true;
}

module.exports = {
  isInDowntime,
  msUntilSystemUp,
  minutesUntilRestore,
  rejectDuringDowntime,
  getDowntimeInfo,
  getVetNow,
  nowVET,
};
