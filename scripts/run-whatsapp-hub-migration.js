#!/usr/bin/env node
/**
 * Ejecuta sql/20260410_whatsapp_hub.sql contra DATABASE_URL.
 * Usa el driver `pg`; no requiere `psql` en PATH.
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260410_whatsapp_hub.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:whatsapp-hub] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:whatsapp-hub] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:whatsapp-hub]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
