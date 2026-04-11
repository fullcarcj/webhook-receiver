#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/lot-management-products-fk-patch.sql"))
  .then(() => {
    console.log("✅ lot-management-products-fk-patch — OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ lot-management-products-fk-patch:", err.message);
    process.exit(1);
  });
