'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '../sql/customer-wallet.sql'))
  .then(() => { console.log('✅ customer-wallet — migración OK'); process.exit(0); })
  .catch(err => { console.error('❌ customer-wallet:', err.message); process.exit(1); });
