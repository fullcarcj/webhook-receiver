"use strict";

/**
 * No-regresión: cola automática Tipo M y estados de worker excluyen legacy_archived.
 * Ejecutar: npm run test:ai-responder-legacy
 *
 * Pruebas HTTP + BD contra approve/override/draft en legacy_archived: ejecutar manualmente
 * con mensaje de prueba o integración E2E (no incluido aquí).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { INBOUND_AI_QUEUE_STATUSES } = require("../../src/workers/aiResponderWorker");

test("INBOUND_AI_QUEUE_STATUSES excluye legacy_archived", () => {
  assert.ok(!INBOUND_AI_QUEUE_STATUSES.includes("legacy_archived"));
  assert.deepEqual(
    [...INBOUND_AI_QUEUE_STATUSES].sort(),
    ["pending_ai_reply", "pending_receipt_confirm"].sort()
  );
});

test("responderCycle construye IN (...) solo con estados de cola inbound", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(
    path.join(__dirname, "../../src/workers/aiResponderWorker.js"),
    "utf8"
  );
  assert.ok(src.includes("INBOUND_AI_QUEUE_STATUSES"));
  assert.ok(src.includes("statusIn"));
  const idx = src.indexOf("WHERE ai_reply_status IN");
  assert.ok(idx > 0);
  const slice = src.slice(idx, idx + 400);
  assert.ok(!slice.includes("legacy_archived"), "la subconsulta de claim no debe incluir legacy_archived");
});
