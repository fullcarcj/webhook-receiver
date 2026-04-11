'use strict';
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '../sql/users.sql'))
  .then(() => { console.log('[users] Migración completada'); process.exit(0); })
  .catch(err => { console.error('[users] Error:', err.message); process.exit(1); });
