"use strict";

const { runCycle } = require("../services/banescoService");

/** Segundos entre cada descarga (después del primer ciclo). Default 60. Mínimo 15 para no saturar el portal. */
function monitorIntervalMs() {
  const raw = process.env.BANESCO_MONITOR_INTERVAL_SEC;
  const sec = raw != null && String(raw).trim() !== "" ? Number(raw) : 60;
  if (!Number.isFinite(sec) || sec < 15) {
    return 60 * 1000;
  }
  return Math.floor(sec * 1000);
}

const INTERVAL_MS = monitorIntervalMs();
const BANK_ACCOUNT_ID = parseInt(process.env.BANK_ACCOUNT_ID || "1", 10);
const ENABLED = process.env.BANESCO_MONITOR_ENABLED === "1";

function startBanescoMonitor() {
  if (!ENABLED) {
    console.log("[banesco] Monitor deshabilitado (BANESCO_MONITOR_ENABLED != 1)");
    return;
  }

  if (!process.env.BANESCO_USER || !process.env.BANESCO_PASS) {
    console.error("[banesco] BANESCO_USER o BANESCO_PASS no configurados — monitor no inicia");
    return;
  }

  console.log(
    "[banesco] Monitor iniciado | " +
      `Intervalo: ${INTERVAL_MS / 1000}s (BANESCO_MONITOR_INTERVAL_SEC) | ` +
      `Cuenta ID: ${BANK_ACCOUNT_ID}`
  );

  setTimeout(async () => {
    await runCycle(BANK_ACCOUNT_ID);
    setInterval(() => runCycle(BANK_ACCOUNT_ID), INTERVAL_MS);
  }, 15000);
}

module.exports = { startBanescoMonitor };
