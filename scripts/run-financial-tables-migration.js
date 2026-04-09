#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260413_financial_tables.sql"))
  .then(() => { console.log("✅ financial_tables (expense_categories, debit_justifications, manual_transactions, exchange_rates) — migración OK"); process.exit(0); })
  .catch((err) => { console.error("❌ financial_tables:", err.message); process.exit(1); });
