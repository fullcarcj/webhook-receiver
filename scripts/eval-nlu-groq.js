#!/usr/bin/env node
"use strict";

/**
 * Eval NLU v2 (ADR-003) — vocabulario español, scoring granular, historial.
 *
 * Uso:
 *   npm run eval:nlu
 *   node scripts/eval-nlu-groq.js --dataset=scripts/eval/nlu-eval-set.template.json --limit=5
 *   node scripts/eval-nlu-groq.js --bucket=product_noisy --verbose
 *   node scripts/eval-nlu-groq.js --difficulty=hard
 *   node scripts/eval-nlu-groq.js --runs=3
 *   node scripts/eval-nlu-groq.js --model=llama-3.3-70b-versatile
 *   node scripts/eval-nlu-groq.js --dry-run
 *   node scripts/eval-nlu-groq.js --model=llama-3.1-8b-instant --delay-ms=10000
 *
 * Requiere (salvo --dry-run): DATABASE_URL, GROQ_API_KEY
 */

const fs = require("fs");
const path = require("path");

const VALID_INTENTS = new Set([
  "consulta_producto",
  "seguimiento_pedido",
  "pago_informado",
  "saludo",
  "queja",
  "despedida",
  "handoff_humano",
  "otro",
]);

const VALID_REPLY_HINTS = new Set([
  "cotizar_inmediato",
  "pedir_aclaracion",
  "derivar_humano",
  "saludar",
  "ninguna",
]);

const VALID_PART_CATEGORIES = new Set([
  "pastilla_freno",
  "disco_freno",
  "liquido_freno",
  "amortiguador",
  "resorte",
  "barra_estabilizadora",
  "filtro_aceite",
  "filtro_aire",
  "filtro_combustible",
  "aceite_motor",
  "bujia",
  "correa",
  "bateria",
  "neumatico",
  "rodamiento",
  "otro",
]);

const VALID_POSITIONS = new Set([
  "delantero",
  "trasero",
  "izquierdo",
  "derecho",
  "ambos",
  "no_aplica",
]);

const SYSTEM_PROMPT = `Eres un clasificador de mensajes entrantes para un sistema de ventas de autopartes en Venezuela. Tu única tarea es devolver JSON válido siguiendo el schema exacto que se describe.

REGLAS ESTRICTAS:
1. Respondes SOLO con JSON. No agregas texto antes ni después. No uses bloques de código markdown.
2. Si no puedes clasificar con certeza, baja la confidence y devuelve intent "otro". NO inventes datos.
3. Los clientes escriben con typos, sin tildes, con jerga venezolana ("epale", "pana", "chamo") y abreviaturas de WhatsApp ("xq", "x favor"). Normaliza mentalmente antes de clasificar.
4. Apodos de carro ("la vieja", "la nave", "mi carrito") sin marca, modelo o año explícitos en este mismo mensaje: deja vehicle en null y baja la confidence; no adivines marca/modelo solo por jerga o costumbre cultural.

SCHEMA DE RESPUESTA:
{
  "intent": uno de [consulta_producto | seguimiento_pedido | pago_informado | saludo | queja | despedida | handoff_humano | otro],
  "confidence": número entre 0 y 1,
  "vehicle": { "make": string, "model": string, "year": number } | null,
  "parts": [ { "category": string, "position": string | null } ],
  "reply_hint": uno de [cotizar_inmediato | pedir_aclaracion | derivar_humano | saludar | ninguna]
}

CATEGORÍAS DE PIEZAS VÁLIDAS:
pastilla_freno | disco_freno | liquido_freno | amortiguador | resorte | barra_estabilizadora | filtro_aceite | filtro_aire | filtro_combustible | aceite_motor | bujia | correa | bateria | neumatico | rodamiento | otro

POSITIONS VÁLIDAS:
delantero | trasero | izquierdo | derecho | ambos | no_aplica | null (cuando no se especifica)

CRITERIO DE CONFIDENCE:
- 0.95+ : el mensaje es explícito, sin ambigüedad, todos los datos están claros
- 0.80-0.95 : falta algún dato menor (año, posición) pero la intención es clara
- 0.60-0.80 : hay ambigüedad significativa, múltiples interpretaciones posibles
- < 0.60 : no estás seguro de la clasificación — prefiere intent "otro" con confidence baja antes que adivinar

EJEMPLOS:

Mensaje: "buenas tienen pastillas para corolla 2018?"
Respuesta: {"intent":"consulta_producto","confidence":0.95,"vehicle":{"make":"Toyota","model":"Corolla","year":2018},"parts":[{"category":"pastilla_freno","position":null}],"reply_hint":"cotizar_inmediato"}

Mensaje: "algo para el freno"
Respuesta: {"intent":"consulta_producto","confidence":0.55,"vehicle":null,"parts":[{"category":"otro","position":null}],"reply_hint":"pedir_aclaracion"}

Mensaje: "ya pagué"
Respuesta: {"intent":"pago_informado","confidence":0.85,"vehicle":null,"parts":[],"reply_hint":"ninguna"}

Mensaje: "👍"
Respuesta: {"intent":"otro","confidence":0.3,"vehicle":null,"parts":[],"reply_hint":"ninguna"}`;

