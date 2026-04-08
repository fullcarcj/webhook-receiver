#!/usr/bin/env node
/**
 * Ejecuta sql/20260412_crm_wa_welcome.sql contra DATABASE_URL (driver pg).
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260412_crm_wa_welcome.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:crm-wa-welcome] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:crm-wa-welcome] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:crm-wa-welcome]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
