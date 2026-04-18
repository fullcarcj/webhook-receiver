"use strict";
/**
 * Ejecuta el backfill de conversation_id en sales_orders.
 * Aplica solo matches claros (customer_id con exactamente 1 chat en crm_chats).
 *
 * Uso: node scripts/run-backfill-conversation-id.js
 */
require("../load-env-local");
const { pool } = require("../db");

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1 · Snapshot
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_orders_pre_backfill_20260421 AS
      SELECT id, conversation_id FROM sales_orders
    `);
    console.log("[backfill] Snapshot creado: sales_orders_pre_backfill_20260421");

    // 2 · Estado previo
    const prev = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE conversation_id IS NOT NULL) AS con_link_previo,
        COUNT(*) FILTER (WHERE conversation_id IS NULL)     AS sin_link_previo
      FROM sales_orders
    `);
    console.log("[backfill] Estado previo:", prev.rows[0]);

    // 3 · Aplicar backfill (solo matches claros)
    const upd = await client.query(`
      UPDATE sales_orders so
      SET conversation_id = (
        SELECT cc.id FROM crm_chats cc
        WHERE cc.customer_id = so.customer_id
        ORDER BY cc.updated_at DESC NULLS LAST, cc.id DESC
        LIMIT 1
      )
      WHERE so.conversation_id IS NULL
        AND so.customer_id IS NOT NULL
        AND (
          SELECT COUNT(*) FROM crm_chats cc WHERE cc.customer_id = so.customer_id
        ) = 1
    `);
    console.log(`[backfill] Órdenes actualizadas: ${upd.rowCount}`);

    // 4 · Estado post-update
    const post = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE conversation_id IS NOT NULL) AS con_link_ahora,
        COUNT(*) FILTER (WHERE conversation_id IS NULL)     AS sigue_null
      FROM sales_orders
    `);
    console.log("[backfill] Estado posterior:", post.rows[0]);

    // 5 · Detalle de órdenes actualizadas
    const det = await client.query(`
      SELECT so.id AS order_id, so.customer_id, so.conversation_id, so.created_at::date AS order_date
      FROM sales_orders so
      INNER JOIN sales_orders_pre_backfill_20260421 snap ON snap.id = so.id
      WHERE snap.conversation_id IS NULL AND so.conversation_id IS NOT NULL
      ORDER BY so.id
    `);
    console.log("[backfill] Detalle actualizadas:", JSON.stringify(det.rows, null, 2));

    await client.query("COMMIT");
    console.log("[backfill] COMMIT OK");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[backfill] ERROR → ROLLBACK:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
