"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Configuración opcional para conciliación con Banesco (Venezuela).
 *
 * Flujo habitual del banco: el estado de cuenta se obtiene desde la banca
 * en línea (Banesco en línea / Empresas) exportando o descargando el movimiento
 * en CSV — no hay API REST pública tipo Stripe para “bajar el estado” desde
 * esta app. Este módulo documenta variables para esa ruta (CSV) y credenciales
 * solo si en el futuro hubiera canal adicional.
 *
 * Variables soportadas (todas opcionales):
 * - BANESCO_STATEMENT_CSV_DIR — carpeta donde depositás los CSV del estado de
 *   cuenta (descarga manual desde el portal) para un futuro import / job.
 *   En oauth-env.json en Windows usá barras / o doble \\ (ej. C:\\Users\\...\\data\\banesco).
 * - BANESCO_ENVIRONMENT       — "test" | "certification" | "production" (libre)
 * - BANESCO_RIF               — RIF de la empresa (referencia)
 * - BANESCO_API_USER / BANESCO_API_PASSWORD — solo si usás otro canal que los pida
 * - BANESCO_CERT_PATH         — certificado .p12 si el portal lo requiere (no va al repo)
 * - BANESCO_WEBHOOK_SECRET    — reservado si el banco notifica por webhook
 */

const ENV_KEYS = {
  STATEMENT_CSV_DIR: "BANESCO_STATEMENT_CSV_DIR",
  ENVIRONMENT: "BANESCO_ENVIRONMENT",
  RIF: "BANESCO_RIF",
  API_USER: "BANESCO_API_USER",
  API_PASSWORD: "BANESCO_API_PASSWORD",
  CERT_PATH: "BANESCO_CERT_PATH",
  WEBHOOK_SECRET: "BANESCO_WEBHOOK_SECRET",
};

function maskTail(s, visible = 4) {
  const t = s != null ? String(s) : "";
  if (t.length <= visible) return "****";
  return `${t.slice(0, 2)}…${t.slice(-visible)}`;
}

/** Listo para pipeline CSV o credenciales auxiliares (no implica API al banco). */
function isConfigured() {
  const dir = process.env[ENV_KEYS.STATEMENT_CSV_DIR];
  if (dir && String(dir).trim()) return true;
  const u = process.env[ENV_KEYS.API_USER];
  const p = process.env[ENV_KEYS.API_PASSWORD];
  return Boolean(u && String(u).trim() && p && String(p).trim());
}

function statementCsvDirExists() {
  const raw = process.env[ENV_KEYS.STATEMENT_CSV_DIR];
  if (!raw || !String(raw).trim()) return null;
  const abs = path.resolve(String(raw).trim());
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** true si declarás explícitamente entorno de prueba/certificación */
function isTestOrCertEnvironment() {
  const e = (process.env[ENV_KEYS.ENVIRONMENT] || "").toLowerCase();
  return e === "test" || e === "testing" || e === "cert" || e === "certification" || e === "sandbox";
}

/**
 * Resumen seguro para logs / JSON (sin secretos completos).
 */
function getPublicStatus() {
  const rif = process.env[ENV_KEYS.RIF];
  const cert = process.env[ENV_KEYS.CERT_PATH];
  const wh = process.env[ENV_KEYS.WEBHOOK_SECRET];
  const csvDir = process.env[ENV_KEYS.STATEMENT_CSV_DIR];
  const csvDirSet = Boolean(csvDir && String(csvDir).trim());
  return {
    integration_primary: "csv_estado_cuenta",
    environment: process.env[ENV_KEYS.ENVIRONMENT] || null,
    statement_csv_dir: csvDirSet ? path.resolve(String(csvDir).trim()) : null,
    statement_csv_dir_configured: csvDirSet,
    statement_csv_dir_exists: csvDirSet ? statementCsvDirExists() : null,
    has_rif: Boolean(rif && String(rif).trim()),
    has_api_user: Boolean(process.env[ENV_KEYS.API_USER] && String(process.env[ENV_KEYS.API_USER]).trim()),
    has_api_password: Boolean(process.env[ENV_KEYS.API_PASSWORD] && String(process.env[ENV_KEYS.API_PASSWORD]).trim()),
    has_cert_path: Boolean(cert && String(cert).trim()),
    has_webhook_secret: Boolean(wh && String(wh).trim()),
    api_user_preview: process.env[ENV_KEYS.API_USER] ? maskTail(process.env[ENV_KEYS.API_USER]) : null,
    /** true si hay carpeta CSV o usuario+clave auxiliares (no implica API al banco). */
    configuration_ready: isConfigured(),
    /** @deprecated usar configuration_ready (mismo valor; nombre histórico). */
    ready_for_integration_hooks: isConfigured(),
    test_mode_declared: isTestOrCertEnvironment(),
  };
}

const NEXT_STEPS_ES = [
  "Ingresá a Banesco en línea / Empresas con tu usuario de prueba o producción.",
  "Descargá o exportá el estado de cuenta en formato CSV (movimientos del período a conciliar).",
  "Guardá el archivo en la carpeta definida en BANESCO_STATEMENT_CSV_DIR (o la que uses para el import pendiente).",
  "No subas CSV con datos reales a git; tratá esos archivos como información sensible.",
  "Si el portal exige certificado digital, guardá el .p12 fuera del repo y usá BANESCO_CERT_PATH en el servidor.",
  "Un import automático desde CSV en esta app es un desarrollo aparte (parser + conciliación).",
];

module.exports = {
  ENV_KEYS,
  isConfigured,
  isTestOrCertEnvironment,
  getPublicStatus,
  statementCsvDirExists,
  NEXT_STEPS_ES,
};
