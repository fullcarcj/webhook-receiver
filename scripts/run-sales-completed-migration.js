#!/usr/bin/env node
/**
 * sql/20260410_sales_completed_status.sql — driver `pg` (sin psql en PATH).
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260410_sales_completed_status.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:sales-completed] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:sales-completed] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:sales-completed]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
