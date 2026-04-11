'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '../sql/wms-audit-v2.sql'))
  .then(() => { console.log('✅ wms-audit-v2: migración OK'); process.exit(0); })
  .catch(err => { console.error('❌ wms-audit-v2:', err.message); process.exit(1); });
