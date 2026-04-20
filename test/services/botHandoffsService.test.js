"use strict";

/**
 * No-regresión: isHandedOver no rompe el worker Tipo M si bot_handoffs no existe (42P01).
 * Ejecutar: npm run test:bot-handoffs-service
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const dbPath = require.resolve("../../db");
const svcPath = require.resolve("../../src/services/botHandoffsService");

function clearServiceModule() {
  delete require.cache[svcPath];
}

test("isHandedOver: 42P01 retorna { active: false, handoff: null } sin lanzar", async (t) => {
  const db = require(dbPath);
  const originalQuery = db.pool.query;
  t.after(() => {
    db.pool.query = originalQuery;
    clearServiceModule();
  });

  db.pool.query = async () => {
    const err = new Error('relation "bot_handoffs" does not exist');
    err.code = "42P01";
    throw err;
  };
  clearServiceModule();
  const { isHandedOver } = require(svcPath);
  const out = await isHandedOver(99);
  assert.deepEqual(out, { active: false, handoff: null });
});

test("isHandedOver: error 23505 se propaga", async (t) => {
  const db = require(dbPath);
  const originalQuery = db.pool.query;
  t.after(() => {
    db.pool.query = originalQuery;
    clearServiceModule();
  });

  db.pool.query = async () => {
    const err = new Error("duplicate key value violates unique constraint");
    err.code = "23505";
    throw err;
  };
  clearServiceModule();
  const { isHandedOver } = require(svcPath);
  await assert.rejects(
    () => isHandedOver(1),
    (e) => e.code === "23505"
  );
});
