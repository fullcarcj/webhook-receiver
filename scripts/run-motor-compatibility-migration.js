#!/usr/bin/env node
'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

const file = path.join(__dirname, '../sql/motor-compatibility.sql');

runSqlFile(file)
  .then(() => {
    console.log('✅ motor-compatibility — migración OK');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ motor-compatibility:', err.message);
    process.exit(1);
  });
