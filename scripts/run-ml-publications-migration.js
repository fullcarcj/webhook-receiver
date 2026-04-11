'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

async function main() {
  await runSqlFile(path.join(__dirname, '../sql/20260410_ml_publications.sql'));
  console.log('  ✅ ml_publications, ml_paused_publications, ml_pending_actions, ml_api_log');
  await runSqlFile(path.join(__dirname, '../sql/20260411_ml_publications_user_id.sql'));
  console.log('  ✅ ml_publications.ml_user_id (OAuth multi-cuenta)');
  console.log('✅ ml-publications — migración OK');
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('❌ ml-publications:', err.message); process.exit(1); });