/** ~4 caracteres por token en español; solo si la API no reporta uso (p. ej. callChatBasic). */
const CHARS_PER_TOKEN_EST = 4;

function estimateTokensWhenApiMissing(systemLen, userLen, responseText) {
  const tin = Math.ceil((systemLen + userLen) / CHARS_PER_TOKEN_EST);
  const tout = Math.ceil(String(responseText || "").length / CHARS_PER_TOKEN_EST);
  return { tin, tout };
}

function extractJson(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  try {
    return JSON.parse(s);
  } catch (_e) {
    /* fall through */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_e2) {
      /* fall through */
    }
  }
  const cleaned = s.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_e3) {
    return null;
  }
}

function validateResponse(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return ["not_an_object"];
  if (!VALID_INTENTS.has(obj.intent)) errors.push("invalid_intent");
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    errors.push("invalid_confidence");
  }
  if (!Array.isArray(obj.parts)) errors.push("parts_not_array");
  else {
    for (const p of obj.parts) {
      if (!p || typeof p !== "object") {
        errors.push("invalid_part_item");
        break;
      }
      if (!VALID_PART_CATEGORIES.has(p.category)) errors.push(`invalid_part_category:${p.category}`);
      if (p.position != null && p.position !== "" && !VALID_POSITIONS.has(p.position)) {
        errors.push(`invalid_position:${p.position}`);
      }
    }
  }
  if (obj.vehicle != null && typeof obj.vehicle === "object") {
    const v = obj.vehicle;
    if (v.year != null && typeof v.year !== "number") errors.push("vehicle_year_not_number");
  } else if (obj.vehicle !== null) {
    errors.push("vehicle_not_object_or_null");
  }
  if (!VALID_REPLY_HINTS.has(obj.reply_hint)) errors.push("invalid_reply_hint");
  return errors;
}

function normStr(x) {
  if (x == null) return "";
  return String(x).trim().toLowerCase();
}

function vehicleMatch(exp, pred) {
  if (exp == null && pred == null) return true;
  if (exp == null || pred == null) return false;
  const yE = exp.year != null ? Number(exp.year) : null;
  const yP = pred.year != null ? Number(pred.year) : null;
  if (yE != null && yP != null && yE !== yP) return false;
  if (normStr(exp.make) !== normStr(pred.make)) return false;
  if (normStr(exp.model) !== normStr(pred.model)) return false;
  return true;
}

function partsCategorySet(parts) {
  if (!Array.isArray(parts)) return new Set();
  return new Set(parts.map((p) => (p && p.category ? String(p.category) : "")).filter(Boolean));
}

