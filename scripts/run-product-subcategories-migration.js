#!/usr/bin/env node
/**
 * sql/20260422_product_subcategories.sql — subcategorías + FK en products.subcategory_id
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260422_product_subcategories.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:product-subcategories] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:product-subcategories] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:product-subcategories]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
