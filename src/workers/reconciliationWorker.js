"use strict";

/**
 * Worker de Conciliación — modo event-driven puro.
 *
 * El polling de 30s fue eliminado. La conciliación se invoca únicamente:
 *   1) Desde banescoService.runCycle() cuando inserta nuevos bank_statements
 *      → reconcileStatements(newStatementIds)
 *   2) Desde src/whatsapp/processors/media.js tras insertar un payment_attempt
 *      → reconcileAttempt(paymentAttemptId)
 *
 * startWorker/stopWorker se mantienen como no-ops para preservar la interfaz
 * que usa server.js (sin cambiar ese archivo).
 *
 * Para ejecutar una conciliación manual completa (soporte/backfill):
 *   const { runReconciliation } = require('../services/reconciliationService');
 *   await runReconciliation();
 */

const pino = require("pino");
const log  = pino({ level: process.env.LOG_LEVEL || "info", name: "recon_worker" });

function startWorker() {
  if (process.env.NODE_ENV === "test") return;
  log.info(
    "recon_worker: modo event-driven activo — polling desactivado. " +
    "Conciliación se dispara por eventos: bank_statement insert / payment_attempt insert."
  );
}

function stopWorker() {
  log.info("recon_worker: detenido (event-driven no requiere cleanup)");
}

module.exports = { startWorker, stopWorker };
