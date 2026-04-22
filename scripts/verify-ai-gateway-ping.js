#!/usr/bin/env node
"use strict";
/**
 * Diagnóstico rápido: provider_settings (límites diarios, circuit breaker, habilitado)
 * + una llamada mínima a Groq (callChatBasic) y a Gemini (callVision texto).
 *
 * Uso: npm run verify:ai-gateway-ping
 * Requiere: DATABASE_URL. Opcional: GROQ_API_KEY, GEMINI_API_KEY (o claves en BD).
 */
require("../load-env-local");
const { pool } = require("../db");
const {
  getProvider,
  checkLimits,
  isCircuitOpen,
  resolveApiKey,
  callChatBasic,
  callVision,
} = require("../src/services/aiGateway");

function isUndefTable(err) {
  return err && (err.code === "42P01" || /does not exist/i.test(String(err.message || "")));
}

/** Intenta extraer el JSON del cuerpo de error HTTP de Groq (viene en el mensaje de Error). */
function parseGroq429Body(msg) {
  const s = String(msg || "");
  const idx = s.indexOf("{");
  if (idx < 0) return null;
  try {
    return JSON.parse(s.slice(idx));
  } catch (_) {
    return null;
  }
}

function printPostMortem(service, err) {
  const msg = String(err && err.message ? err.message : err);
  console.log("  ── Qué significa ──");

  if (/Groq.*429|rate_limit|TPD/i.test(msg)) {
    const j = parseGroq429Body(msg);
    const inner = j && j.error;
    if (inner && inner.message) {
      console.log("  Groq:", inner.message);
    } else {
      console.log("  Groq rechazó la petición (429). Suele ser tope diario de tokens (TPD) en tier gratuito / on_demand.");
    }
    console.log(
      "  → Acciones: esperar el tiempo que indica el mensaje; subir a Dev Tier / billing en https://console.groq.com/settings/billing ; o usar otra API key / organización con cuota disponible."
    );
    return;
  }

  if (/Gemini.*429|RESOURCE_EXHAUSTED/i.test(msg)) {
    console.log("  Google Gemini: cuota agotada o muchas peticiones (429 RESOURCE_EXHAUSTED).");
    console.log(
      "  → Acciones: esperar y reintentar; revisar cuota en Google AI / Cloud; probar otra clave o proyecto si aplica."
    );
    return;
  }

  console.log("  Revisa el mensaje arriba. Si no es 429, puede ser red, clave inválida o modelo descontinuado.");
}

async function describeProvider(providerId) {
  console.log(`\n── ${providerId} ──`);
  let row;
  try {
    row = await getProvider(pool, providerId);
  } catch (e) {
    if (isUndefTable(e)) {
      console.log("  Tabla provider_settings no existe (npm run db:provider-settings). Se usa solo env si aplica.");
      return { canCall: true, fromDb: false };
    }
    console.log("  Error leyendo BD:", e.message);
    return { canCall: false, fromDb: false };
  }
  if (!row) {
    console.log("  Sin fila en provider_settings → el gateway usa GROQ_API_KEY / GEMINI_API_KEY del entorno.");
    return { canCall: true, fromDb: false };
  }
  console.log("  enabled (BD):", row.enabled);
  console.log("  model_name:", row.model_name || "—");
  console.log("  uso tokens hoy:", row.current_daily_usage, "/", row.daily_token_limit);
  console.log("  requests hoy:", row.current_daily_requests, "/", row.daily_request_limit);
  console.log("  consecutive_failures:", row.consecutive_failures);
  console.log("  circuit_breaker_until:", row.circuit_breaker_until || "(cerrado)");
  console.log("  health_status:", row.health_status);

  const lim = checkLimits(row);
  if (!lim.ok) {
    console.log("  ⚠ BLOQUEO por límite en BD:", lim.reason, "→ no se hará la llamada real hasta que baje el contador o subas daily_*_limit.");
    return { canCall: false, fromDb: true, row };
  }
  if (!row.enabled) {
    console.log("  ⚠ Proveedor deshabilitado en BD (enabled=false).");
    return { canCall: false, fromDb: true, row };
  }
  if (isCircuitOpen(row)) {
    console.log("  ⚠ Circuit breaker activo hasta", row.circuit_breaker_until);
    return { canCall: false, fromDb: true, row };
  }
  const key = resolveApiKey(row);
  console.log("  API key (resuelta):", key ? "sí" : "NO (ni BD ni env)");
  if (!key) return { canCall: false, fromDb: true, row };
  return { canCall: true, fromDb: true, row };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL no definida.");
    process.exit(1);
  }

  console.log("=== verify-ai-gateway-ping ===");
  console.log("Entorno: GROQ_API_KEY=", process.env.GROQ_API_KEY ? "definida" : "ausente");
  console.log("Entorno: GEMINI_API_KEY=", process.env.GEMINI_API_KEY ? "definida" : "ausente");

  const groqMeta = await describeProvider("GROQ_LLAMA");
  const gemMeta = await describeProvider("GEMINI_FLASH");

  console.log("\n── Prueba callChatBasic (Groq) ──");
  if (!groqMeta.canCall) {
    console.log("  Omitido: límites / circuit / sin clave / deshabilitado.");
  } else {
    try {
      const t0 = Date.now();
      const text = await callChatBasic({
        systemPrompt: "Respond only with the single word PING and nothing else.",
        userMessage: "test",
      });
      console.log("  ✓ OK en", Date.now() - t0, "ms →", JSON.stringify(String(text).trim().slice(0, 60)));
    } catch (e) {
      console.log("  ✗ Falló:", e.message || e);
      printPostMortem("groq", e);
    }
  }

  console.log("\n── Prueba callVision (Gemini, solo texto) ──");
  if (!gemMeta.canCall) {
    console.log("  Omitido: límites / circuit / sin clave / deshabilitado.");
  } else {
    try {
      const t0 = Date.now();
      const text = await callVision({
        parts: [{ text: "Reply with exactly one word: VISION_OK" }],
      });
      console.log("  ✓ OK en", Date.now() - t0, "ms →", JSON.stringify(String(text).trim().slice(0, 80)));
    } catch (e) {
      console.log("  ✗ Falló:", e.message || e);
      printPostMortem("gemini", e);
    }
  }

  console.log(
    "\n── Nota sobre límites ──\n" +
      "  • 429 de Groq/Gemini = cuota del proveedor (TPD, RPM, etc.), no es el contador de nuestra tabla provider_settings.\n" +
      "  • Si migrás provider_settings y ves limite_tokens_diario / limite_requests_diario, ahí sí ajustá daily_*_limit en BD o esperá al día siguiente."
  );
  await pool.end().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
