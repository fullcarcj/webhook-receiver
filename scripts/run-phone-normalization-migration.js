#!/usr/bin/env node
/**
 * sql/20260412_fix_phone_normalization.sql
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260412_fix_phone_normalization.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:phone-normalization] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:phone-normalization] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:phone-normalization]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
