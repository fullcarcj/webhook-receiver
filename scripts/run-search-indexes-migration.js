#!/usr/bin/env node
'use strict';
require('../load-env-local');
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

const file = path.join(__dirname, '../sql/search-indexes.sql');

runSqlFile(file)
  .then(() => {
    console.log('✅ search-indexes — migración OK (pg_trgm + 5 índices GIN)');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ search-indexes:', err.message);
    process.exit(1);
  });
