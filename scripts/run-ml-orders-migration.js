#!/usr/bin/env node
'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

const file = path.join(__dirname, '../sql/ml-orders.sql');

runSqlFile(file)
  .then(() => {
    console.log('✅ ml-orders — migración OK');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ ml-orders:', err.message);
    process.exit(1);
  });
