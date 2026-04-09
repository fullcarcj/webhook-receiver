"use strict";

/**
 * Extractor de datos de comprobantes bancarios venezolanos via GPT-4o Vision.
 * Solo se ejecuta si OPENAI_API_KEY está configurada.
 * Usa gpt-4o (no mini) con detail:high — necesario para leer números de referencia
 * bancaria venezolana en fondos grises con tipografía pequeña.
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
  if (!process.env.OPENAI_API_KEY) {
    log.warn("OPENAI_API_KEY no configurada — extracción de comprobante omitida");
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:       "gpt-4o",
        max_tokens:  300,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type:      "image_url",
                image_url: { url: firebaseUrl, detail: "high" },
              },
              {
                type: "text",
                text: "Extrae los datos de este comprobante bancario venezolano.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI [${response.status}]: ${await response.text()}`);
    }

    const result  = await response.json();
    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("GPT-4o sin contenido en respuesta");

    const parsed = JSON.parse(content.replace(/```json|```/g, "").trim());

    if (parsed.amount_bs != null) {
      parsed.amount_bs = normalizeVenezuelanAmount(String(parsed.amount_bs));
    }

    log.info({
      ref:        parsed.reference_number,
      amount_bs:  parsed.amount_bs,
      tx_date:    parsed.tx_date,
      bank:       parsed.bank_name,
      confidence: parsed.confidence,
    }, "receipt_extractor: comprobante extraído");

    return parsed;
  } catch (err) {
    log.error({ err: err.message }, "receipt_extractor: error GPT-4o Vision");
    return null;
  }
}

module.exports = { extractReceiptData, normalizeVenezuelanAmount };
