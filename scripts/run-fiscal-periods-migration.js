#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/fiscal-periods.sql"))
  .then(() => {
    console.log("✅ fiscal-periods — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ fiscal-periods:", err.message);
    process.exit(1);
  });
