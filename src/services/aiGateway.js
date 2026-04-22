"use strict";

const pino = require("pino");
const { pool } = require("../../db");
const { decryptApiKey } = require("./cryptoService");

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "ai_gateway" });

const ENV_KEY_BY_PROVIDER = {
  GEMINI_FLASH: "GEMINI_API_KEY",
  GROQ_WHISPER: "GROQ_API_KEY",
  GROQ_LLAMA: "GROQ_API_KEY",
  OPENAI_GPT4: "OPENAI_API_KEY",
};

/** Modelo chat Groq: fila `provider_settings.model_name` gana; si no, `GROQ_CHAT_MODEL`; si no, 70B. */
function resolveGroqChatModel(modelFromCallerOrRow) {
  const row = modelFromCallerOrRow != null && String(modelFromCallerOrRow).trim() !== "" ? String(modelFromCallerOrRow).trim() : "";
  if (row) return row;
  const env = String(process.env.GROQ_CHAT_MODEL || "").trim();
  return env || "llama-3.3-70b-versatile";
}

/**
 * @param {import("pg").PoolClient|import("pg").Pool} client
 * @param {string} providerId
 */
async function getProvider(client, providerId) {
  const r = await client.query(`SELECT * FROM provider_settings WHERE provider_id = $1`, [providerId]);
  return r.rows[0] || null;
}

function resolveApiKey(provider) {
  if (!provider) return null;
  if (provider.api_key_encrypted) {
    try {
      return decryptApiKey(provider.api_key_encrypted);
    } catch (e) {
      log.warn({ err: e.message, provider_id: provider.provider_id }, "decrypt_api_key_failed");
      return null;
    }
  }
  const envName = ENV_KEY_BY_PROVIDER[provider.provider_id];
  return envName ? process.env[envName] : null;
}

function isCircuitOpen(provider) {
  if (!provider?.circuit_breaker_until) return false;
  return new Date(provider.circuit_breaker_until).getTime() > Date.now();
}

function checkLimits(provider) {
  if (!provider) return { ok: false, reason: "sin_proveedor" };
  if (provider.current_daily_requests >= provider.daily_request_limit) {
    return { ok: false, reason: "limite_requests_diario" };
  }
  if (provider.current_daily_usage >= provider.daily_token_limit) {
    return { ok: false, reason: "limite_tokens_diario" };
  }
  return { ok: true };
}

/**
 * @param {import("pg").PoolClient|import("pg").Pool} client
 */
