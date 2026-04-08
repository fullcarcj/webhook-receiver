#!/usr/bin/env node
/**
 * Ejecuta sql/crm-solomotor3k.sql contra DATABASE_URL.
 * Usa el driver `pg` (scripts/run-sql-file-pg.js); no requiere `psql` en PATH.
 * Prerrequisito: tabla `customers` (p. ej. sql/customer-wallet.sql).
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "crm-solomotor3k.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:crm] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:crm] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:crm]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
