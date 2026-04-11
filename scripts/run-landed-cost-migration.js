#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/landed-cost.sql"))
  .then(() => {
    console.log("✅ landed-cost — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ landed-cost:", err.message);
    process.exit(1);
  });
