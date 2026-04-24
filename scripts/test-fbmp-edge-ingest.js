#!/usr/bin/env node
/**
 * Test de integración básico para el módulo fbmp_edge.
 *
 * Uso (PowerShell, misma ventana):
 *   $env:FBMP_EDGE_INGEST_SECRET="tu_token"; $env:ADMIN_SECRET="tu_admin"; npm run test:fbmp-edge
 *
 * Opcional: BASE_URL=http://localhost:3001 (default 3002)
 *
 * Lo que verifica:
 *   1. GET /api/fbmp-edge/status — sin auth
 *   2. POST /api/fbmp-edge/ingest — requiere FBMP_EDGE_INGEST_SECRET (Bearer)
 *   3. GET /api/fbmp-edge/outbox — mismo Bearer
 *   4. Idempotencia dedupe_key
 *   5. GET /api/fbmp-edge/threads — requiere X-Admin-Secret o JWT (no Bearer ADMIN_SECRET)
 */

"use strict";

require("../load-env-local");

const BASE    = (process.env.BASE_URL || "http://localhost:3002").replace(/\/$/, "");
const SECRET  = (process.env.FBMP_EDGE_INGEST_SECRET || "").trim();
const ADMIN_K = (process.env.ADMIN_SECRET || "").trim();

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed++;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}
function skip(label) {
  skipped++;
  console.log(`  ○ ${label} (omitido)`);
}

/**
 * @param {object} [auth]
 * @param {string} [auth.bearer]       — FBMP_EDGE_INGEST_SECRET
 * @param {string} [auth.adminSecret] — ADMIN_SECRET vía cabecera X-Admin-Secret
 */
async function req(method, path, body, auth) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (auth?.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  if (auth?.adminSecret) headers["X-Admin-Secret"] = auth.adminSecret;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log(`\n[fbmp_edge test] → ${BASE}\n`);

  const s = await req("GET", "/api/fbmp-edge/status", null, {});
  s.status === 200 && s.data.ok
    ? ok("GET /status → 200 ok")
    : fail("GET /status", `HTTP ${s.status}`);

  if (!SECRET) {
    skip("Ingest / outbox / auth Bearer — define FBMP_EDGE_INGEST_SECRET en el entorno (mismo valor que en Render y en la extensión)");
  } else {
    const threadId = `test_thread_${Date.now()}`;
    const dedupeKey = `test_${Date.now()}`;
    const r = await req(
      "POST",
      "/api/fbmp-edge/ingest",
      {
        thread_external_id: threadId,
        participant_name: "Cliente Test",
        messages: [
          { direction: "inbound", body: "Hola, ¿tienen el repuesto?", dedupe_key: `${dedupeKey}_1` },
          { direction: "outbound", body: "Sí, está disponible.", dedupe_key: `${dedupeKey}_2` },
        ],
      },
      { bearer: SECRET }
    );
    r.status === 200 && r.data.ok && r.data.inserted === 2
      ? ok(`POST /ingest → 200 (inserted: ${r.data.inserted}, thread_id: ${r.data.thread_id})`)
      : fail("POST /ingest", `HTTP ${r.status} — ${JSON.stringify(r.data)}`);

    const r2 = await req(
      "POST",
      "/api/fbmp-edge/ingest",
      {
        thread_external_id: threadId,
        messages: [{ direction: "inbound", body: "Hola, ¿tienen el repuesto?", dedupe_key: `${dedupeKey}_1` }],
      },
      { bearer: SECRET }
    );
    r2.status === 200 && r2.data.duplicates === 1 && r2.data.inserted === 0
      ? ok(`POST /ingest idempotente → duplicates: ${r2.data.duplicates}`)
      : fail("POST /ingest idempotencia", `HTTP ${r2.status} — ${JSON.stringify(r2.data)}`);

    const ob = await req("GET", "/api/fbmp-edge/outbox", null, { bearer: SECRET });
    ob.status === 200 && Array.isArray(ob.data.items)
      ? ok("GET /outbox → 200")
      : fail("GET /outbox", `HTTP ${ob.status}`);

    const r3 = await req(
      "POST",
      "/api/fbmp-edge/ingest",
      {
        thread_external_id: "no_auth_test",
        messages: [{ direction: "inbound", body: "x", dedupe_key: "noauth1" }],
      },
      { bearer: "token_incorrecto" }
    );
    r3.status === 401
      ? ok("POST /ingest Bearer incorrecto → 401")
      : fail("Auth check", `esperado 401, recibido ${r3.status}`);
  }

  if (!ADMIN_K) {
    skip("GET /threads (admin) — define ADMIN_SECRET para probar con X-Admin-Secret");
  } else {
    const t = await req("GET", "/api/fbmp-edge/threads?limit=5", null, { adminSecret: ADMIN_K });
    t.status === 200 && Array.isArray(t.data.items)
      ? ok(`GET /threads (admin) → ${t.data.items.length} hilo(s)`)
      : fail("GET /threads admin", `HTTP ${t.status} — ${JSON.stringify(t.data)}`);
  }

  console.log(`\nResultado: ${passed} OK, ${failed} fallidos, ${skipped} omitidos\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("[fbmp_edge test] Error inesperado:", err.message);
  process.exit(1);
});
