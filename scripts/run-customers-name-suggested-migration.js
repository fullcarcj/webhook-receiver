#!/usr/bin/env node
/**
 * sql/20260414_customers_name_suggested.sql — name_suggested en customers.
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260414_customers_name_suggested.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:customers-name-suggested] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:customers-name-suggested] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:customers-name-suggested]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
