'use strict';
const path = require('path');
const { runSqlFile } = require('./run-sql-file-pg');

runSqlFile(path.join(__dirname, '..', 'sql', '20260409_inventory_extensions.sql'))
  .then(() => { console.log('✅ Migración de inventario completada'); process.exit(0); })
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
