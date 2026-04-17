#!/usr/bin/env node
/**
 * Pruebas GET /api/menu según prompt_pruebas_backend_v2.md
 * Requiere: servidor en marcha, DATABASE_URL, ADMIN_SECRET, JWT_SECRET.
 *   node scripts/test-menu-api-v2.js
 */
"use strict";

require("../load-env-local");

const { randomUUID } = require("crypto");
const jwt = require("jsonwebtoken");
const { pool } = require("../db-postgres");

const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Test1234!";
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const USERS = {
  SUPERUSER: { username: "superuser", password: "Ferrari2026!" },
  ADMIN: { username: "test_admin", password: PASSWORD },
  SUPERVISOR: { username: "test_supervisor", password: PASSWORD },
  VENDEDOR_MOSTRADOR: { username: "test_vendedor_mostrador", password: PASSWORD },
  VENDEDOR_EXTERNO: { username: "test_vendedor_externo", password: PASSWORD },
  OPERADOR_DIGITAL: { username: "test_operador_digital", password: PASSWORD },
  ALMACENISTA: { username: "test_almacenista", password: PASSWORD },
  CONTADOR: { username: "test_contador", password: PASSWORD },
};

const results = {};

function check(fails, label, condition) {
  const ok = Boolean(condition);
  if (!ok) fails.push(label);
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

function hasSection(menu, id) {
  return menu.some((s) => s.id === id);
}

function hasItem(menu, sectionId, itemId) {
  const sec = menu.find((s) => s.id === sectionId);
  if (!sec) return false;
  return sec.items.some((i) => i.id === itemId);
}

function getItem(menu, sectionId, itemId) {
  const sec = menu.find((s) => s.id === sectionId);
  if (!sec) return null;
  return sec.items.find((i) => i.id === itemId) ?? null;
}

function noEmptySections(menu) {
  return menu.every((s) => s.items && s.items.length > 0);
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
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

async function getMenu(token) {
  const res = await fetch(`${BASE}/api/menu`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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

async function ensureUsers() {
  if (!ADMIN_SECRET) {
    console.warn("[test-menu] ADMIN_SECRET no definido — omito POST /api/users");
    return;
  }
  const roles = [
    "ADMIN",
    "SUPERVISOR",
    "VENDEDOR_MOSTRADOR",
    "VENDEDOR_EXTERNO",
    "OPERADOR_DIGITAL",
    "ALMACENISTA",
    "CONTADOR",
  ];
  for (const role of roles) {
    const u = USERS[role].username;
    const body = {
      username: u,
      email: `${u}@test-menu.local`,
      password: PASSWORD,
      full_name: `Test ${role}`,
      role,
    };
    const { res, data } = await postJson("/api/users", body, {
      "X-Admin-Secret": ADMIN_SECRET,
    });
    if (res.status === 201 || res.status === 200) {
      console.log(`[users] creado ${u}`);
    } else if (res.status === 409 || String(data.error || "").includes("DUPLICATE")) {
      console.log(`[users] ya existe ${u}`);
    } else if (data.error === "INVALID_ROLE" || String(data.message || "").includes("Rol inválido")) {
      console.warn(
        `[users] POST ${u} → rol no existe en PG (¿migración npm run db:roles-8niveles?):`,
        data
      );
    } else {
      console.warn(`[users] POST ${u} → ${res.status}`, data);
    }
  }
}

async function login(role) {
  const { username, password } = USERS[role];
  const { res, data } = await postJson("/api/auth/login", { username, password });
  if (!res.ok || !data.token) {
    throw new Error(`${role} login falló: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.token;
}

async function buildFantasmaToken() {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) throw new Error("JWT_SECRET requerido para FANTASMA");
  const { rows } = await pool.query("SELECT id FROM users ORDER BY id LIMIT 1");
  if (!rows.length) throw new Error("Sin usuarios en BD para sesión FANTASMA");
  const userId = rows[0].id;
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + 3_600_000);
  await pool.query(
    `INSERT INTO user_sessions (user_id, jti, ip_address, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'test-menu-api-v2', $3)
     ON CONFLICT (jti) DO NOTHING`,
    [userId, jti, expiresAt]
  );
  return jwt.sign(
    {
      jti,
      userId,
      username: "fantasma",
      role: "FANTASMA",
      companyId: 1,
      permissions: [],
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function runSuperuser(menu, fails) {
  check(fails, "11 secciones", menu.length === 11);
  check(fails, "Existe config", hasSection(menu, "config"));
  check(fails, "Existe cfg.usuarios", hasItem(menu, "config", "cfg.usuarios"));
  check(fails, "Existe mercadolibre", hasSection(menu, "mercadolibre"));
  check(fails, "Existe ml.mapeo", hasItem(menu, "mercadolibre", "ml.mapeo"));
  check(fails, "Existe fin.igtf", hasItem(menu, "finanzas", "fin.igtf"));
  check(fails, "Existe fin.retenciones", hasItem(menu, "finanzas", "fin.retenciones"));
  check(
    fails,
    "Reportes moduleStatus pending",
    menu.find((s) => s.id === "reportes")?.moduleStatus === "pending"
  );
  check(fails, "Sin secciones vacías", noEmptySections(menu));
  check(fails, "Sin sección promociones", !hasSection(menu, "promociones"));
  check(fails, "Sin sección hrm", !hasSection(menu, "hrm"));
}

function runAdmin(menu, fails) {
  check(fails, "Sin cfg.usuarios", !hasItem(menu, "config", "cfg.usuarios"));
  check(fails, "Con ml.mapeo", hasItem(menu, "mercadolibre", "ml.mapeo"));
  check(fails, "Con fin.igtf", hasItem(menu, "finanzas", "fin.igtf"));
  check(fails, "Con fin.retenciones", hasItem(menu, "finanzas", "fin.retenciones"));
}

function runSupervisor(menu, fails) {
  check(fails, "Existe dashboard", hasSection(menu, "dashboard"));
  check(fails, "Existe ventas", hasSection(menu, "ventas"));
  check(fails, "Existe mercadolibre", hasSection(menu, "mercadolibre"));
  check(fails, "ml.central visible", hasItem(menu, "mercadolibre", "ml.central"));
  check(fails, "ml.reputacion visible", hasItem(menu, "mercadolibre", "ml.reputacion"));
  check(fails, "ml.mapeo NO visible", !hasItem(menu, "mercadolibre", "ml.mapeo"));
  check(fails, "ml.precios visible", hasItem(menu, "mercadolibre", "ml.precios"));
  check(fails, "Existe inventario", hasSection(menu, "inventario"));
  check(fails, "Existe logistica", hasSection(menu, "logistica"));
  check(fails, "Existe finanzas", hasSection(menu, "finanzas"));
  check(fails, "fin.igtf NO visible", !hasItem(menu, "finanzas", "fin.igtf"));
  check(fails, "fin.retenciones NO visible", !hasItem(menu, "finanzas", "fin.retenciones"));
  check(fails, "fin.documentos NO visible", !hasItem(menu, "finanzas", "fin.documentos"));
  check(fails, "Existe reportes", hasSection(menu, "reportes"));
  check(fails, "config NO visible", !hasSection(menu, "config"));
}

function runVendedorMostrador(menu, fails) {
  check(fails, "Existe ventas", hasSection(menu, "ventas"));
  check(fails, "ventas.nueva visible", hasItem(menu, "ventas", "ventas.nueva"));
  check(fails, "ventas.cotizaciones visible", hasItem(menu, "ventas", "ventas.cotizaciones"));
  check(
    fails,
    "ventas.turno future:true",
    getItem(menu, "ventas", "ventas.turno")?.future === true
  );
  check(fails, "ventas.pedidos NO visible", !hasItem(menu, "ventas", "ventas.pedidos"));
  check(fails, "ventas.aprobaciones NO visible", !hasItem(menu, "ventas", "ventas.aprobaciones"));
  check(fails, "Existe finanzas", hasSection(menu, "finanzas"));
  check(fails, "fin.caja visible", hasItem(menu, "finanzas", "fin.caja"));
  check(fails, "fin.banesco NO visible", !hasItem(menu, "finanzas", "fin.banesco"));
  check(fails, "fin.tasas NO visible", !hasItem(menu, "finanzas", "fin.tasas"));
  check(fails, "bandeja NO visible", !hasSection(menu, "bandeja"));
  check(fails, "mercadolibre NO visible", !hasSection(menu, "mercadolibre"));
  check(fails, "inventario NO visible", !hasSection(menu, "inventario"));
  check(fails, "logistica NO visible", !hasSection(menu, "logistica"));
  check(fails, "compras NO visible", !hasSection(menu, "compras"));
  check(fails, "config NO visible", !hasSection(menu, "config"));
}

function runVendedorExterno(menu, fails) {
  check(fails, "Existe bandeja", hasSection(menu, "bandeja"));
  check(fails, "bandeja.wa visible", hasItem(menu, "bandeja", "bandeja.wa"));
  check(fails, "Existe ventas", hasSection(menu, "ventas"));
  check(fails, "ventas.nueva visible", hasItem(menu, "ventas", "ventas.nueva"));
  check(fails, "inventario NO visible", !hasSection(menu, "inventario"));
  check(fails, "compras NO visible", !hasSection(menu, "compras"));
  check(fails, "config NO visible", !hasSection(menu, "config"));
}

function runOperadorDigital(menu, fails) {
  check(fails, "Existe bandeja", hasSection(menu, "bandeja"));
  check(fails, "Existe mercadolibre", hasSection(menu, "mercadolibre"));
  check(fails, "ventas NO visible", !hasSection(menu, "ventas"));
  check(
    fails,
    "bandeja.redes future:true",
    getItem(menu, "bandeja", "bandeja.redes")?.future === true
  );
  check(fails, "inventario NO visible", !hasSection(menu, "inventario"));
  check(fails, "logistica NO visible", !hasSection(menu, "logistica"));
  check(fails, "compras NO visible", !hasSection(menu, "compras"));
  check(fails, "finanzas NO visible", !hasSection(menu, "finanzas"));
  check(fails, "config NO visible", !hasSection(menu, "config"));
}

function runAlmacenista(menu, fails) {
  check(fails, "Existe inventario", hasSection(menu, "inventario"));
  check(fails, "Existe logistica", hasSection(menu, "logistica"));
  check(fails, "Existe compras", hasSection(menu, "compras"));
  check(fails, "comp.recepcion visible", hasItem(menu, "compras", "comp.recepcion"));
  check(fails, "comp.ordenes NO visible", !hasItem(menu, "compras", "comp.ordenes"));
  check(fails, "comp.proveedores NO visible", !hasItem(menu, "compras", "comp.proveedores"));
  check(fails, "comp.costos NO visible", !hasItem(menu, "compras", "comp.costos"));
  check(fails, "bandeja NO visible", !hasSection(menu, "bandeja"));
  check(fails, "ventas NO visible", !hasSection(menu, "ventas"));
  check(fails, "mercadolibre NO visible", !hasSection(menu, "mercadolibre"));
  check(fails, "finanzas NO visible", !hasSection(menu, "finanzas"));
  check(fails, "dashboard NO visible", !hasSection(menu, "dashboard"));
  check(fails, "config NO visible", !hasSection(menu, "config"));
}

function runContador(menu, fails) {
  check(fails, "Existe finanzas", hasSection(menu, "finanzas"));
  check(fails, "fin.caja visible", hasItem(menu, "finanzas", "fin.caja"));
  check(fails, "fin.igtf visible", hasItem(menu, "finanzas", "fin.igtf"));
  check(fails, "fin.retenciones visible", hasItem(menu, "finanzas", "fin.retenciones"));
  check(fails, "fin.banesco visible", hasItem(menu, "finanzas", "fin.banesco"));
  check(fails, "Existe reportes", hasSection(menu, "reportes"));
  check(fails, "ventas NO visible", !hasSection(menu, "ventas"));
  check(fails, "bandeja NO visible", !hasSection(menu, "bandeja"));
  check(fails, "inventario NO visible", !hasSection(menu, "inventario"));
  check(fails, "logistica NO visible", !hasSection(menu, "logistica"));
  check(fails, "compras NO visible", !hasSection(menu, "compras"));
  check(fails, "mercadolibre NO visible", !hasSection(menu, "mercadolibre"));
  check(fails, "config NO visible", !hasSection(menu, "config"));
}

const ROLE_CHECKS = {
  SUPERUSER:          { total: 11, run: runSuperuser },
  ADMIN:              { total: 4,  run: runAdmin },
  SUPERVISOR:         { total: 15, run: runSupervisor },
  VENDEDOR_MOSTRADOR: { total: 15, run: runVendedorMostrador },
  VENDEDOR_EXTERNO:   { total: 7,  run: runVendedorExterno },
  OPERADOR_DIGITAL:   { total: 10, run: runOperadorDigital },
  ALMACENISTA:        { total: 13, run: runAlmacenista },
  CONTADOR:           { total: 12, run: runContador },
};

async function main() {
  console.log(`[test-menu] BASE=${BASE}\n`);

  try {
    const ping = await fetch(`${BASE}/api/health`);
    if (!ping.ok) {
      console.error(
        "[test-menu] /api/health no OK. Arrancá el servidor (node server.js) y revisá PORT."
      );
      process.exit(1);
    }
  } catch (e) {
    console.error("[test-menu] No se pudo conectar:", e.message);
    process.exit(1);
  }

  await ensureUsers();

  const menus = {};

  for (const role of Object.keys(USERS)) {
    const fails = [];
    let token;
    try {
      token = await login(role);
    } catch (e) {
      console.error(`[test-menu] ${e.message}`);
      results[role] = { pass: 0, fail: 1, fails: [e.message] };
      continue;
    }

    const { res, data } = await getMenu(token);
    const menu = data.menu || [];
    menus[role] = menu;

    console.log(`\n── ${role} (HTTP ${res.status}) ──`);
    const httpOk = check(fails, "HTTP 200", res.status === 200);

    if (httpOk && ROLE_CHECKS[role]) {
      const { run } = ROLE_CHECKS[role];
      run(menu, fails);
    }

    const cfg = ROLE_CHECKS[role];
    const expected = cfg ? 1 + cfg.total : 1;
    const pass = httpOk ? expected - fails.length : 0;
    results[role] = {
      pass,
      fail: fails.length,
      fails,
    };
  }

  const hiddenIds = ["promociones", "hrm", "cms", "ui_kit"];

  console.log("\n── Casos de error ──");
  const errFails = [];

  const resSin = await fetch(`${BASE}/api/menu`);
  check(errFails, "Sin token → 401", resSin.status === 401);

  try {
    const tokF = await buildFantasmaToken();
    const resF = await fetch(`${BASE}/api/menu`, {
      headers: { Authorization: `Bearer ${tokF}` },
    });
    check(errFails, "Rol FANTASMA → 403", resF.status === 403);
  } catch (e) {
    errFails.push(`FANTASMA: ${e.message}`);
    console.log(`  ✗ FANTASMA: ${e.message}`);
  }

  for (const role of Object.keys(USERS)) {
    const menu = menus[role];
    if (!menu || !menu.length) continue;
    check(errFails, `Sin items:[] en ${role}`, noEmptySections(menu));
    for (const hid of hiddenIds) {
      check(errFails, `Sin '${hid}' en ${role}`, !hasSection(menu, hid));
    }
  }

  const errTotal = 2 + Object.keys(menus).filter((r) => menus[r]?.length).length * (1 + hiddenIds.length);
  results.ERROR = {
    pass: errTotal - errFails.length,
    fail: errFails.length,
    fails: errFails,
  };

  console.log("\n══════════════════════════════════════════════════════");
  console.log("  Rol                 | PASS | FAIL | Detalle");
  console.log("  --------------------|------|------|------------------");
  for (const [k, v] of Object.entries(results)) {
    const det = v.fails.length ? v.fails.join("; ") : "—";
    const line = `  ${k.padEnd(20)}| ${String(v.pass).padEnd(4)} | ${String(v.fail).padEnd(4)} | ${det.slice(0, 72)}`;
    console.log(line);
  }
  console.log("══════════════════════════════════════════════════════\n");

  await pool.end().catch(() => {});

  const anyFail = Object.values(results).some((v) => v.fail > 0);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
