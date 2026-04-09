#!/usr/bin/env node
/**
 * Ejecuta sql/20260415_crm_chat_states.sql contra DATABASE_URL (driver pg).
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260415_crm_chat_states.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:crm-chat-states] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:crm-chat-states] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:crm-chat-states]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
