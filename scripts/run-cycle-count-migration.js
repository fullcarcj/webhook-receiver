#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/cycle-count.sql"))
  .then(() => {
    console.log("✅ cycle-count — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ cycle-count:", err.message);
    process.exit(1);
  });
