#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260411_ai_responder.sql"))
  .then(() => {
    console.log("✅ ai_responder — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ ai_responder:", err.message);
    process.exit(1);
  });
