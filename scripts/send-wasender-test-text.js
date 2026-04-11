#!/usr/bin/env node
"use strict";
/**
 * Prueba manual de envío de texto por Wasender (sin pasar por cola Tipo M).
 *
 *   RUN_WA_TEST_CONFIRM=1 node scripts/send-wasender-test-text.js +584242701513
 *
 * Requiere: WASENDER_API_KEY (y opcional WASENDER_API_BASE_URL). Sin RUN_WA_TEST_CONFIRM=1 no envía nada.
 */
require("../load-env-local");
const { sendWasenderTextMessage } = require("../wasender-client");

async function main() {
  const to = process.argv[2];
  if (!to || !String(to).trim()) {
    console.error("Uso: RUN_WA_TEST_CONFIRM=1 node scripts/send-wasender-test-text.js +584242701513");
    process.exit(1);
  }
  if (String(process.env.RUN_WA_TEST_CONFIRM || "").trim() !== "1") {
    console.error("Seguridad: defina RUN_WA_TEST_CONFIRM=1 para ejecutar el envío real.");
    process.exit(1);
  }
  const apiKey = process.env.WASENDER_API_KEY;
  if (!apiKey) {
    console.error("Falta WASENDER_API_KEY");
    process.exit(1);
  }
  const apiBaseUrl = process.env.WASENDER_API_BASE_URL || "https://www.wasenderapi.com";
  const text =
    process.argv[3] ||
    "Prueba webhook-receiver (script send-wasender-test-text). Si llega, Wasender OK.";
  const r = await sendWasenderTextMessage({
    apiKey,
    apiBaseUrl,
    to: String(to).trim(),
    text,
    messageType: "CHAT",
  });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r && r.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
