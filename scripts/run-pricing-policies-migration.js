#!/usr/bin/env node
/**
 * sql/pricing-policies.sql — financial_settings, pricing_policies, payment_method_settings.
 */
"use strict";

require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "pricing-policies.sql");

(async () => {
  try {
    console.log("[db:pricing-policies] ejecutando", sqlPath);
    await runSqlFile(sqlPath);
    console.log("[db:pricing-policies] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:pricing-policies] ERROR: no existe", sqlPath);
      process.exit(1);
    }
    if (e && e.code === "NO_DATABASE_URL") {
      console.error("[db:pricing-policies] ERROR:", e.message);
      process.exit(1);
    }
    console.error("[db:pricing-policies] ERROR:", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    if (e && e.hint) console.error("hint:", e.hint);
    process.exit(1);
  }
})();
