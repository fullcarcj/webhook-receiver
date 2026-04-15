#!/usr/bin/env node
/**
 * sql/20260424_manufacturers_products_fk.sql — manufacturers + manufacturer_id + FK brand_id opcional.
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260424_manufacturers_products_fk.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:manufacturers] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:manufacturers] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:manufacturers]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
