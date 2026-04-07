'use strict';

// Venezuela no tiene horario de verano — siempre UTC-4
const VET_OFFSET_MS      = 4 * 60 * 60 * 1000;
const DOWNTIME_START_HOUR = 23;  // 11:00 PM VET
const DOWNTIME_END_HOUR   = 6;   // 06:00 AM VET

function nowVET() {
  return new Date(Date.now() - VET_OFFSET_MS);
}

function isInDowntime() {
  const hour = nowVET().getUTCHours();
  return hour >= DOWNTIME_START_HOUR || hour < DOWNTIME_END_HOUR;
}

function msUntilSystemUp() {
  if (!isInDowntime()) return 0;
  const vet     = nowVET();
  const hour    = vet.getUTCHours();
  const minutes = vet.getUTCMinutes();
  let minutesUntil6am;
  if (hour >= DOWNTIME_START_HOUR) {
    minutesUntil6am = (24 - hour + DOWNTIME_END_HOUR) * 60 - minutes;
  } else {
    minutesUntil6am = (DOWNTIME_END_HOUR - hour) * 60 - minutes;
  }
  return minutesUntil6am * 60 * 1000;
}

// Usar solo en rutas de escritura críticas.
// Retorna true si rechazó el request (el handler debe hacer return).
// Retorna false si el sistema está activo (continuar normalmente).
function rejectDuringDowntime(req, res) {
  if (!isInDowntime()) return false;
  const msLeft   = msUntilSystemUp();
  const minsLeft = Math.ceil(msLeft / 60000);
  res.writeHead(503, {
    'Content-Type':  'application/json',
    'Retry-After':   Math.ceil(msLeft / 1000),
  });
  res.end(JSON.stringify({
    error:                'SYSTEM_DOWNTIME',
    message:              `Sistema en mantenimiento. Disponible en ~${minsLeft} minutos (06:00 AM VET).`,
    retry_after_seconds:  Math.ceil(msLeft / 1000),
  }));
  return true;
}

module.exports = { isInDowntime, msUntilSystemUp, rejectDuringDowntime };
