#!/usr/bin/env node
/**
 * sql/20260410_customers_phone2.sql — phone_2 en customers.
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260410_customers_phone2.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:customers-phone2] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:customers-phone2] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:customers-phone2]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
