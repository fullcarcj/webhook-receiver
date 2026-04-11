#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/exchange-rates.sql"))
  .then(() => {
    console.log("✅ exchange-rates — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ exchange-rates:", err.message);
    process.exit(1);
  });
