#!/usr/bin/env node
/**
 * Migración roles 8 niveles.
 * PostgreSQL no permite usar un valor de enum recién añadido en la misma transacción
 * que el ALTER TYPE ... ADD VALUE. Un único client.query(multiline) = una transacción → error.
 * Aquí: un ADD VALUE por query (autocommit), luego constraint + INSERTs.
 *
 * Uso: npm run db:roles-8niveles
 */
"use strict";

require("../load-env-local");
const { Client } = require("pg");
const { poolSslOption } = require("./run-sql-file-pg");

const NEW_ROLES = [
  "SUPERVISOR",
  "VENDEDOR_MOSTRADOR",
  "VENDEDOR_EXTERNO",
  "OPERADOR_DIGITAL",
  "ALMACENISTA",
  "CONTADOR",
];

const REST_SQL = `
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS chk_rp_module;

ALTER TABLE role_permissions
  ADD CONSTRAINT chk_rp_module CHECK (module IN (
    'wms','ventas','crm','catalog','settings','fiscal',
    'compras','integraciones','reportes'
  ));

INSERT INTO role_permissions (role, module, action)
SELECT 'SUPERUSER'::user_role, m, a
FROM unnest(ARRAY[
  'wms','ventas','crm','catalog','settings','fiscal','compras','integraciones','reportes'
]) AS m,
     unnest(ARRAY['read','write','admin']) AS a
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action)
SELECT 'ADMIN'::user_role, m, a
FROM unnest(ARRAY['wms','ventas','crm','settings','fiscal','compras','integraciones','reportes']) AS m,
     unnest(ARRAY['read','write','admin']) AS a
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action)
SELECT 'ADMIN'::user_role, m, a
FROM unnest(ARRAY['catalog']) AS m,
     unnest(ARRAY['read','write']) AS a
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
WHERE role = 'ADMIN'::user_role AND module = 'catalog' AND action = 'admin';

INSERT INTO role_permissions (role, module, action) VALUES
  ('SUPERVISOR','ventas','read'),
  ('SUPERVISOR','ventas','write'),
  ('SUPERVISOR','crm','read'),
  ('SUPERVISOR','wms','read'),
  ('SUPERVISOR','fiscal','read'),
  ('SUPERVISOR','reportes','read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action) VALUES
  ('VENDEDOR_MOSTRADOR','ventas','read'),
  ('VENDEDOR_MOSTRADOR','ventas','write'),
  ('VENDEDOR_EXTERNO','ventas','read'),
  ('VENDEDOR_EXTERNO','ventas','write'),
  ('VENDEDOR_MOSTRADOR','crm','read'),
  ('VENDEDOR_EXTERNO','crm','read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action) VALUES
  ('OPERADOR_DIGITAL','crm','read'),
  ('OPERADOR_DIGITAL','crm','write'),
  ('OPERADOR_DIGITAL','integraciones','read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action) VALUES
  ('ALMACENISTA','wms','read'),
  ('ALMACENISTA','wms','write'),
  ('ALMACENISTA','compras','read')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action) VALUES
  ('CONTADOR','fiscal','read'),
  ('CONTADOR','settings','read')
ON CONFLICT DO NOTHING;
`;

async function enumLabelExists(client, label) {
  const { rows } = await client.query(
    `SELECT 1
     FROM pg_enum e
     JOIN pg_type t ON e.enumtypid = t.oid
     WHERE t.typname = 'user_role' AND e.enumlabel = $1`,
    [label]
  );
  return rows.length > 0;
}

async function main() {
  const url = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!url) {
    console.error("[db:roles-8niveles] DATABASE_URL no definida");
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: poolSslOption(),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
  });
  await client.connect();

  try {
    for (const label of NEW_ROLES) {
      const exists = await enumLabelExists(client, label);
      if (exists) {
        console.log("[db:roles-8niveles] enum user_role ya tiene:", label);
        continue;
      }
      // Una sentencia por round-trip → commit implícito antes de usar el valor en INSERT
      await client.query(`ALTER TYPE user_role ADD VALUE '${label}'`);
      console.log("[db:roles-8niveles] ADD VALUE", label);
    }

    await client.query(REST_SQL);
    console.log("[db:roles-8niveles] OK constraint + role_permissions");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[db:roles-8niveles] falló:", err.message);
  if (err.detail) console.error("detail:", err.detail);
  if (err.hint) console.error("hint:", err.hint);
  process.exit(1);
});
