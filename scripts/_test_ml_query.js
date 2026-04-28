"use strict";
require("../load-env-local");
const { pool } = require("../db");
pool.query("SELECT COUNT(*)::int AS ml_questions_pending FROM ml_questions_pending WHERE ml_status = 'UNANSWERED'")
  .then(r => { console.log("OK ->", r.rows[0]); return pool.end(); })
  .catch(e => { console.error("FAIL:", e.message); process.exit(1); });
