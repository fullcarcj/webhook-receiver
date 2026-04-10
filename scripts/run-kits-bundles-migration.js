#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260417_kits_bundles_productos.sql"))
  .then(() => {
    console.log("✅ kits/bundles (productos) — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ kits/bundles:", err.message);
    process.exit(1);
  });
