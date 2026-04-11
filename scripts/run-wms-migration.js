'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '../sql/wms-bins.sql'))
  .then(() => { console.log('✅ wms: migración OK'); process.exit(0); })
  .catch(err => { console.error('❌ wms:', err.message); process.exit(1); });