function partsMatch(expected, predicted) {
  if (!expected || !predicted) return false;
  const e = partsCategorySet(expected);
  const p = partsCategorySet(predicted);
  if (e.size !== p.size) return false;
  for (const c of e) {
    if (!p.has(c)) return false;
  }
  return true;
}

function confidenceInBand(confidence, band) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return false;
  if (band === "alta") return c >= 0.85;
  if (band === "media") return c >= 0.6 && c < 0.85;
  if (band === "baja") return c < 0.6;
  return false;
}

function scoreCase(expectedBlock, predicted) {
  const exp = expectedBlock && expectedBlock.expected;
  if (!exp) {
    return {
      intent_match: null,
      vehicle_match: null,
      parts_match: null,
      confidence_band_match: null,
    };
  }
  const intent_match = predicted && predicted.intent === exp.intent;
  const vehicle_match = vehicleMatch(exp.vehicle, predicted ? predicted.vehicle : null);
  const parts_match = partsMatch(exp.parts || [], predicted && predicted.parts ? predicted.parts : []);
  const band = expectedBlock.expected_confidence_band;
  const confidence_band_match =
    band != null && predicted
      ? confidenceInBand(predicted.confidence, band)
      : null;
  return { intent_match, vehicle_match, parts_match, confidence_band_match };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    file: path.join(__dirname, "eval", "nlu-eval-set.template.json"),
    limit: null,
    dryRun: false,
    bucket: null,
    difficulty: null,
    runs: 1,
    model: null,
    verbose: false,
    delayMs: 0,
  };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a.startsWith("--file=")) out.file = a.slice("--file=".length);
    else if (a.startsWith("--dataset=")) out.file = a.slice("--dataset=".length);
    else if (a.startsWith("--bucket=")) out.bucket = a.slice("--bucket=".length) || null;
    else if (a.startsWith("--difficulty=")) out.difficulty = a.slice("--difficulty=".length) || null;
    else if (a.startsWith("--limit=")) out.limit = Math.max(1, parseInt(a.slice("--limit=".length), 10) || 0);
    else if (a.startsWith("--runs=")) out.runs = Math.max(1, parseInt(a.slice("--runs=".length), 10) || 1);
    else if (a.startsWith("--model=")) out.model = a.slice("--model=".length) || null;
    else if (a.startsWith("--delay-ms="))
      out.delayMs = Math.max(0, parseInt(a.slice("--delay-ms=".length), 10) || 0);
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function emptyBucketStats() {
  return {
    n: 0,
    intent_ok: 0,
    vehicle_ok: 0,
    vehicle_n: 0,
    parts_ok: 0,
    parts_n: 0,
    band_ok: 0,
    band_n: 0,
  };
}

function emptyDifficultyStats() {
  return { n: 0, intent_ok: 0 };
}

function recordBucket(bMap, bucket, scores, exp) {
  if (!bMap[bucket]) bMap[bucket] = emptyBucketStats();
  const b = bMap[bucket];
  b.n += 1;
  if (scores.intent_match) b.intent_ok += 1;
  if (exp && exp.expected && exp.expected.vehicle != null) {
    b.vehicle_n += 1;
    if (scores.vehicle_match) b.vehicle_ok += 1;
  }
  if (exp && exp.expected && Array.isArray(exp.expected.parts) && exp.expected.parts.length > 0) {
    b.parts_n += 1;
    if (scores.parts_match) b.parts_ok += 1;
  }
  if (exp && exp.expected_confidence_band) {
    b.band_n += 1;
    if (scores.confidence_band_match) b.band_ok += 1;
  }
}

function finalizeBuckets(bMap) {
  const out = {};
  for (const k of Object.keys(bMap)) {
    const b = bMap[k];
    out[k] = {
      n: b.n,
      intent_acc: b.n ? Number(((b.intent_ok / b.n) * 100).toFixed(2)) : null,
      vehicle_acc: b.vehicle_n ? Number(((b.vehicle_ok / b.vehicle_n) * 100).toFixed(2)) : null,
      parts_acc: b.parts_n ? Number(((b.parts_ok / b.parts_n) * 100).toFixed(2)) : null,
      confidence_band_acc: b.band_n ? Number(((b.band_ok / b.band_n) * 100).toFixed(2)) : null,
    };
  }
  return out;
}

