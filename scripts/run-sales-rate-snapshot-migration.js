'use strict';
const path = require('path');
require('./run-sql-file-pg')({ file: path.join(__dirname, '../sql/20260411_sales_orders_rate_snapshot.sql'), label: 'sales-rate-snapshot' });
