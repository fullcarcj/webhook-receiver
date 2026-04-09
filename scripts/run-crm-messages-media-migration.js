#!/usr/bin/env node
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260409_crm_messages_media.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:crm-messages-media] OK — columnas file_size, duration_sec, transcription + índices");
  } catch (e) {
    console.error("[db:crm-messages-media]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
