"use strict";
require("../load-env-local");
const { pool } = require("../db");

const checks = [
  ["crm_chats.status",              "SELECT cc.status FROM crm_chats cc LIMIT 1"],
  ["crm_chats.source_type",         "SELECT cc.source_type FROM crm_chats cc LIMIT 1"],
  ["crm_chats.is_operational",      "SELECT cc.is_operational FROM crm_chats cc LIMIT 1"],
  ["crm_chats.marked_attended_at",  "SELECT cc.marked_attended_at FROM crm_chats cc LIMIT 1"],
  ["crm_chats.sales_default_hidden_at", "SELECT cc.sales_default_hidden_at FROM crm_chats cc LIMIT 1"],
  ["crm_chats.ml_question_answered_at", "SELECT cc.ml_question_answered_at FROM crm_chats cc LIMIT 1"],
  ["sales_orders.status",           "SELECT so.status FROM sales_orders so LIMIT 1"],
  ["sales_orders.conversation_id",  "SELECT so.conversation_id FROM sales_orders so LIMIT 1"],
  ["payment_status_enum",           "SELECT 'pending'::payment_status_enum"],
  ["exceptions table",              "SELECT 1 FROM exceptions LIMIT 1"],
  ["exceptions.status",             "SELECT ex.status FROM exceptions ex LIMIT 1"],
  ["bot_handoffs table",            "SELECT 1 FROM bot_handoffs LIMIT 1"],
  ["bot_actions table",             "SELECT 1 FROM bot_actions LIMIT 1"],
  ["inventario_presupuesto table",  "SELECT 1 FROM inventario_presupuesto LIMIT 1"],
  ["sales_channels table",          "SELECT 1 FROM sales_channels LIMIT 1"],
  ["crm_customer_identities table", "SELECT 1 FROM crm_customer_identities LIMIT 1"],
];

async function main() {
  const bad = [];
  for (const [label, sql] of checks) {
    try {
      await pool.query(sql);
      console.log("  OK  ", label);
    } catch (e) {
      console.log(" FAIL ", label, "→", e.message.split("\n")[0]);
      bad.push({ label, error: e.message.split("\n")[0] });
    }
  }
  await pool.end();
  if (bad.length) {
    console.log("\n=== Objetos faltantes ===");
    bad.forEach(b => console.log(" -", b.label, ":", b.error));
    process.exit(1);
  } else {
    console.log("\nTodo OK — el 503 puede ser caché del proceso Node; reiniciar el servidor.");
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
