"use strict";

const cron = require("node-cron");
const pino = require("pino");
const { pool } = require("../../db");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_reset_worker" });

let job = null;

function startAiResetWorker() {
  if (job) return;
  job = cron.schedule(
    "0 0 * * *",
    async () => {
      try {
        const r = await pool.query(
          `UPDATE provider_settings SET
             current_daily_usage = 0,
             current_daily_requests = 0,
             error_count_today = 0,
             consecutive_failures = 0,
             circuit_breaker_until = NULL
           WHERE category LIKE 'ai%'`
        );
        log.info({ rowCount: r.rowCount }, "contadores diarios AI reiniciados (America/Caracas medianoche)");
      } catch (e) {
        log.warn({ err: e.message }, "ai reset worker: UPDATE falló (¿migración pendiente?)");
      }
    },
    { timezone: "America/Caracas" }
  );
  log.info("aiResetWorker programado: 00:00 America/Caracas");
}

function stopAiResetWorker() {
  if (job) {
    job.stop();
    job = null;
  }
}

module.exports = { startAiResetWorker, stopAiResetWorker };
