#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const file = path.join(__dirname, "../sql/wms-products-canonical.sql");

runSqlFile(file)
  .then(() => {
    console.log("✅ wms-products-canonical — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ wms-products-canonical:", err.message);
    process.exit(1);
  });
