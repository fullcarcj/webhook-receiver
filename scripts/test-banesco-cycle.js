"use strict";

/**
 * Prueba un ciclo Banesco (sesión en BD → downloadTxt → parseo → inserts).
 * Requiere DATABASE_URL, BANESCO_USER, BANESCO_PASS y cuenta en bank_accounts.
 *
 *   npm run test-banesco
 *   BANK_ACCOUNT_ID=2 npm run test-banesco
 *   BANESCO_HEADLESS=0 npm run test-banesco
 */

require("../load-env-local");

const { runCycle } = require("../src/services/banescoService");

const id = parseInt(process.env.BANK_ACCOUNT_ID || "1", 10);

runCycle(id)
  .then((r) => {
    console.log("--- RESULT ---");
    console.log(JSON.stringify(r, null, 2));
    const failed = r && (r.error || r.ok === false);
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
