"use strict";

/**
 * Worker de Conciliación Automática — intervalo 30 segundos.
 * Mutex isRunning evita ciclos simultáneos si la DB tarda más de 30s.
 *
 * Uso en server.js:
 *   const { startWorker, stopWorker } = require('./src/workers/reconciliationWorker');
 *   server.listen(PORT, () => { startWorker(); });
 *   process.on('SIGTERM', () => { stopWorker(); server.close(() => process.exit(0)); });
 */

const { runReconciliation } = require("../services/reconciliationService");
const pino = require("pino");
const log  = pino({ level: process.env.LOG_LEVEL || "info", name: "recon_worker" });

let isRunning    = false;
let cycleCount   = 0;
let workerHandle = null;

async function reconciliationCycle() {
  if (isRunning) {
    log.warn({ cycle: cycleCount + 1 }, "recon_worker: ciclo anterior en ejecución — saltando");
    return;
  }
  isRunning = true;
  cycleCount++;
  const t = Date.now();

  try {
    const stats   = await runReconciliation();
    const matched = stats.bank_l1 + stats.bank_l2 + stats.attempt_l1 + stats.attempt_l2;

    if (matched > 0 || stats.manual > 0 || stats.errors > 0) {
      log.info({
        cycle:    cycleCount,
        matched,
        manual:   stats.manual,
        no_match: stats.no_match,
        errors:   stats.errors,
        ms:       Date.now() - t,
      }, matched > 0 ? "recon_worker: matches encontrados" : "recon_worker: ciclo con eventos");
    }
  } catch (err) {
    log.error({ err: err.message, cycle: cycleCount }, "recon_worker: error crítico en ciclo");
  } finally {
    isRunning = false;
  }
}

function startWorker() {
  if (process.env.NODE_ENV === "test") return;
  if (workerHandle) return; // idempotente — no arrancar dos veces
  log.info("recon_worker: iniciando — intervalo 30 segundos");
  reconciliationCycle(); // ejecutar inmediatamente al arrancar
  workerHandle = setInterval(reconciliationCycle, 30_000);
}

function stopWorker() {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
    log.info("recon_worker: detenido");
  }
}

module.exports = { startWorker, stopWorker };
