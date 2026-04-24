#!/usr/bin/env node
/**
 * Test de integración básico para el módulo fbmp_edge.
 *
 * Uso:
 *   FBMP_EDGE_INGEST_SECRET=tu_secret BASE_URL=http://localhost:3002 node scripts/test-fbmp-edge-ingest.js
 *   o simplemente: npm run test:fbmp-edge
 *
 * Lo que verifica:
 *   1. GET /api/fbmp-edge/status — módulo responde
 *   2. POST /api/fbmp-edge/ingest — crea thread + mensajes
 *   3. GET /api/fbmp-edge/outbox  — endpoint accesible con el mismo Bearer
 *   4. POST idempotente (mismo dedupe_key → no duplica)
 */

"use strict";

require("../load-env-local");

const BASE     = (process.env.BASE_URL || "http://localhost:3002").replace(/\/$/, "");
const SECRET   = process.env.FBMP_EDGE_INGEST_SECRET || "";
const ADMIN_K  = process.env.ADMIN_SECRET || "";

let passed = 0;
let failed = 0;

function ok(label)  { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }

async function req(method, path, body, auth) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (auth) headers["Authorization"] = `Bearer ${auth}`;
  const res  = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log(`\n[fbmp_edge test] → ${BASE}\n`);

  // 1. Status
  const s = await req("GET", "/api/fbmp-edge/status", null, SECRET);
  s.status === 200 && s.data.ok
    ? ok("GET /status → 200 ok")
    : fail("GET /status", `HTTP ${s.status}`);

  if (!SECRET) {
    fail("FBMP_EDGE_INGEST_SECRET no definido — los tests de ingest se saltean");
  } else {
    // 2. Ingest
    const threadId = `test_thread_${Date.now()}`;
    const dedupeKey = `test_${Date.now()}`;
    const r = await req("POST", "/api/fbmp-edge/ingest", {
      thread_external_id: threadId,
      participant_name:   "Cliente Test",
      messages: [
        { direction: "inbound",  body: "Hola, ¿tienen el repuesto?", dedupe_key: `${dedupeKey}_1` },
        { direction: "outbound", body: "Sí, está disponible.",        dedupe_key: `${dedupeKey}_2` },
      ],
    }, SECRET);
    (r.status === 200 && r.data.ok && r.data.inserted === 2)
      ? ok(`POST /ingest → 200 (inserted: ${r.data.inserted}, thread_id: ${r.data.thread_id})`)
      : fail("POST /ingest", `HTTP ${r.status} — ${JSON.stringify(r.data)}`);

    // 3. Idempotencia (mismo dedupe_key)
    const r2 = await req("POST", "/api/fbmp-edge/ingest", {
      thread_external_id: threadId,
      messages: [
        { direction: "inbound", body: "Hola, ¿tienen el repuesto?", dedupe_key: `${dedupeKey}_1` },
      ],
    }, SECRET);
    (r2.status === 200 && r2.data.duplicates === 1 && r2.data.inserted === 0)
      ? ok(`POST /ingest idempotente → duplicates: ${r2.data.duplicates}`)
      : fail("POST /ingest idempotencia", `HTTP ${r2.status} — ${JSON.stringify(r2.data)}`);

    // 4. Outbox
    const ob = await req("GET", "/api/fbmp-edge/outbox", null, SECRET);
    ob.status === 200 && Array.isArray(ob.data.items)
      ? ok("GET /outbox → 200")
      : fail("GET /outbox", `HTTP ${ob.status}`);

    // 5. Ingest sin SECRET → 401
    const r3 = await req("POST", "/api/fbmp-edge/ingest", {
      thread_external_id: "no_auth_test",
      messages: [{ direction: "inbound", body: "x", dedupe_key: "noauth1" }],
    }, "token_incorrecto");
    r3.status === 401
      ? ok("POST /ingest Bearer incorrecto → 401")
      : fail("Auth check", `esperado 401, recibido ${r3.status}`);
  }

  // 6. Threads (admin)
  if (ADMIN_K) {
    const t = await req("GET", `/api/fbmp-edge/threads?limit=5`, null, ADMIN_K);
    (t.status === 200 && t.data.items)
      ? ok(`GET /threads (admin) → ${t.data.items.length} hilo(s)`)
      : fail("GET /threads admin", `HTTP ${t.status}`);
  } else {
    console.log("  — GET /threads: ADMIN_SECRET no definido, saltado");
  }

  console.log(`\nResultado: ${passed} OK, ${failed} fallidos\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("[fbmp_edge test] Error inesperado:", err.message);
  process.exit(1);
});
