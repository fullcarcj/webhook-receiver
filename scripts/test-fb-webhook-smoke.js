/**
 * Prueba de humo para el handler de webhooks Facebook Messenger.
 * Levanta un servidor HTTP local, envía payloads simulados y verifica respuestas.
 * Uso: node scripts/test-fb-webhook-smoke.js
 */
"use strict";

// Carga variables locales si existe oauth-env.json
try { require("../load-env-local"); } catch (_) {}

// Forzar token de prueba (override de oauth-env.json si existe)
const SMOKE_VERIFY_TOKEN = "smoke_test_token_" + Date.now();
process.env.FB_WEBHOOK_VERIFY_TOKEN = SMOKE_VERIFY_TOKEN;

const http = require("http");
const { handleFacebookWebhookRequest } = require("../src/handlers/facebookWebhookHandler");

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: "localhost", port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => { resolve({ status: res.statusCode, body: data }); });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getUrl(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { resolve({ status: res.statusCode, body: data }); });
    }).on("error", reject);
  });
}

async function run() {
  console.log("\n=== Facebook Webhook Smoke Tests ===\n");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost:9979");
    const handled = await handleFacebookWebhookRequest(req, res, url);
    if (!handled) { res.writeHead(404); res.end("not found"); }
  });

  await new Promise((r) => server.listen(9979, r));

  // ── TEST 1: GET verify — token correcto → 200 + challenge ────────────────
  {
    const { status, body } = await getUrl(9979,
      `/webhook/facebook?hub.mode=subscribe&hub.verify_token=${SMOKE_VERIFY_TOKEN}&hub.challenge=ABC123`);
    assert("GET verify token correcto → 200 + challenge", status === 200 && body === "ABC123", `status=${status} body=${body}`);
  }

  // ── TEST 2: GET verify — token incorrecto → 403 ───────────────────────────
  {
    const { status } = await getUrl(9979,
      "/webhook/facebook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=X");
    assert("GET verify token incorrecto → 403", status === 403, `status=${status}`);
  }

  // ── TEST 3: POST inbound válido → 200 inmediato ───────────────────────────
  {
    const payload = {
      object: "page",
      entry: [{
        id: "PAGE_001",
        messaging: [{
          sender: { id: "PSID_SMOKE_001" },
          recipient: { id: "PAGE_001" },
          timestamp: Math.floor(Date.now() / 1000),
          message: { mid: `mid.smoke.${Date.now()}`, text: "Hola, quiero repuestos de freno" }
        }]
      }]
    };
    const { status, body } = await postJson(9979, "/webhook/facebook", payload);
    assert("POST inbound valido → 200", status === 200, `status=${status}`);
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {}
    assert("POST inbound body {ok:true}", parsed && parsed.ok === true, `body=${body}`);
  }

  // ── TEST 4: POST non-page object → 200 (ACK) pero no procesa ─────────────
  {
    const { status } = await postJson(9979, "/webhook/facebook", { object: "instagram", entry: [] });
    assert("POST objeto no-page → 200 (ACK, sin procesar)", status === 200, `status=${status}`);
  }

  // ── TEST 5: Ruta distinta → no manejada (404) ─────────────────────────────
  {
    const { status } = await getUrl(9979, "/webhook/other");
    assert("Ruta distinta no manejada → 404", status === 404, `status=${status}`);
  }

  // Esperar que setImmediate procese los mensajes antes de cerrar
  await new Promise((r) => setTimeout(r, 2000));
  server.close();

  console.log(`\n  Resultado: ${passed} pasados, ${failed} fallidos\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("[smoke] error inesperado:", e);
  process.exit(1);
});
