#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260410_customers_wa_enrichment.sql"))
  .then(() => {
    console.log("✅ customers wa_enrichment — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ wa-enrichment:", err.message);
    process.exit(1);
  });
