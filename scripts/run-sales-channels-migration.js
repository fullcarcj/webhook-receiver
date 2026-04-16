'use strict';
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '../sql/20260422_sales_channels.sql'))
  .then(() => { console.log('[sales-channels] Migración completada'); process.exit(0); })
  .catch(err => { console.error('[sales-channels] Error:', err.message); process.exit(1); });
