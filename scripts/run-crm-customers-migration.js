#!/usr/bin/env node
'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

const file = path.join(__dirname, '../sql/crm-customers.sql');

runSqlFile(file)
  .then(() => {
    console.log('✅ crm-customers — migración OK');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ crm-customers:', err.message);
    if (err.detail) console.error('detail:', err.detail);
    if (err.hint)   console.error('hint:',   err.hint);
    process.exit(1);
  });
