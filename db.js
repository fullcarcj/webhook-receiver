/**
 * Capa de datos: solo PostgreSQL. Define `DATABASE_URL` en el entorno o en `oauth-env.json`.
 * Render/producción y desarrollo local deben apuntar al mismo motor (no se usa SQLite en runtime).
 */
require("./load-env-local");

const databaseUrl = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
if (!databaseUrl) {
  throw new Error(
    "[db] DATABASE_URL es obligatoria (PostgreSQL). Añádela en oauth-env.json o en variables de entorno."
  );
}

module.exports = require("./db-postgres");
