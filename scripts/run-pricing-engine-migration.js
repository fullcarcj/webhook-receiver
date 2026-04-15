#!/usr/bin/env node
/**
 * sql/pricing-engine.sql — motor de precios (financial_settings, pricing_policies, product_prices).
 */
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "pricing-engine.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:pricing-engine] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:pricing-engine] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:pricing-engine]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
