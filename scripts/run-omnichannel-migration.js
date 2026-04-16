"use strict";

const path = require("path");
const { runSqlFile } = require("./run-sql-file-pg");

async function main() {
  console.log("Ejecutando migración: omnichannel extend...");
  await runSqlFile(
    path.join(__dirname, "..", "sql", "20260422_omnichannel_extend.sql")
  );
  console.log("✓ Migración omnichannel completada.");
}

main().catch((err) => {
  console.error("Error en migración omnichannel:", err.message);
  process.exit(1);
});
