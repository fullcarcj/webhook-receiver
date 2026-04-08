#!/usr/bin/env node
/**
 * Ejecuta en orden: db:sales → db:sales-ml → db:sales-global.
 * Uso: npm run db:sales-all  (evita encadenar con && en PowerShell 5)
 */
"use strict";
require("../load-env-local");
const { spawnSync } = require("child_process");
const path = require("path");

const steps = [
  "run-sales-migration.js",
  "run-sales-ml-migration.js",
  "run-sales-global-migration.js",
  "run-sales-completed-migration.js",
  "run-customers-phone2-migration.js",
  "run-orders-lifecycle-migration.js",
];

for (const name of steps) {
  const scriptPath = path.join(__dirname, name);
  const r = spawnSync(process.execPath, [scriptPath], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    process.exit(r.status === null ? 1 : r.status);
  }
}
process.exit(0);
