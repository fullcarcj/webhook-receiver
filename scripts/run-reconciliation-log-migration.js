#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260412_reconciliation_log.sql"))
  .then(() => { console.log("✅ reconciliation_log — migración OK"); process.exit(0); })
  .catch((err) => { console.error("❌ reconciliation_log:", err.message); process.exit(1); });
