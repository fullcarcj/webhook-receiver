'use strict';
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

async function run() {
  console.log('[business-config] Ejecutando migraciones...');
  await runSqlFile(path.join(__dirname, '../sql/20260422_companies_branches.sql'));
  console.log('[business-config] companies, branches, currencies — OK');
  await runSqlFile(path.join(__dirname, '../sql/20260422_daily_rates_multicurrency.sql'));
  console.log('[business-config] daily_exchange_rates (from/to_currency) — OK');
  console.log('[business-config] Migración completada.');
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('[business-config] Error:', err.message); process.exit(1); });
