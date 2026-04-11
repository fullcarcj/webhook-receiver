#!/usr/bin/env node
"use strict";
/**
 * Borra filas de ai_response_log con action_taken = 'error' (las que el dashboard
 * muestra en rojo como "error WA").
 *
 *   CONFIRM_PURGE_AI_ERROR_LOGS=1 node scripts/purge-ai-response-log-errors.js
 *   CONFIRM_PURGE_AI_ERROR_LOGS=1 node scripts/purge-ai-response-log-errors.js --dry-run
 *
 * Opcional: solo errores anteriores a una fecha (UTC o ISO local):
 *   ... --before=2026-04-11
 *
 * Requiere DATABASE_URL (load-env-local).
 */
require("../load-env-local");
const { pool } = require("../db");

function hasFlag(name) {
  return process.argv.includes(name);
}

function argVal(prefix) {
  const a = process.argv.find((x) => x.startsWith(prefix));
  if (!a) return null;
  const [, v] = a.split("=", 2);
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

async function main() {
  if (String(process.env.CONFIRM_PURGE_AI_ERROR_LOGS || "").trim() !== "1") {
    console.error(
      "Seguridad: defina CONFIRM_PURGE_AI_ERROR_LOGS=1 para borrar filas action_taken='error' en ai_response_log."
    );
    console.error("Añada --dry-run para solo contar sin borrar.");
    process.exit(1);
  }

  const dry = hasFlag("--dry-run");
  const before = argVal("--before");

  let where = `action_taken = 'error'`;
  const params = [];
  if (before) {
    params.push(before);
    where += ` AND created_at < $${params.length}::timestamptz`;
  }

  const countSql = `SELECT COUNT(*)::int AS n FROM ai_response_log WHERE ${where}`;
  const { rows: c } = await pool.query(countSql, params);
  const n = c[0]?.n ?? 0;
  console.log(dry ? "[dry-run] " : "", `Filas a borrar: ${n}`, before ? `(created_at < ${before})` : "");

  if (dry || n === 0) {
    await pool.end().catch(() => {});
    process.exit(0);
  }

  const del = await pool.query(`DELETE FROM ai_response_log WHERE ${where}`, params);
  console.log(`Eliminadas: ${del.rowCount}`);
  await pool.end().catch(() => {});
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
