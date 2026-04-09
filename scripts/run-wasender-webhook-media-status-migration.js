#!/usr/bin/env node
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260409_wasender_webhook_media_status.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:wasender-webhook-media-status] OK");
  } catch (e) {
    console.error("[db:wasender-webhook-media-status]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
