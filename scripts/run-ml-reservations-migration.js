'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '../sql/ml-reservations.sql'))
  .then(() => { console.log('✅ ml-reservations — migración OK'); process.exit(0); })
  .catch(err => { console.error('❌ ml-reservations:', err.message); process.exit(1); });
