"use strict";

/**
 * Extractor de datos de comprobantes bancarios venezolanos vía Gemini Vision.
 * Usa el AI Gateway (Gemini vía `provider_settings` o `GEMINI_API_KEY`).
 */

const pino = require("pino");
const log = pino({ level: process.env.LOG_LEVEL || "info", name: "receipt_extractor" });

const SYSTEM_PROMPT = `Eres un extractor de datos de comprobantes bancarios venezolanos.
Extrae EXACTAMENTE estos campos:
- reference_number: número de referencia/operación/recibo (solo dígitos)
- amount_bs: monto en bolívares como decimal con PUNTO (no coma)
  IMPORTANTE Venezuela usa punto=miles coma=decimales: "5.007,80" → 5007.80
- tx_date: fecha ISO YYYY-MM-DD
- bank_name: banco emisor
- payment_type: "PAGO_MOVIL" o "TRANSFERENCIA"
- confidence: 0.00 a 1.00

Responde SOLO con JSON válido sin texto adicional:
{"reference_number":"000011941","amount_bs":5007.80,"tx_date":"2026-03-20","bank_name":"BBVA Provincial","payment_type":"PAGO_MOVIL","confidence":0.97}
Si no puedes extraer un campo usa null.`;

/**
 * @typedef {{
 *   status: string;
 *   data: object | null;
 *   error_message: string | null;
 *   raw_model_snippet: string | null;
 * }} ReceiptExtractionResult
 */

/**
 * Convierte montos venezolanos a float.
 * "5.007,80" → 5007.80 | "BS 586,08" → 586.08 | "Bs. 325,00" → 325.00
 */
function normalizeVenezuelanAmount(raw) {
  if (raw == null) return null;
  const str = String(raw).replace(/[Bb][Ss]\.?\s*/g, "").trim();
  if (str.includes(".") && str.includes(",")) {
    return parseFloat(str.replace(/\./g, "").replace(",", "."));
  }
  if (str.includes(",") && !str.includes(".")) {
    return parseFloat(str.replace(",", "."));
  }
  return parseFloat(str.replace(/[^0-9.]/g, ""));
}

function _firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s !== "") return v;
  }
  return null;
}

/**
 * Gemini a menudo devuelve claves en español o anidadas; unificamos al contrato en inglés.
 */
function _canonicalizeReceiptParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const p = { ...parsed };
  for (const nestKey of ["extraction", "datos", "data", "comprobante", "resultado"]) {
    const inner = p[nestKey];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      Object.assign(p, inner);
    }
  }

  const refRaw = _firstNonEmpty(
    p.reference_number,
    p.numero_referencia,
    p.numero_de_referencia,
    p.número_de_referencia,
    p.referencia,
    p.ref,
    p.numero_operacion,
    p.número_operación
  );
  if (refRaw != null) {
    const digits = String(refRaw).replace(/\D/g, "");
    p.reference_number = digits.length >= 6 ? digits : String(refRaw).trim();
  }

  const amtRaw = _firstNonEmpty(p.amount_bs, p.monto, p.monto_bs, p.importe, p.monto_bolivares, p.monto_operacion);
  if (amtRaw != null) p.amount_bs = amtRaw;

  const dateRaw = _firstNonEmpty(p.tx_date, p.fecha, p.fecha_operacion, p.fecha_tx, p.fecha_de_operacion);
  if (dateRaw != null) p.tx_date = _parseReceiptDateToIso(String(dateRaw).trim()) || String(dateRaw).trim();

  const bankRaw = _firstNonEmpty(
    p.bank_name,
    p.banco,
    p.banco_emisor,
    p.banco_receptor,
    p.banco_emisor_nombre,
    p.banco_receptor_nombre
  );
  if (bankRaw != null) p.bank_name = String(bankRaw).trim();

  const ptRaw = _firstNonEmpty(p.payment_type, p.tipo_pago, p.tipo);
  if (ptRaw != null) p.payment_type = String(ptRaw).trim();

  if (p.confidence == null && p.confianza != null) p.confidence = p.confianza;

  return p;
}

/** DD/MM/YYYY[ hora] o ISO YYYY-MM-DD → ISO fecha (solo fecha). */
function _parseReceiptDateToIso(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ve = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (ve) {
    const dd = ve[1].padStart(2, "0");
    const mm = ve[2].padStart(2, "0");
    return `${ve[3]}-${mm}-${dd}`;
  }
  return null;
}

function _hasExtractedCore(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const ref = parsed.reference_number;
  if (ref != null && String(ref).trim() !== "") return true;
  if (parsed.amount_bs != null) {
    const n = Number(parsed.amount_bs);
    if (!Number.isNaN(n)) return true;
    const nv = normalizeVenezuelanAmount(String(parsed.amount_bs));
    if (nv != null && !Number.isNaN(nv)) return true;
  }
  const d = parsed.tx_date;
  if (d != null && String(d).trim() !== "") return true;
  const b = parsed.bank_name;
  if (b != null && String(b).trim() !== "") return true;
  return false;
}

