"use strict";
/**
 * Tarea: gate source_type + auditoría columnas crm_chats y tablas relacionadas.
 * Uso: node scripts/omnichannel-schema-audit.js
 */
require("../load-env-local");
const { Client } = require("pg");
const { spawnSync } = require("child_process");
const path = require("path");

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

async function query(client, label, sql) {
  console.log("\n--- " + label + " ---\n");
  const r = await client.query(sql);
  if (!r.rows.length) {
    console.log("(sin filas)");
    return;
  }
  const keys = Object.keys(r.rows[0]);
  console.log(keys.join("\t"));
  for (const row of r.rows) {
    console.log(keys.map((k) => String(row[k] ?? "")).join("\t"));
  }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("NO DATABASE_URL");
    process.exit(1);
  }

  const root = path.join(__dirname, "..");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  let client = new Client({ connectionString: url, ssl: poolSslOption() });
  await client.connect();

  const gate = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crm_chats'
      AND column_name = 'source_type'
  `);
  console.log("=== PASO 1 — Gate source_type ===");
  console.log("filas:", gate.rows.length);
  if (gate.rows.length === 0) {
    console.log("\n→ 0 filas: ejecutando PASO 2 (npm run db:sales-channels && db:omnichannel)\n");
    await client.end();
    for (const script of ["run db:sales-channels", "run db:omnichannel"]) {
      const r = spawnSync(npm, script.split(" "), {
        cwd: root,
        stdio: "inherit",
        shell: false,
      });
      if (r.status !== 0) {
        console.error("Falló:", script, "status", r.status);
        process.exit(1);
      }
    }
    client = new Client({ connectionString: url, ssl: poolSslOption() });
    await client.connect();
  } else {
    console.log("→ 1 fila: saltando PASO 2 (migraciones ya aplicadas)\n");
  }

  console.log("\n=== PASO 3 — Outputs 1 a 5 ===");

  await query(
    client,
    "1) crm_chats columnas omnicanal",
    `
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crm_chats'
      AND column_name IN (
        'source_type','ml_order_id','ml_buyer_id',
        'ml_question_id','ml_pack_id',
        'identity_status','assigned_to'
      )
    ORDER BY column_name
  `
  );

  for (const [num, table] of [
    [2, "crm_customer_identities"],
    [3, "ml_item_sku_map"],
    [4, "ml_questions_pending"],
    [5, "ml_order_messages"],
  ]) {
    await query(
      client,
      `${num}) Schema ${table}`,
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `
    );
  }

  await client.end();

  console.log("\n--- 6) Tabla de productos activa (rg primeros 20 archivos) ---\n");
  const rg =
    process.platform === "win32"
      ? path.join(root, "node_modules", ".bin", "rg.cmd")
      : path.join(root, "node_modules", ".bin", "rg");
  const patterns = "FROM products|FROM productos|from products|from productos";
  const r2 = spawnSync(
    rg,
    ["-l", patterns, "src/", "-g", "*.js", "-g", "*.ts", "--glob", "!node_modules"],
    { cwd: root, encoding: "utf8" }
  );
  if (r2.status !== 0 && r2.stderr) {
    console.log("rg stderr:", r2.stderr);
    console.log("(Si rg no está instalado, instalar ripgrep o usar grep del sistema)");
  }
  const files = (r2.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 20);
  if (!files.length) {
    console.log("(sin coincidencias o rg no disponible)");
  } else {
    files.forEach((f) => console.log(f));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
