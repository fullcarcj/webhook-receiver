#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260411_orders_lifecycle.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:orders-lifecycle] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:orders-lifecycle] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:orders-lifecycle]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
