/**
 * Prueba directa Wasender: imagen+caption y ubicación (mismo flujo que tipo E) sin orden en BD.
 * Uso: node scripts/wasender-test-tipo-e-direct.js [+E164]
 */
require("../load-env-local");

const { sendWasenderImageMessage, sendWasenderLocationMessage } = require("../wasender-client");
const {
  mergeTipoEConfig,
  buildTipoELocationStep2,
  resolveWasenderRuntimeConfig,
} = require("../ml-whatsapp-tipo-ef");

const to = process.argv[2] && String(process.argv[2]).trim() !== "" ? String(process.argv[2]).trim() : "+584242701513";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const cfg = await resolveWasenderRuntimeConfig();
  if (!cfg.enabled || !cfg.apiKey) {
    console.error(JSON.stringify({ ok: false, detail: "WASENDER desactivado o sin API key" }));
    process.exit(1);
  }
  const merged = await mergeTipoEConfig();
  const caption = merged.imageCaption.trim();
  const imageUrl = merged.imageUrl.trim();
  if (!imageUrl) {
    console.error(JSON.stringify({ ok: false, detail: "Sin imagen URL en config/env" }));
    process.exit(1);
  }
  const vars = { order_id: "prueba", buyer_id: "-", seller_id: "-", status: "" };
  const loc2 = buildTipoELocationStep2(vars, null, merged);

  console.log("1/2 Imagen + texto (caption)…");
  const r1 = await sendWasenderImageMessage({
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    to,
    imageUrl,
    text: caption,
  });
  console.log("imagen:", JSON.stringify(r1));

  // Wasender "Account protection": típicamente 1 mensaje / 5 s entre envíos.
  const gapMs = Math.max(
    5500,
    Number(process.env.WASENDER_MIN_GAP_MS) || 0,
    Number(merged.delayMs) || 0
  );
  await sleep(gapMs);

  console.log("2/2 Ubicación + leyenda…");
  const r2 = await sendWasenderLocationMessage({
    apiBaseUrl: cfg.apiBaseUrl,
    apiKey: cfg.apiKey,
    to,
    latitude: loc2.latitude,
    longitude: loc2.longitude,
    name: loc2.name,
    address: loc2.address,
    text: loc2.text,
  });
  console.log("ubicación:", JSON.stringify(r2));

  process.exit(r1.ok && r2.ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
