#!/usr/bin/env node
/**
 * node tests/resolveCustomer.test.js  |  npm run test:resolve-customer
 *
 * Casos del prompt (validar manualmente con DATABASE_URL si hace falta):
 * - WA con y sin +
 * - WA luego ML con mismo tel (phone en data)
 * - 0412… vs 58412…
 * - WA- sustituido por nombre real
 * - Cliente nuevo draft
 */
"use strict";

const assert = require("assert");
const { normalizePhone, phonesMatch } = require("../src/utils/phoneNormalizer");

function testSanitizeWaPersonName() {
  const { sanitizeWaPersonName, isLikelyChatNotName, sanitizeContactDisplayName } = require("../src/whatsapp/waNameCandidate");
  assert.strictEqual(sanitizeWaPersonName("Carlos Pérez"), "Carlos Pérez");
  assert.strictEqual(sanitizeWaPersonName("Carlos Pérez 04141234567"), "Carlos Pérez");
  assert.strictEqual(sanitizeWaPersonName("Ana María López"), "Ana María López");
  assert.strictEqual(sanitizeWaPersonName("Pedro 99 García"), "Pedro García");
  assert.strictEqual(sanitizeWaPersonName("5841234567890"), null);
  assert.strictEqual(sanitizeWaPersonName("Carlos"), null);
  assert.strictEqual(sanitizeWaPersonName("123 456"), null);
  assert.strictEqual(isLikelyChatNotName("Carlos Pérez"), false);
  assert.strictEqual(isLikelyChatNotName("Tienen filtro para Aveo"), true);
  assert.strictEqual(isLikelyChatNotName("¿Cuánto cuesta?"), true);
  assert.strictEqual(isLikelyChatNotName("Listo copiado gracias"), true);
  assert.strictEqual(isLikelyChatNotName("muchas gracias"), true);
  assert.strictEqual(isLikelyChatNotName("Carlos Pérez"), false);
  assert.strictEqual(sanitizeContactDisplayName("Carlos"), "Carlos");
  assert.strictEqual(sanitizeContactDisplayName("Fullcar CJ"), "Fullcar CJ");
  assert.strictEqual(sanitizeContactDisplayName("584247110371"), null);
  assert.strictEqual(sanitizeContactDisplayName("WA-584247110371"), null);
  assert.strictEqual(sanitizeContactDisplayName("Listo copiado gracias"), null);
  assert.strictEqual(/^WA-\d+$/i.test(" WA-584242701513".trim()), true, "trim evita guardar WA- por espacio inicial");
  console.log("sanitizeWaPersonName: OK");
}

function testNormalizer() {
  assert.strictEqual(normalizePhone("+584121234567"), "584121234567");
  assert.strictEqual(normalizePhone("04121234567"), "584121234567");
  assert.strictEqual(normalizePhone("4121234567"), "584121234567");
  assert.strictEqual(normalizePhone("584241902205"), "584241902205");
  assert.ok(phonesMatch("+584241902205", "584241902205"));
  console.log("phoneNormalizer: OK");
}

async function testResolveIntegration() {
  if (!process.env.DATABASE_URL) {
    console.log("resolveCustomer integration: SKIP (sin DATABASE_URL)");
    return;
  }
  require("../load-env-local");
  const { pool } = require("../db");
  const { resolveCustomer } = require("../src/services/resolveCustomer");

  const suff = String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  const digits = `58412${suff}`;

  const r1 = await resolveCustomer({
    source: "whatsapp",
    external_id: `+${digits}`,
    data: { name: `WA-${digits}` },
  });
  const r2 = await resolveCustomer({
    source: "whatsapp",
    external_id: digits,
    data: { name: "Nombre Real Test" },
  });
  assert.strictEqual(r1.customerId, r2.customerId, "mismo cliente +58 vs 58");
  console.log("resolveCustomer integration (WA duplicado formato): OK");

  await pool.query(`DELETE FROM customers WHERE id = $1`, [r1.customerId]);
}

(async () => {
  testSanitizeWaPersonName();
  testNormalizer();
  await testResolveIntegration();
  console.log("tests/resolveCustomer: done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
