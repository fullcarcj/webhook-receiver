#!/usr/bin/env node
/**
 * sql/20260421_category_products.sql — tabla category_products.
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260421_category_products.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:category-products] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:category-products] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:category-products]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
