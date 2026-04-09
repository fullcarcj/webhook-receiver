#!/usr/bin/env node
/**
 * sql/20260412_sales_orders_order_total_amount.sql — driver `pg`.
 */
"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

const sqlPath = path.join(__dirname, "..", "sql", "20260412_sales_orders_order_total_amount.sql");

(async () => {
  try {
    await runSqlFile(sqlPath);
    console.log("[db:sales-order-total-rename] OK");
  } catch (e) {
    if (e && e.code === "ENOENT_SQL") {
      console.error("[db:sales-order-total-rename] no existe", sqlPath);
      process.exit(1);
    }
    console.error("[db:sales-order-total-rename]", e.message);
    if (e && e.detail) console.error("detail:", e.detail);
    process.exit(1);
  }
})();
