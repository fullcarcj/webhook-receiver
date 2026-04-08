#!/usr/bin/env node
/**
 * sql/20260409_sales_global.sql — driver `pg` (sin psql en PATH).
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260409_sales_global.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:sales-global] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:sales-global] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:sales-global]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
