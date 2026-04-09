#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260412_payment_attempts.sql"))
  .then(() => { console.log("✅ payment_attempts — migración OK"); process.exit(0); })
  .catch((err) => { console.error("❌ payment_attempts:", err.message); process.exit(1); });
