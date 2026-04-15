#!/usr/bin/env node
/**
 * sql/20260416_sku_prefix_columns.sql — sku_prefix en category_products, product_subcategories, crm_vehicle_brands
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260416_sku_prefix_columns.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:sku-prefixes] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:sku-prefixes] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:sku-prefixes]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
