#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260412_sales_orders_payment_overdue.sql"))
  .then(() => { console.log("✅ sales_orders payment_overdue — migración OK"); process.exit(0); })
  .catch((err) => { console.error("❌ sales_orders payment_overdue:", err.message); process.exit(1); });
