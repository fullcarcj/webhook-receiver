/**
 * Volcado NDJSON opcional de webhooks Wasender (una línea JSON por evento).
 * WASENDER_WEBHOOK_LOG_FILE=0|false — no escribe archivo.
 * Sin variable o valor vacío — default `wasender-webhook.log` en la raíz del proyecto.
 * Cualquier otra ruta (relativa o absoluta) — archivo destino.
 */
const fs = require("fs");
const path = require("path");

function appendWasenderWebhookNdjsonLine(lineObj) {
  const flag = process.env.WASENDER_WEBHOOK_LOG_FILE;
  if (flag === "0" || flag === "false") return;
  let rel = "wasender-webhook.log";
  if (flag != null && String(flag).trim() !== "") {
    rel = String(flag).trim();
  }
  if (rel === "0") return;
  const p = path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
  const line = JSON.stringify(lineObj) + "\n";
  fs.appendFile(p, line, (err) => {
    if (err) console.error("[wasender-webhook log]", err.message);
  });
}

module.exports = { appendWasenderWebhookNdjsonLine };
