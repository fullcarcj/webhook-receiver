#!/usr/bin/env node
"use strict";
require("../load-env-local");
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
if (!url) {
  console.error("[db:sales-ml] DATABASE_URL no definida");
  process.exit(1);
}
const sqlPath = path.join(__dirname, "..", "sql", "20260408_sales_orders_ml.sql");
if (!fs.existsSync(sqlPath)) process.exit(1);
const r = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", sqlPath], { stdio: "inherit", env: process.env });
process.exit(r.status === 0 ? 0 : 1);