async function runOnePass(opts, items, callLlm) {
  const results = [];
  const latencies = [];
  let jsonFail = 0;
  let validationFail = 0;
  let intentOk = 0;
  let intentN = 0;
  let vehicleOk = 0;
  let vehicleN = 0;
  let partsOk = 0;
  let partsN = 0;
  let bandOk = 0;
  let bandN = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokenHeuristicCases = 0;
  let tokenApiCases = 0;

  const bMap = {};
  const diffMap = {
    easy: emptyDifficultyStats(),
    medium: emptyDifficultyStats(),
    hard: emptyDifficultyStats(),
  };
  const failures = [];
  let caseIndex = 0;

  for (const msg of items) {
    const text = String(msg.text || "").trim();
    if (!text) continue;

    if (caseIndex > 0 && opts.delayMs > 0) await delay(opts.delayMs);
    caseIndex += 1;

    const t0 = Date.now();
    let rawOut = "";
    let parsed = null;
    let jsonErr = null;
    let valErrors = [];

    try {
      const r = await callLlm(text);
      rawOut = r.content;
      let tin = r.tokensIn || 0;
      let tout = r.tokensOut || 0;
      if (tin === 0 && tout === 0) {
        const est = estimateTokensWhenApiMissing(
          SYSTEM_PROMPT.length,
          text.length,
          rawOut
        );
        tin = est.tin;
        tout = est.tout;
        tokenHeuristicCases += 1;
      } else {
        tokenApiCases += 1;
      }
      tokensIn += tin;
      tokensOut += tout;
      parsed = extractJson(rawOut);
      if (!parsed) {
        jsonFail += 1;
        jsonErr = "parse_null";
      } else {
        valErrors = validateResponse(parsed);
        if (valErrors.length) validationFail += 1;
      }
    } catch (e) {
      jsonFail += 1;
      jsonErr = e.message || String(e);
      const est = estimateTokensWhenApiMissing(
        SYSTEM_PROMPT.length,
        text.length,
        rawOut
      );
      tokensIn += est.tin;
      tokensOut += est.tout;
      tokenHeuristicCases += 1;
    }
    const ms = Date.now() - t0;
    latencies.push(ms);

    const scores =
      parsed && valErrors.length === 0
        ? scoreCase(msg, parsed)
        : {
            intent_match: false,
            vehicle_match: false,
            parts_match: false,
            confidence_band_match: false,
          };

    if (msg.expected && msg.expected.intent != null) {
      intentN += 1;
      if (scores.intent_match) intentOk += 1;
    }
    if (msg.expected && msg.expected.vehicle != null) {
      vehicleN += 1;
      if (scores.vehicle_match) vehicleOk += 1;
    }
    if (msg.expected && Array.isArray(msg.expected.parts) && msg.expected.parts.length > 0) {
      partsN += 1;
      if (scores.parts_match) partsOk += 1;
    }
    if (msg.expected_confidence_band) {
      bandN += 1;
      if (scores.confidence_band_match) bandOk += 1;
    }

    recordBucket(bMap, msg.bucket, scores, msg);
    const d = msg.difficulty || "medium";
    if (diffMap[d]) {
      const dm = diffMap[d];
      dm.n += 1;
      if (scores.intent_match && msg.expected && msg.expected.intent) dm.intent_ok += 1;
    }

    if (!scores.intent_match && msg.expected && msg.expected.intent) {
      failures.push({
        id: msg.id,
        bucket: msg.bucket,
        text: text.slice(0, 200),
        expected_intent: msg.expected.intent,
        predicted_intent: parsed && parsed.intent,
        reason: jsonErr || valErrors.join(",") || "intent_mismatch",
      });
    }

    results.push({
      id: msg.id,
      bucket: msg.bucket,
      ms,
      json_fail: !!jsonErr || !parsed,
      validation_errors: valErrors,
      predicted: parsed,
      scores,
    });

    if (opts.verbose) {
      const fl = jsonErr || valErrors.join(",") || "";
      console.log(
        `${msg.id} ${ms}ms intent=${parsed ? parsed.intent : "?"} ${fl ? `(${fl})` : ""}`
      );
    }
  }

  latencies.sort((a, b) => a - b);
  const totalCases = items.filter((m) => String(m.text || "").trim()).length;

  return {
    results,
    summary: {
      total_cases: totalCases,
      json_fail: jsonFail,
      validation_fail: validationFail,
      intent_accuracy:
        intentN > 0 ? Number(((intentOk / intentN) * 100).toFixed(4)) : null,
      vehicle_accuracy:
        vehicleN > 0 ? Number(((vehicleOk / vehicleN) * 100).toFixed(4)) : null,
      parts_accuracy: partsN > 0 ? Number(((partsOk / partsN) * 100).toFixed(4)) : null,
      confidence_band_accuracy:
        bandN > 0 ? Number(((bandOk / bandN) * 100).toFixed(4)) : null,
      json_fail_rate: totalCases ? Number(((jsonFail / totalCases) * 100).toFixed(4)) : null,
      validation_fail_rate: totalCases ? Number(((validationFail / totalCases) * 100).toFixed(4)) : null,
      latency_ms: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies.length ? latencies[latencies.length - 1] : null,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      token_cost_basis:
        tokenHeuristicCases > 0 && tokenApiCases === 0
          ? "heuristic_4chars_per_token"
          : tokenApiCases > 0 && tokenHeuristicCases === 0
            ? "groq_usage_api"
            : "mixed",
      token_heuristic_cases: tokenHeuristicCases,
      total_cost_usd_estimated: Number(
        ((tokensIn * 0.05 + tokensOut * 0.08) / 1_000_000).toFixed(6)
      ),
      cost_usd_per_1000_messages_estimated:
        totalCases > 0
          ? Number(
              (
                (((tokensIn * 0.05 + tokensOut * 0.08) / 1_000_000) * 1000) /
                totalCases
              ).toFixed(8)
            )
          : null,
    },
    by_bucket: finalizeBuckets(bMap),
    by_difficulty: {
      easy: {
        n: diffMap.easy.n,
        intent_acc:
          diffMap.easy.n > 0
            ? Number(((diffMap.easy.intent_ok / diffMap.easy.n) * 100).toFixed(2))
            : null,
      },
      medium: {
        n: diffMap.medium.n,
        intent_acc:
          diffMap.medium.n > 0
            ? Number(((diffMap.medium.intent_ok / diffMap.medium.n) * 100).toFixed(2))
            : null,
      },
      hard: {
        n: diffMap.hard.n,
        intent_acc:
          diffMap.hard.n > 0
            ? Number(((diffMap.hard.intent_ok / diffMap.hard.n) * 100).toFixed(2))
            : null,
      },
    },
    failures: failures.slice(0, 40),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const abs = path.isAbsolute(opts.file) ? opts.file : path.join(process.cwd(), opts.file);

  if (!fs.existsSync(abs)) {
    console.error("❌ No existe el dataset:", abs);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  let items = raw.messages || raw;
  if (opts.bucket) items = items.filter((m) => m.bucket === opts.bucket);
  if (opts.difficulty) items = items.filter((m) => m.difficulty === opts.difficulty);
  if (opts.limit) items = items.slice(0, opts.limit);

  if (opts.dryRun) {
    console.log("Dry run —", items.length, "casos (sin DB/GROQ)");
    items.forEach((m) =>
      console.log(`  ${m.id} [${m.bucket}/${m.difficulty}] ${String(m.text).slice(0, 70)}…`)
    );
    return;
  }

  require("../load-env-local");
  if (!process.env.GROQ_API_KEY) {
    console.error("❌ GROQ_API_KEY no definida.");
    process.exit(1);
  }

  const { callChatBasic, legacyGroqChat } = require("../src/services/aiGateway");

  async function callLlm(userMessage) {
    if (opts.model) {
      const apiKey = process.env.GROQ_API_KEY;
      return legacyGroqChat({
        apiKey,
        systemPrompt: SYSTEM_PROMPT,
        userMessage,
        model: opts.model,
      });
    }
    const content = await callChatBasic({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
    });
    return { content, tokensIn: 0, tokensOut: 0 };
  }

  const runSummaries = [];
  for (let r = 0; r < opts.runs; r += 1) {
    if (opts.runs > 1) console.log(`\n--- Pasada ${r + 1}/${opts.runs} ---\n`);
    const pass = await runOnePass(opts, items, callLlm);
    runSummaries.push(pass);
    if (opts.runs > 1 && pass.summary.intent_accuracy != null) {
      console.log(`Intent accuracy (pasada ${r + 1}): ${pass.summary.intent_accuracy}%`);
    }
  }

  const intentAccs = runSummaries.map((p) => p.summary.intent_accuracy).filter((x) => x != null);
  const stability = {
    intent_accuracy_mean: intentAccs.length ? mean(intentAccs) : null,
    intent_accuracy_stdev_pp: intentAccs.length > 1 ? stdev(intentAccs) : 0,
    runs: opts.runs,
  };

  const last =
    runSummaries[runSummaries.length - 1] ||
    runSummaries[0];

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(__dirname, "eval", "out");
  fs.mkdirSync(outDir, { recursive: true });

  const consolidated = {
    meta: {
      timestamp: new Date().toISOString(),
      model: opts.model || "provider_default",
      provider: "groq",
      dataset: abs,
      delay_ms_between_cases: opts.delayMs || 0,
      total_cases: last.summary.total_cases,
      runs_per_case_pass: opts.runs,
      stability,
      token_cost_note:
        last.summary.token_cost_basis === "groq_usage_api"
          ? "Tokens desde uso reportado por la API (p. ej. legacyGroqChat)."
          : "Si la API no reporta tokens (p. ej. callChatBasic), entrada ≈ (len(system)+len(user))/4 y salida ≈ len(respuesta)/4 — aproximación, no medición exacta.",
    },
    summary: last.summary,
    by_bucket: last.by_bucket,
    by_difficulty: last.by_difficulty,
    failures: last.failures,
    multi_run: opts.runs > 1 ? runSummaries.map((p, i) => ({ pass: i + 1, summary: p.summary })) : null,
  };

  const lastPath = path.join(outDir, "nlu-eval-last.json");
  fs.writeFileSync(lastPath, JSON.stringify(consolidated, null, 2), "utf8");
  const stampPath = path.join(outDir, `nlu-eval-${ts}.json`);
  fs.writeFileSync(stampPath, JSON.stringify(consolidated, null, 2), "utf8");

  const histLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    model: consolidated.meta.model,
    cases: last.summary.total_cases,
    intent_accuracy: last.summary.intent_accuracy,
    p50_ms: last.summary.latency_ms.p50,
    p95_ms: last.summary.latency_ms.p95,
    json_fail_rate: last.summary.json_fail_rate,
    stability_stdev_pp: stability.intent_accuracy_stdev_pp,
  });
  fs.appendFileSync(path.join(outDir, "history.ndjson"), histLine + "\n", "utf8");

  console.log("\nResumen (última pasada):");
  console.log(JSON.stringify(last.summary, null, 2));
  console.log("\nEstabilidad (entre pasadas):", JSON.stringify(stability, null, 2));
  console.log("\nEscrito:", lastPath, "y", stampPath);
  console.log("Historial append:", path.join(outDir, "history.ndjson"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
