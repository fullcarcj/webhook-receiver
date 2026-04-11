#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/shipping-providers.sql"))
  .then(() => {
    console.log("✅ shipping-providers — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ shipping-providers:", err.message);
    process.exit(1);
  });
