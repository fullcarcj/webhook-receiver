#!/usr/bin/env node
"use strict";
require("../load-env-local");
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const base = path.join(__dirname, "../sql");
runSqlFile(path.join(base, "20260411_ai_responder.sql"))
  .then(() => runSqlFile(path.join(base, "20260420_ai_responder_human_review.sql")))
  .then(() => runSqlFile(path.join(base, "20260420b_ai_responder_legacy_archived.sql")))
  .then(() => {
    console.log("✅ ai_responder — migración OK");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ ai_responder:", err.message);
    process.exit(1);
  });
