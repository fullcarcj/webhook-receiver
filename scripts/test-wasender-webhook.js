/**
 * POST de prueba tipo Wasender (JSON válido, UTF-8). Evita el alias `curl` de PowerShell.
 *
 * Uso:
 *   npm run test-wasender-hook
 *   node scripts/test-wasender-webhook.js 3001 /webhook
 *
 * Env: PORT por defecto 3001 si no pasás argumento; WASENDER_WEBHOOK_SECRET para cabecera;
 *      WASENDER_TEST_HOST (default 127.0.0.1), WASENDER_TEST_PATH (default /webhook).
 */
require("../load-env-local");

const http = require("http");

const port = Number(process.argv[2] || process.env.PORT || 3001);
const path = process.argv[3] || process.env.WASENDER_TEST_PATH || "/webhook";
const host = process.env.WASENDER_TEST_HOST || "127.0.0.1";

const payload = {
  event: "session.status",
  data: { test: true, at: new Date().toISOString() },
};

const body = JSON.stringify(payload);
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Content-Length": Buffer.byteLength(body, "utf8"),
};
const secret = process.env.WASENDER_WEBHOOK_SECRET || process.env.WASENDER_X_WEBHOOK_SIGNATURE;
if (secret && String(secret).trim() !== "") {
  headers["X-Webhook-Signature"] = String(secret).trim();
}

const req = http.request(
  { hostname: host, port, path, method: "POST", headers },
  (res) => {
    let d = "";
    res.on("data", (c) => {
      d += c;
    });
    res.on("end", () => {
      console.log("HTTP %s %s", res.statusCode, d);
      process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
    });
  }
);
req.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
req.write(body);
req.end();
