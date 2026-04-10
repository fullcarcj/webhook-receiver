'use strict';
require('../load-env-local');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

pool.query(`
  CREATE TABLE IF NOT EXISTS wa_throttle (
    phone_e164  TEXT NOT NULL,
    sent_date   DATE NOT NULL,
    daily_count INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (phone_e164, sent_date)
  );
  CREATE INDEX IF NOT EXISTS idx_wa_throttle_date ON wa_throttle(sent_date);
  CREATE INDEX IF NOT EXISTS idx_wa_throttle_phone ON wa_throttle(phone_e164, sent_date DESC);
`)
.then(() => { console.log('OK: tabla wa_throttle creada'); pool.end(); process.exit(0); })
.catch(e => { console.error(e.message); process.exit(1); });