function _snippet(s, max) {
  const t = String(s ?? "");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * @param {ReceiptExtractionResult} ex
 * @returns {{ extraction_status: string, extraction_error: string|null, extraction_raw_snippet: string|null,
 *   extracted_reference: *, extracted_amount_bs: *, extracted_date: *, extracted_bank: *, extracted_payment_type: *, extraction_confidence: * }}
 */
function paymentAttemptFieldsFromExtraction(ex) {
  const d = ex.data && typeof ex.data === "object" ? ex.data : {};
  let amountBs = d.amount_bs != null ? normalizeVenezuelanAmount(String(d.amount_bs)) : null;
  if (amountBs != null && Number.isNaN(Number(amountBs))) amountBs = null;
  let conf = d.confidence;
  if (conf != null) {
    const c = Number(conf);
    conf = Number.isFinite(c) ? c : null;
  }
  return {
    extraction_status: ex.status,
    extraction_error: ex.error_message,
    extraction_raw_snippet: ex.raw_model_snippet,
    extracted_reference: d.reference_number ?? null,
    extracted_amount_bs: amountBs,
    extracted_date: d.tx_date ?? null,
    extracted_bank: d.bank_name ?? null,
    extracted_payment_type: d.payment_type ?? null,
    extraction_confidence: conf,
  };
}

/**
 * @param {string} firebaseUrl — URL pública de Firebase Storage (imagen)
 * @returns {Promise<ReceiptExtractionResult>}
 */
async function extractReceiptData(firebaseUrl) {
  const fail = (status, error_message, raw_model_snippet = null) => ({
    status,
    data: null,
    error_message: error_message ? String(error_message).slice(0, 2000) : null,
    raw_model_snippet: raw_model_snippet != null ? _snippet(raw_model_snippet, 1200) : null,
  });

  try {
    const imgRes = await fetch(firebaseUrl);
    if (!imgRes.ok) {
      return fail("download_failed", `No se pudo descargar imagen para Gemini [HTTP ${imgRes.status}]`);
    }
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const arr = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arr).toString("base64");

    const { callVision } = require("../../services/aiGateway");
    let content;
    try {
      content = await callVision({
        parts: [
          { text: SYSTEM_PROMPT },
          { text: "Extrae los datos de este comprobante bancario venezolano y responde SOLO JSON válido." },
          {
            inlineData: {
              mimeType,
              data: base64,
            },
          },
        ],
      });
    } catch (ve) {
      const msg = ve && ve.message ? String(ve.message) : String(ve);
      log.error({ err: msg }, "receipt_extractor: error API Gemini Vision");
      return fail("vision_error", msg);
    }

    if (content == null || !String(content).trim()) {
      return fail("empty_response", "Gemini devolvió contenido vacío");
    }

    const rawStr = String(content);
    let jsonText = rawStr;
    const m = rawStr.match(/```json\s*([\s\S]*?)```/i) || rawStr.match(/```\s*([\s\S]*?)```/i);
    if (m && m[1]) jsonText = m[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (pe) {
      log.error({ err: pe.message }, "receipt_extractor: JSON inválido en respuesta del modelo");
      return fail("json_parse", pe.message, rawStr);
    }

    if (!parsed || typeof parsed !== "object") {
      return fail("invalid_shape", "La respuesta JSON no es un objeto", rawStr);
    }

    parsed = _canonicalizeReceiptParsed(parsed);

    if (parsed.amount_bs != null) {
      const n = normalizeVenezuelanAmount(String(parsed.amount_bs));
      parsed.amount_bs = Number.isNaN(n) ? null : n;
    }

    if (!_hasExtractedCore(parsed)) {
      const keys = Object.keys(parsed).slice(0, 16).join(",");
      const out = {
        status: "parsed_empty",
        data: parsed,
        error_message: `JSON sin datos útiles tras mapear claves (referencia/monto/fecha/banco). Claves: ${keys || "—"}`,
        raw_model_snippet: _snippet(rawStr, 600),
      };
      log.warn({ confidence: parsed.confidence, keys: Object.keys(parsed) }, "receipt_extractor: JSON sin campos útiles");
      return out;
    }

    log.info(
      {
        ref: parsed.reference_number,
        amount_bs: parsed.amount_bs,
        tx_date: parsed.tx_date,
        bank: parsed.bank_name,
        confidence: parsed.confidence,
      },
      "receipt_extractor: comprobante extraído"
    );

    return {
      status: "ok",
      data: parsed,
      error_message: null,
      raw_model_snippet: null,
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    log.error({ err: msg }, "receipt_extractor: error inesperado");
    return fail("unexpected", msg);
  }
}

module.exports = {
  extractReceiptData,
  normalizeVenezuelanAmount,
  paymentAttemptFieldsFromExtraction,
};
