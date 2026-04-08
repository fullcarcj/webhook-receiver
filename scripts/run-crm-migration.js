#!/usr/bin/env node
/**
 * Ejecuta sql/crm-solomotor3k.sql contra DATABASE_URL (requiere psql en PATH).
 * Alternativa: psql "$DATABASE_URL" -f sql/crm-solomotor3k.sql
 */
"use strict";

require("../load-env-local");
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
if (!url) {
  console.error("[db:crm] DATABASE_URL no definida");
  process.exit(1);
}

const sqlPath = path.join(__dirname, "..", "sql", "crm-solomotor3k.sql");
if (!fs.existsSync(sqlPath)) {
  console.error("[db:crm] no existe", sqlPath);
  process.exit(1);
}

const r = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", sqlPath], {
  stdio: "inherit",
  shell: false,
  env: process.env,
});

if (r.error) {
  console.error("[db:crm] ejecutá manualmente: psql \"$DATABASE_URL\" -f sql/crm-solomotor3k.sql");
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status === 0 ? 0 : 1);
