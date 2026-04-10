#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "../sql/20260416_wa_sent_messages_log.sql"))
  .then(() => {
    console.log("✅ wa_sent_messages_log — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ wa_sent_messages_log:", err.message);
    process.exit(1);
  });
