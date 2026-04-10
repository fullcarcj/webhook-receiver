"use strict";

/**
 * Extractor de datos de comprobantes bancarios venezolanos vía Gemini Vision.
 * Usa el AI Gateway (Gemini vía `provider_settings` o `GEMINI_API_KEY`).
 */

const pino = require("pino");
const log  = pino({ level: process.env.LOG_LEVEL || "info", name: "receipt_extractor" });

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

/**
 * @param {string} firebaseUrl — URL pública de Firebase Storage (imagen)
 * @returns {Promise<object|null>}
 */
async function extractReceiptData(firebaseUrl) {
  try {
    const imgRes = await fetch(firebaseUrl);
    if (!imgRes.ok) {
      throw new Error(`No se pudo descargar imagen para Gemini [${imgRes.status}]`);
    }
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const arr = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arr).toString("base64");

    const { callVision } = require("../../services/aiGateway");
    const content = await callVision({
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

    let jsonText = content;
    const m = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/i);
    if (m && m[1]) jsonText = m[1].trim();
    const parsed = JSON.parse(jsonText);

    if (parsed.amount_bs != null) {
      parsed.amount_bs = normalizeVenezuelanAmount(String(parsed.amount_bs));
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

    return parsed;
  } catch (err) {
    log.error({ err: err.message }, "receipt_extractor: error Gemini Vision");
    return null;
  }
}

module.exports = { extractReceiptData, normalizeVenezuelanAmount };
