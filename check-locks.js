/**
 * Mata un backend PostgreSQL por PID (por defecto 1286632).
 * Uso: node check-locks.js
 * Env: DATABASE_URL (o .env en la raíz vía dotenv; si falta, intenta load-env-local como el resto del repo).
 * Opcional: PG_TERMINATE_PID=1287503 node check-locks.js
 */
require("dotenv").config();

if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
  try {
    require("./load-env-local");
  } catch (_) {
    /* sin load-env-local */
  }
}

const { Pool } = require("pg");

const PID = parseInt(process.env.PG_TERMINATE_PID || "1286632", 10);

if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
  console.error(
    "ERROR: DATABASE_URL no está definida.\n" +
      "  - Creá un archivo .env en la raíz con DATABASE_URL=postgresql://...\n" +
      "  - O definí oauth-env.json / variables como en el resto del proyecto."
  );
  process.exit(1);
}

console.log("check-locks.js — conectando…");
console.log("PID a terminar:", PID);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    const r = await pool.query("SELECT pg_terminate_backend($1::integer) AS terminated", [PID]);
    console.log("Resultado pg_terminate_backend:", r.rows[0]);
    if (r.rows[0] && r.rows[0].terminated === true) {
      console.log("OK: backend terminado.");
    } else {
      console.log(
        "Aviso: devolvió false (PID inexistente, ya cerrado, o sin permisos para ese proceso)."
      );
    }
  } catch (e) {
    console.error("Error SQL:", e.message || e);
    if (e.code) console.error("code:", e.code);
    process.exitCode = 1;
  } finally {
    await pool.end();
    console.log("Pool cerrado.");
  }
}

main();
