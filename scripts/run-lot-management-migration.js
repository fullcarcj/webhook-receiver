#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/lot-management.sql"))
  .then(() => {
    console.log("✅ lot-management — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ lot-management:", err.message);
    process.exit(1);
  });
