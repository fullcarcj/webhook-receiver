#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260417_cash_approval_flow.sql"))
  .then(() => {
    console.log("✅ cash_approval_flow (manual_transactions, finance_settings, sales_orders status, cash_approval_log)");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ cash_approval_flow:", err.message);
    process.exit(1);
  });
