#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260418_provider_settings.sql"))
  .then(() => {
    console.log("✅ provider_settings / ai_usage_log — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ provider_settings:", err.message);
    process.exit(1);
  });
