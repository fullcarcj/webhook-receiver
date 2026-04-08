#!/usr/bin/env node
/**
 * sql/20260408_sales_orders_ml.sql — driver `pg` (sin psql en PATH).
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260408_sales_orders_ml.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:sales-ml] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:sales-ml] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:sales-ml]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
