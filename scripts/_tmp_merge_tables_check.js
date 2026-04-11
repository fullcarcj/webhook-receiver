require('../load-env-local');
const { pool } = require('../db');

const tables = [
  'customers',
  'crm_customer_identities',
  'crm_customer_vehicles',
  'crm_messages',
  'crm_chats',
  'sales_orders',
  'loyalty_accounts',
];

async function main() {
  for (const t of tables) {
    try {
      await pool.query(`SELECT 1 FROM ${t} LIMIT 1`);
      console.log(`OK ${t}`);
    } catch (e) {
      console.log(`ERR ${t} ${e.code || ''} ${e.message || e}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch (_) {}
  });
