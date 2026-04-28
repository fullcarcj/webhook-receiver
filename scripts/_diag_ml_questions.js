"use strict";
require("../load-env-local");
const { pool } = require("../db");
async function main() {
  try {
    const r = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ml_questions_pending' ORDER BY ordinal_position"
    );
    console.log("Columnas de ml_questions_pending:", r.rows.map(x => x.column_name).join(", "));
  } catch (e) {
    console.log("ml_questions_pending no existe:", e.message);
  }
  try {
    await pool.query("SELECT COUNT(*)::int FROM ml_questions_pending WHERE status = 'UNANSWERED'");
    console.log("ml_questions_pending.status OK");
  } catch (e) {
    console.log("ml_questions_pending.status FAIL:", e.code, "→", e.message.split("\n")[0]);
  }
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
