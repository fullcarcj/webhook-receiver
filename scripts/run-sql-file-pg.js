#!/usr/bin/env node
/**
 * Ejecuta un .sql contra DATABASE_URL usando el paquete `pg` (sin depender de `psql` en PATH).
 * Uso: node scripts/run-sql-file-pg.js sql/archivo.sql
 * Desde la raíz del repo; DATABASE_URL en entorno o oauth-env.json (load-env-local).
 */
"use strict";

require("../load-env-local");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

function poolSslOption() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!raw || process.env.PGSSLMODE === "disable") return false;
  if (/sslmode=disable/i.test(raw)) return false;
  const local =
    /@localhost[:\/]/i.test(raw) ||
    /@127\.0\.0\.1[:\/]/i.test(raw) ||
    /:\/\/localhost[:\/]/i.test(raw) ||
    /:\/\/127\.0\.0\.1[:\/]/i.test(raw);
  if (local) return false;
  return { rejectUnauthorized: false };
}

/**
 * @param {string} sqlPathAbs
 */
async function runSqlFile(sqlPathAbs) {
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url) {
    const e = new Error("DATABASE_URL no definida");
    e.code = "NO_DATABASE_URL";
    throw e;
  }
  if (!fs.existsSync(sqlPathAbs)) {
    const e = new Error(`no existe ${sqlPathAbs}`);
    e.code = "ENOENT_SQL";
    throw e;
  }
  const sql = fs.readFileSync(sqlPathAbs, "utf8");
  const maxAttempts = Math.max(
    1,
    Number(process.env.PG_SQL_FILE_RETRIES || 3) || 3
  );
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = new Client({
      connectionString: url,
      ssl: poolSslOption(),
      connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
    });
    client.on("notice", (msg) => {
      const t = msg && (msg.message || msg.toString());
      if (t) process.stderr.write(`[pg-notice] ${t}\n`);
    });
    client.on("error", (err) => {
      const m = err && err.message ? err.message : String(err);
      process.stderr.write(`[pg-client] ${m}\n`);
    });
    try {
      await client.connect();
      await client.query(sql);
      await client.end();
      return;
    } catch (e) {
      lastErr = e;
      try {
        await client.end();
      } catch (_) {
        /* ignore */
      }
      const msg = e && e.message ? e.message : "";
      const transient =
        /Connection terminated unexpectedly/i.test(msg) ||
        /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i.test(msg) ||
        e.code === "57P01" ||
        e.code === "08006";
      if (transient && attempt < maxAttempts) {
        const wait = 1500 * attempt;
        process.stderr.write(
          `[run-sql-file-pg] conexión inestable (intento ${attempt}/${maxAttempts}): ${msg}; reintento en ${wait}ms\n`
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Uso: node scripts/run-sql-file-pg.js <ruta.sql>");
    console.error("Ejemplo: node scripts/run-sql-file-pg.js sql/crm-solomotor3k.sql");
    process.exit(1);
  }
  const sqlPath = path.isAbsolute(arg) ? arg : path.join(__dirname, "..", arg);
  await runSqlFile(sqlPath);
  console.log("[run-sql-file-pg] OK", sqlPath);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[run-sql-file-pg] falló:", err.message);
    if (err && err.detail) console.error("detail:", err.detail);
    if (err && err.hint) console.error("hint:", err.hint);
    process.exit(1);
  });
}

module.exports = { runSqlFile, poolSslOption };
