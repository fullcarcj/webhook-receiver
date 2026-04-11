#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/tax-retentions.sql"))
  .then(() => {
    console.log("✅ tax-retentions — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ tax-retentions:", err.message);
    process.exit(1);
  });
