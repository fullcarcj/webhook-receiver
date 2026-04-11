#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/igtf.sql"))
  .then(() => {
    console.log("✅ igtf — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ igtf:", err.message);
    process.exit(1);
  });
