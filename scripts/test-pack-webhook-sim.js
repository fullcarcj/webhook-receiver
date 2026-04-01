/**
 * Prueba interna: simula GET /messages/{id} tras webhook, persiste en ml_order_pack_messages
 * y verifica creación + actualización (mismo ml_message_id).
 *
 * Uso:
 *   node scripts/test-pack-webhook-sim.js
 *   ML_USER_ID=1335920698 ORDER_ID=2000015794834688 node scripts/test-pack-webhook-sim.js
 *   DRY_RUN=1 node scripts/test-pack-webhook-sim.js   (solo mapper, sin BD)
 *
 * Requiere DATABASE_URL salvo DRY_RUN=1.
 */
require("../load-env-local");

const { listMlOrderPackMessagesByOrder } = require("../db");
const { persistPackMessageFromWebhookFetch } = require("../ml-pack-messages-sync");

const ORDER_ID = Number(process.env.ORDER_ID || "2000015794834688");
const ML_USER_ID = Number(process.env.ML_USER_ID || "1335920698");
/** Id opaco de mensaje fijo para probar upsert (32 hex). */
const MOCK_MESSAGE_HEX = process.env.MOCK_MESSAGE_HEX || "a1b2c3d4e5f6789012345678abcdef01";
const RESOURCE_STR = process.env.MOCK_RESOURCE || MOCK_MESSAGE_HEX;

function buildParsed(text) {
  return {
    id: MOCK_MESSAGE_HEX,
    order_id: ORDER_ID,
    text,
    date_created: new Date().toISOString(),
    from: { user_id: ML_USER_ID },
    to: { user_id: 999000111 },
    status: "available",
    tag: "post_sale",
  };
}

async function main() {
  if (!Number.isFinite(ORDER_ID) || ORDER_ID <= 0 || !Number.isFinite(ML_USER_ID) || ML_USER_ID <= 0) {
    console.error("[test-pack] ORDER_ID y ML_USER_ID deben ser números válidos.");
    process.exit(1);
  }

  const dry = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  if (dry) {
    const { orderPackMessageRowFromWebhookMessageGet } = require("../ml-pack-messages-map");
    const row1 = orderPackMessageRowFromWebhookMessageGet(
      ML_USER_ID,
      ORDER_ID,
      "post_sale",
      buildParsed("hola mundo"),
      new Date().toISOString(),
      RESOURCE_STR
    );
    console.log("[test-pack] DRY_RUN — fila que se insertaría (1.ª):", JSON.stringify(row1, null, 2));
    const row2 = orderPackMessageRowFromWebhookMessageGet(
      ML_USER_ID,
      ORDER_ID,
      "post_sale",
      buildParsed("hola mundo (actualizado)"),
      new Date().toISOString(),
      RESOURCE_STR
    );
    console.log("[test-pack] DRY_RUN — fila upsert (2.ª, mismo ml_message_id):", JSON.stringify(row2, null, 2));
    console.log("[test-pack] OK (sin BD).");
    return;
  }

  if (!process.env.DATABASE_URL || !String(process.env.DATABASE_URL).trim()) {
    console.error("[test-pack] Define DATABASE_URL o usa DRY_RUN=1.");
    process.exit(1);
  }

  console.log(
    "[test-pack] ml_user_id=%s order_id=%s mensaje_id=%s",
    ML_USER_ID,
    ORDER_ID,
    MOCK_MESSAGE_HEX
  );

  const r1 = await persistPackMessageFromWebhookFetch(ML_USER_ID, ORDER_ID, buildParsed("hola mundo"), {
    tag: "post_sale",
    resourceStr: RESOURCE_STR,
  });
  console.log("[test-pack] 1.ª persistencia:", r1);
  let rows = await listMlOrderPackMessagesByOrder(ML_USER_ID, ORDER_ID, 20);
  console.log("[test-pack] filas en BD tras 1.ª inserción (%s):", rows.length);
  rows.forEach((r) =>
    console.log(
      "  id=%s ml_message_id=%s text=%s fetched_at=%s",
      r.id,
      r.ml_message_id,
      (r.message_text || "—").slice(0, 80),
      r.fetched_at
    )
  );

  const r2 = await persistPackMessageFromWebhookFetch(
    ML_USER_ID,
    ORDER_ID,
    buildParsed("hola mundo (actualizado)"),
    { tag: "post_sale", resourceStr: RESOURCE_STR }
  );
  console.log("[test-pack] 2.ª persistencia (mismo id, texto distinto):", r2);
  rows = await listMlOrderPackMessagesByOrder(ML_USER_ID, ORDER_ID, 20);
  console.log("[test-pack] filas en BD tras 2.ª upsert (%s):", rows.length);
  rows.forEach((r) =>
    console.log(
      "  id=%s ml_message_id=%s text=%s updated_at=%s",
      r.id,
      r.ml_message_id,
      (r.message_text || "—").slice(0, 120),
      r.updated_at
    )
  );

  const updated = rows.find((x) => String(x.ml_message_id) === String(MOCK_MESSAGE_HEX));
  if (updated && String(updated.message_text).includes("actualizado")) {
    console.log("[test-pack] OK: el texto se actualizó en el mismo registro (upsert).");
  } else {
    console.warn("[test-pack] Revisar: no se encontró el texto actualizado en la fila esperada.");
  }
}

main().catch((e) => {
  console.error("[test-pack]", e);
  process.exit(1);
});
