#!/usr/bin/env node
/**
 * Diagnóstico: por qué no llega la bienvenida CRM por Wasender.
 * Uso (desde la raíz del repo):
 *   npm run diagnose:crm-welcome
 *   npm run diagnose:crm-welcome -- 584242701513
 * Requiere DATABASE_URL (misma que Render si querés comparar con producción).
 */
"use strict";

require("../load-env-local");

const { normalizePhoneToE164 } = require("../ml-whatsapp-phone");

function crmWelcomeEnabledByCode() {
  const v = String(process.env.CRM_WA_WELCOME_ENABLED ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

function section(title) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

async function main() {
  const phoneArg = process.argv[2] ? String(process.argv[2]).replace(/\D/g, "") : null;

  section("1) Variables de entorno (este proceso)");
  console.log("CRM_WA_WELCOME_ENABLED =", JSON.stringify(process.env.CRM_WA_WELCOME_ENABLED ?? "(no definido)"));
  console.log("→ feature activa:", crmWelcomeEnabledByCode() ? "SÍ" : "NO");
  const waHub = process.env.WA_CRM_HUB_FROM_WASENDER;
  console.log("WA_CRM_HUB_FROM_WASENDER =", JSON.stringify(waHub ?? "(no definido → se trata como 1)"));
  if (String(waHub || "").trim() === "0") {
    console.log("  ⚠ El hub CRM NO recibe mensajes Wasender (valor 0). Quitá 0 o borrá la variable.");
  } else if (waHub != null && String(waHub).trim() !== "" && String(waHub).trim() !== "1") {
    console.log("  (Solo el valor \"0\" desactiva el reenvío al hub; otros textos como \"hola\" no lo apagan.)");
  }
  const apiKeyEnv = process.env.WASENDER_API_KEY && String(process.env.WASENDER_API_KEY).trim();
  console.log("WASENDER_ENABLED =", JSON.stringify(process.env.WASENDER_ENABLED ?? "(no definido)"));
  console.log("WASENDER_API_KEY length:", apiKeyEnv ? apiKeyEnv.length : 0, apiKeyEnv ? "" : "(vacío)");

  const dbUrl = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim();
  if (!dbUrl) {
    section("2) Base de datos");
    console.log("DATABASE_URL no definida: no se puede seguir (chats, log Wasender, ml_wasender_settings).");
    console.log("En Windows: definila en oauth-env.json o $env:DATABASE_URL antes de npm run.");
    section("Checklist si \"no envía nada\"");
    console.log("- En Render deben existir las mismas variables (CRM_WA_WELCOME_ENABLED, WASENDER_*, DATABASE_URL).");
    console.log("- El webhook de Wasender debe usar la URL HTTPS de tu instancia (p. ej. Render); no hace falta túnel ni escuchar en local.");
    console.log("- Ruta típica: …/wasender-webhook (la que configuraste en Wasender).");
    console.log("- Sin mensaje entrante guardado en crm_messages no se dispara trySendCrmWaWelcome.");
    console.log("\n--- Fin ---\n");
    process.exit(0);
  }

  const { resolveWasenderRuntimeConfig } = require("../ml-whatsapp-tipo-ef");
  const { pool } = require("../db");

  section("2) Wasender (runtime, con BD — igual que tipo E/F)");
  console.log(
    "Consultando la BD (ml_wasender_settings)… Si se queda aquí: red/firewall, SSL o DATABASE_URL incorrecta hacia el Postgres remoto."
  );

  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Timeout ${ms / 1000}s — la consulta a la BD no respondió (¿Postgres accesible desde esta PC?)`
              )
            ),
          ms
        )
      ),
    ]);

  let cfg;
  try {
    cfg = await withTimeout(resolveWasenderRuntimeConfig(), 30000);
  } catch (e) {
    console.log("ERROR:", e.message);
    process.exit(1);
  }
  console.log("Puede enviar (cfg.enabled):", cfg.enabled ? "SÍ" : "NO");
  if (!cfg.enabled) {
    console.log("  Revisar: WASENDER_API_KEY + (WASENDER_ENABLED=1 O ml_wasender_settings.is_enabled en BD).");
  }
  console.log("api_base_url:", cfg.apiBaseUrl);
  console.log("api_key length:", cfg.apiKey ? cfg.apiKey.length : 0);
  console.log("default_country:", cfg.defaultCountryCode);

  try {
    section("3) Migración CRM bienvenida");
    const { rows: col } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'crm_chats' AND column_name = 'wa_welcome_sent_at'`
    );
    console.log("Columna crm_chats.wa_welcome_sent_at:", col.length ? "SÍ" : "NO — ejecutar: npm run db:crm-wa-welcome");
    const { rows: colPend } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'crm_chats' AND column_name = 'wa_welcome_pending_name'`
    );
    console.log(
      "Columna crm_chats.wa_welcome_pending_name (saludo tras pedir nombre):",
      colPend.length ? "SÍ" : "NO — ejecutar: npm run db:crm-wa-welcome (misma migración)"
    );

    section("4) Últimos envíos registrados (ml_whatsapp_wasender_log, tipo_e_activation_source = crm_wa_welcome)");
    const { rows: logRows } = await pool.query(
      `SELECT id, created_at, outcome, phone_e164, text_preview, http_status, error_message
       FROM ml_whatsapp_wasender_log
       WHERE tipo_e_activation_source = 'crm_wa_welcome'
       ORDER BY id DESC
       LIMIT 5`
    );
    if (!logRows.length) {
      console.log("(ninguno en esta BD — el servidor nunca llegó a registrar un envío/ fallo de bienvenida CRM)");
    } else {
      for (const r of logRows) {
        console.log(
          `  id=${r.id} ${r.created_at} outcome=${r.outcome} phone=${r.phone_e164} http=${r.http_status ?? "—"}`
        );
        if (r.error_message) console.log("    error:", String(r.error_message).slice(0, 120));
      }
    }

    if (phoneArg) {
      section("5) Chats para el teléfono " + phoneArg);
      const { rows } = await pool.query(
        `SELECT c.id, c.phone, c.wa_welcome_sent_at, c.customer_id, cu.full_name
         FROM crm_chats c
         LEFT JOIN customers cu ON cu.id = c.customer_id
         WHERE REGEXP_REPLACE(c.phone, '\\D', '', 'g') = $1
         ORDER BY c.id DESC
         LIMIT 5`,
        [phoneArg]
      );
      if (!rows.length) {
        console.log(
          "(ningún crm_chats para ese número en ESTA base de datos — si la app corre en Render, la BD debe ser la de Render)"
        );
      } else {
        for (const r of rows) {
          console.log(
            `  chat_id=${r.id} wa_welcome_sent_at=${r.wa_welcome_sent_at || "(null → aún puede enviarse)"} full_name=${r.full_name ?? "—"}`
          );
        }
        if (rows[0].wa_welcome_sent_at) {
          console.log("\n  Si ya hay fecha en wa_welcome_sent_at, no se reenvía hasta que hagas:");
          console.log(`  UPDATE crm_chats SET wa_welcome_sent_at = NULL WHERE id = ${rows[0].id};`);
        }
      }
      const e164 = normalizePhoneToE164(phoneArg, cfg.defaultCountryCode);
      console.log("\nnormalizePhoneToE164 para Wasender:", e164 || "(null — revisar número)");
    }

    section("6) Si el env sigue OK pero no llega WhatsApp");
    console.log("- Confirmá que esta DATABASE_URL es la misma que usa el servidor que recibe webhooks (Render).");
    console.log("- En Render: Logs → buscar \"crm_welcome\" o \"trySendCrmWaWelcome\" o \"Wasender no OK\".");
    console.log("- Debe existir al menos un mensaje entrante procesado (crm_messages) tras un webhook real.");
  } catch (e) {
    console.error("Error BD:", e.message);
    process.exit(1);
  } finally {
    try {
      await pool.end();
    } catch (_e) {
      /* ignore */
    }
  }

  console.log("\n--- Fin ---\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
