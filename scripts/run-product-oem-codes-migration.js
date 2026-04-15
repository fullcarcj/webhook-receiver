"use strict";
const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

runSqlFile(path.join(__dirname, "..", "sql", "20260415_product_oem_codes.sql"))
  .then(() => {
    console.log("Migración product_oem_codes completada");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
  });