async function trackUsage(client, params) {
  const {
    providerId,
    tokensIn = 0,
    tokensOut = 0,
    success,
    errorMessage = null,
    latencyMs = null,
    functionCalled,
  } = params;
  const tokenDelta = Math.max(0, (Number(tokensIn) || 0) + (Number(tokensOut) || 0));

  await client.query(
    `INSERT INTO ai_usage_log (provider_id, function_called, tokens_input, tokens_output, latency_ms, success, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      providerId,
      functionCalled,
      tokensIn || null,
      tokensOut || null,
      latencyMs,
      success,
      errorMessage ? String(errorMessage).slice(0, 2000) : null,
    ]
  );

  await client.query(
    `UPDATE provider_settings AS p SET
       current_daily_usage = p.current_daily_usage + $2::int,
       current_daily_requests = p.current_daily_requests + 1,
       consecutive_failures = CASE WHEN $3 THEN 0 ELSE p.consecutive_failures + 1 END,
       error_count_today = p.error_count_today + CASE WHEN $3 THEN 0 ELSE 1 END,
       circuit_breaker_until = CASE
         WHEN $3 THEN NULL
         WHEN NOT $3 AND (p.consecutive_failures + 1) >= p.circuit_breaker_threshold THEN NOW() + INTERVAL '1 hour'
         ELSE p.circuit_breaker_until
       END,
       last_success_at = CASE WHEN $3 THEN NOW() ELSE p.last_success_at END,
       last_error = CASE WHEN $3 THEN NULL ELSE LEFT(COALESCE($4::text, 'error'), 500) END,
       health_status = CASE WHEN $3 THEN 'healthy' ELSE 'degraded' END
     WHERE p.provider_id = $1`,
    [providerId, tokenDelta, success, errorMessage]
  );
}

function isUndefinedTable(err) {
  return err && (err.code === "42P01" || /relation .* does not exist/i.test(String(err.message || "")));
}

async function legacyGeminiVision({ apiKey, mimeType, parts, model }) {
  const m = model || "gemini-2.0-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: { temperature: 0, maxOutputTokens: 300 },
        contents: [{ role: "user", parts }],
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`Gemini [${response.status}]: ${await response.text()}`);
  }
  const result = await response.json();
  const content = result?.candidates?.[0]?.content?.parts
    ?.map((p) => p?.text || "")
    .join("\n")
    .trim();
  if (!content) throw new Error("Gemini sin contenido en respuesta");
  return { content, usage: result?.usageMetadata || null };
}

/**
 * @param {{ parts: object[], mimeType?: string, providerId?: string }} opts
 * @returns {Promise<string>} texto de respuesta del modelo
 */
async function callVision(opts) {
  const providerId = opts.providerId || "GEMINI_FLASH";
  const parts = opts.parts;
  if (!parts || !Array.isArray(parts)) {
    throw new Error("callVision: parts requerido");
  }

  let provider;
  try {
    provider = await getProvider(pool, providerId);
  } catch (e) {
    if (isUndefinedTable(e)) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw e;
      const { content } = await legacyGeminiVision({ apiKey, parts, model: "gemini-2.0-flash" });
      return content;
    }
    throw e;
  }

  if (!provider) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_FLASH no configurado en BD ni GEMINI_API_KEY");
    const { content } = await legacyGeminiVision({ apiKey, parts, model: "gemini-2.0-flash" });
    return content;
  }

  if (!provider.enabled) {
    throw new Error(`proveedor ${providerId} deshabilitado`);
  }

  if (isCircuitOpen(provider)) {
    throw new Error("circuit_breaker_activo");
  }

  const lim = checkLimits(provider);
  if (!lim.ok) {
    throw new Error(lim.reason || "limite_excedido");
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error("sin_api_key (BD o entorno)");
  }

  const t0 = Date.now();
  let success = false;
  let errMsg = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let content = "";

  try {
    const { content: c, usage } = await legacyGeminiVision({
      apiKey,
      parts,
      model: provider.model_name || "gemini-2.0-flash",
    });
    content = c;
    tokensIn = usage?.promptTokenCount || Math.min(500000, Math.ceil(JSON.stringify(parts).length / 4));
    tokensOut = usage?.candidatesTokenCount || Math.ceil((content || "").length / 4);
    success = true;
    return content;
  } catch (e) {
    errMsg = e.message || String(e);
    throw e;
  } finally {
    const latencyMs = Date.now() - t0;
    try {
      await trackUsage(pool, {
        providerId,
        tokensIn,
        tokensOut,
        success,
        errorMessage: success ? null : errMsg,
        latencyMs,
        functionCalled: "callVision",
      });
    } catch (logErr) {
      log.warn({ err: logErr.message }, "trackUsage vision falló (no bloquea)");
    }
  }
}

async function legacyGroqTranscribe({ apiKey, buffer, mimetype, model }) {
  const ext = mimetype.includes("ogg")
    ? "ogg"
    : mimetype.includes("mp4")
      ? "mp4"
      : mimetype.includes("webm")
        ? "webm"
        : mimetype.includes("mpeg")
          ? "mp3"
          : mimetype.includes("wav")
            ? "wav"
            : "ogg";

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimetype });
  formData.append("file", blob, `media.${ext}`);
  formData.append("model", model || "whisper-large-v3");
  formData.append("language", "es");
  formData.append("response_format", "json");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  const text = String(data?.text || "").trim();
  if (!text) throw new Error("Groq devolvió texto vacío");
  return text;
}

/**
 * @param {{ buffer: Buffer, mimetype: string, messageId?: string }} opts
 * @returns {Promise<string>}
 */
async function callAudio(opts) {
  const { buffer, mimetype } = opts;
  const providerId = "GROQ_WHISPER";

  let provider;
  try {
    provider = await getProvider(pool, providerId);
  } catch (e) {
    if (isUndefinedTable(e)) {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw e;
      return legacyGroqTranscribe({ apiKey, buffer, mimetype, model: "whisper-large-v3" });
    }
    throw e;
  }

  if (!provider) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_WHISPER no configurado en BD ni GROQ_API_KEY");
    return legacyGroqTranscribe({ apiKey, buffer, mimetype, model: "whisper-large-v3" });
  }

  if (!provider.enabled) {
    throw new Error("proveedor GROQ_WHISPER deshabilitado");
  }

  if (isCircuitOpen(provider)) {
    throw new Error("circuit_breaker_activo");
  }

  const lim = checkLimits(provider);
  if (!lim.ok) {
    throw new Error(lim.reason || "limite_excedido");
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error("sin_api_key (BD o entorno)");
  }

  const t0 = Date.now();
  let success = false;
  let errMsg = null;
  let text = "";
  const estTokens = Math.min(100000, Math.ceil(buffer.length / 32));

  try {
    text = await legacyGroqTranscribe({
      apiKey,
      buffer,
      mimetype,
      model: provider.model_name || "whisper-large-v3",
    });
    success = true;
    return text;
  } catch (e) {
    errMsg = e.message || String(e);
    throw e;
  } finally {
    const latencyMs = Date.now() - t0;
    try {
      await trackUsage(pool, {
        providerId,
        tokensIn: estTokens,
        tokensOut: Math.ceil((text || "").length / 4),
        success,
        errorMessage: success ? null : errMsg,
        latencyMs,
        functionCalled: "callAudio",
      });
    } catch (logErr) {
      log.warn({ err: logErr.message }, "trackUsage audio falló (no bloquea)");
    }
  }
}

async function legacyGroqChat({ apiKey, systemPrompt, userMessage, model }) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: resolveGroqChatModel(model),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0,
      max_tokens: 150,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq chat HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq chat sin contenido");
  return {
    content,
    tokensIn: data?.usage?.prompt_tokens || 0,
    tokensOut: data?.usage?.completion_tokens || 0,
  };
}

/**
 * Post-proceso opcional del texto del modelo (p. ej. JSON) antes de marcar éxito en `ai_usage_log`.
 * Si `ok` es false, la llamada cuenta como fallo en uso y se relanza Error.
 * @typedef {{ ok: boolean, auditMessage?: string|null, error?: string }} ChatBasicPostProcessResult
 */

/**
 * @param {{
 *   systemPrompt: string;
 *   userMessage: string;
 *   usageFunctionCalled?: string;
 *   responsePostProcessor?: (content: string) => ChatBasicPostProcessResult;
 * }} opts
 * @returns {Promise<string>} respuesta en texto del modelo
 */
async function callChatBasic(opts) {
  const { systemPrompt, userMessage, usageFunctionCalled = "callChatBasic", responsePostProcessor } = opts;
  const providerId = "GROQ_LLAMA";

  let provider;
  try {
    provider = await getProvider(pool, providerId);
  } catch (e) {
    if (isUndefinedTable(e)) {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw e;
      const { content } = await legacyGroqChat({ apiKey, systemPrompt, userMessage });
      if (responsePostProcessor) {
        const p = responsePostProcessor(content);
        if (!p.ok) throw new Error(p.error || "response_post_process_failed");
      }
      return content;
    }
    throw e;
  }

  if (!provider) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_LLAMA no configurado en BD ni GROQ_API_KEY");
    const { content } = await legacyGroqChat({ apiKey, systemPrompt, userMessage });
    if (responsePostProcessor) {
      const p = responsePostProcessor(content);
      if (!p.ok) throw new Error(p.error || "response_post_process_failed");
    }
    return content;
  }

  if (!provider.enabled) throw new Error("proveedor GROQ_LLAMA deshabilitado");
  if (isCircuitOpen(provider)) throw new Error("circuit_breaker_activo");
  const lim = checkLimits(provider);
  if (!lim.ok) throw new Error(lim.reason || "limite_excedido");

  const apiKey = resolveApiKey(provider);
  if (!apiKey) throw new Error("sin_api_key (BD o entorno)");

  const t0 = Date.now();
  let success = false;
  let errMsg = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let content = "";
  /** Detalle de auditoría en `ai_usage_log.error_message` cuando success=true (p. ej. validación nombre WA). */
  let successAuditDetail = null;

  try {
    const r = await legacyGroqChat({
      apiKey,
      systemPrompt,
      userMessage,
      model: resolveGroqChatModel(provider.model_name),
    });
    content = r.content;
    tokensIn = r.tokensIn;
    tokensOut = r.tokensOut;
    if (responsePostProcessor) {
      const p = responsePostProcessor(content);
      if (!p.ok) {
        errMsg = p.error || "response_post_process_failed";
        throw new Error(errMsg);
      }
      successAuditDetail = p.auditMessage != null && String(p.auditMessage).trim() !== "" ? String(p.auditMessage) : null;
    }
    success = true;
    return content;
  } catch (e) {
    errMsg = e.message || String(e);
    throw e;
  } finally {
    try {
      await trackUsage(pool, {
        providerId,
        tokensIn,
        tokensOut,
        success,
        errorMessage: success ? successAuditDetail : errMsg,
        latencyMs: Date.now() - t0,
        functionCalled: usageFunctionCalled,
      });
    } catch (logErr) {
      log.warn({ err: logErr.message }, "trackUsage callChatBasic falló (no bloquea)");
    }
  }
}

async function callChatAdvanced() {
  throw new Error("callChatAdvanced no implementado");
}

module.exports = {
  getProvider,
  resolveApiKey,
  isCircuitOpen,
  checkLimits,
  trackUsage,
  callVision,
  callAudio,
  callChatBasic,
  callChatAdvanced,
  legacyGroqChat,
  ENV_KEY_BY_PROVIDER,
};
