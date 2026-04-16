#!/usr/bin/env node
/**
 * Crea usuarios de prueba para los 8 roles ERP.
 * - SUPERUSER: INSERT directo en PostgreSQL (ADMIN no puede crear SUPERUSER vía API).
 * - Resto: POST /api/users con X-Admin-Secret (servidor debe estar en marcha).
 *
 * Requiere DATABASE_URL y ADMIN_SECRET (`.env` vía dotenv y/o `oauth-env.json` vía load-env-local).
 * Opcional: PORT (default 3000), RENDER_URL o CREATE_TEST_USERS_BASE_URL para la API.
 */
"use strict";

const path = require("path");
const fs = require("fs");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});
// Misma carga que otros scripts: completa claves faltantes desde oauth-env.json
require("../load-env-local");

const bcrypt = require("bcryptjs");
const { Client } = require("pg");

const BCRYPT_ROUNDS = 12;
const PASSWORD = "Solomotor2026!";

const SUPERUSER_ROW = {
  username: "javier_superuser",
  email: "javier@solomotor3k.com",
  full_name: "Javier Solomotor",
  role: "SUPERUSER",
};

const API_USERS = [
  {
    username: "admin_erp",
    email: "admin_erp@solomotor3k.test",
    full_name: "Admin ERP",
    role: "ADMIN",
  },
  {
    username: "supervisor_ventas",
    email: "supervisor_ventas@solomotor3k.test",
    full_name: "Supervisor Ventas",
    role: "SUPERVISOR",
  },
  {
    username: "vendedor_mostrador",
    email: "vendedor_mostrador@solomotor3k.test",
    full_name: "Vendedor Mostrador",
    role: "VENDEDOR_MOSTRADOR",
  },
  {
    username: "vendedor_externo",
    email: "vendedor_externo@solomotor3k.test",
    full_name: "Vendedor Externo",
    role: "VENDEDOR_EXTERNO",
  },
  {
    username: "operador_digital",
    email: "operador_digital@solomotor3k.test",
    full_name: "Operador Digital",
    role: "OPERADOR_DIGITAL",
  },
  {
    username: "almacenista_erp",
    email: "almacenista_erp@solomotor3k.test",
    full_name: "Almacenista ERP",
    role: "ALMACENISTA",
  },
  {
    username: "contador_erp",
    email: "contador_erp@solomotor3k.test",
    full_name: "Contador ERP",
    role: "CONTADOR",
  },
];

function poolSslOption() {
  const raw = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!raw || process.env.PGSSLMODE === "disable") return false;
  if (/sslmode=disable/i.test(raw)) return false;
  const local =
    /@localhost[:\/]/i.test(raw) ||
    /@127\.0\.0\.1[:\/]/i.test(raw) ||
    /:\/\/localhost[:\/]/i.test(raw) ||
    /:\/\/127\.0\.0\.1[:\/]/i.test(raw);
  if (local) return false;
  return { rejectUnauthorized: false };
}

function apiBase() {
  const explicit = process.env.CREATE_TEST_USERS_BASE_URL;
  if (explicit) return String(explicit).replace(/\/+$/, "");
  const render = process.env.RENDER_URL;
  if (render) return String(render).replace(/\/+$/, "");
  const port = process.env.PORT || 3000;
  return `http://127.0.0.1:${port}`;
}

async function insertSuperuser(client) {
  const hash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
  const { rowCount } = await client.query(
    `INSERT INTO users (company_id, username, email, full_name, password_hash, role, status)
     VALUES (1, $1, $2, $3, $4, $5::user_role, 'ACTIVE'::user_status)
     ON CONFLICT (company_id, username) DO NOTHING`,
    [
      SUPERUSER_ROW.username.toLowerCase(),
      SUPERUSER_ROW.email.toLowerCase(),
      SUPERUSER_ROW.full_name,
      hash,
      SUPERUSER_ROW.role,
    ]
  );
  if (rowCount === 1) {
    console.log(`[db] SUPERUSER creado: ${SUPERUSER_ROW.username}`);
  } else {
    console.log(`[db] SUPERUSER ya existía (omitido): ${SUPERUSER_ROW.username}`);
  }
}

async function postUser(base, adminSecret, u) {
  const res = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": adminSecret,
    },
    body: JSON.stringify({
      username: u.username,
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      password: PASSWORD,
    }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  return { res, data };
}

function printCredentialsTable() {
  const rows = [
    { username: SUPERUSER_ROW.username, role: SUPERUSER_ROW.role },
    ...API_USERS.map((x) => ({ username: x.username, role: x.role })),
  ];
  const wUser = Math.max(...rows.map((r) => r.username.length), "username".length);
  const wRole = Math.max(...rows.map((r) => r.role.length), "role".length);
  const sep = `${"-".repeat(wUser + 2)} ${"-".repeat(PASSWORD.length + 2)} ${"-".repeat(wRole + 2)}`;
  console.log("\nCredenciales (misma contraseña para todos):\n");
  console.log(`${"username".padEnd(wUser)}  ${"password".padEnd(PASSWORD.length)}  ${"role".padEnd(wRole)}`);
  console.log(sep);
  for (const r of rows) {
    console.log(
      `${r.username.padEnd(wUser)}  ${PASSWORD.padEnd(PASSWORD.length)}  ${r.role.padEnd(wRole)}`
    );
  }
  console.log("");
}

async function main() {
  const dbUrl = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  const adminSecret = process.env.ADMIN_SECRET && String(process.env.ADMIN_SECRET).trim();

  if (!dbUrl) {
    console.error(
      "[create-test-users] DATABASE_URL no definida. Ponla en .env o en oauth-env.json (ver load-env-local.js)."
    );
    process.exit(1);
  }
  if (!adminSecret) {
    console.error(
      "[create-test-users] ADMIN_SECRET no definida. Ponla en .env o en oauth-env.json."
    );
    process.exit(1);
  }

  const envPath = path.join(__dirname, "..", ".env");
  const oauthPath = path.join(__dirname, "..", "oauth-env.json");
  if (!fs.existsSync(envPath) && !fs.existsSync(oauthPath)) {
    console.warn(
      `[create-test-users] Aviso: no hay ${envPath} ni ${oauthPath} — solo variables ya exportadas en el shell.`
    );
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: poolSslOption(),
    connectionTimeoutMillis: Number(process.env.PG_POOL_CONNECTION_MS || 30_000),
  });
  await client.connect();
  try {
    await insertSuperuser(client);
  } finally {
    await client.end();
  }

  const base = apiBase();
  console.log(`[api] Base URL: ${base}`);

  for (const u of API_USERS) {
    const { res, data } = await postUser(base, adminSecret, u);
    if (res.status === 201 || res.status === 200) {
      console.log(`[api] creado ${u.username} (${u.role})`);
    } else if (res.status === 409 || data.error === "DUPLICATE_USER") {
      console.log(`[api] ya existe ${u.username} — omitido`);
    } else {
      console.error(`[api] POST ${u.username} → ${res.status}`, data);
    }
  }

  printCredentialsTable();
}

main().catch((e) => {
  console.error("[create-test-users]", e.message || e);
  process.exit(1);
});
