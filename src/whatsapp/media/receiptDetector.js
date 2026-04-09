"use strict";

/**
 * Prefiltro visual de comprobantes bancarios venezolanos.
 * Usa sharp en memoria — sin llamadas a API, sin costo, < 50ms.
 * Clasifica imagen como probable comprobante bancario según:
 *   - Proporción de pantalla (portrait/landscape)
 *   - Ratio de píxeles claros (fondos blancos/grises = comprobantes)
 *   - Presencia de colores corporativos bancarios venezolanos
 */

const sharp = require("sharp");

const THRESHOLDS = {
  MIN_LIGHT_PIXEL_RATIO: 0.45,
  PORTRAIT_MIN_RATIO:    1.30,
  LANDSCAPE_MAX_RATIO:   0.70,
  MIN_CONFIDENCE:        0.55,
};

// Rangos RGB de colores bancarios venezolanos más frecuentes
const BANK_COLORS = [
  { r: [0,  30],  g: [40,  80],  b: [120, 160] }, // BBVA Provincial azul oscuro
  { r: [0,  50],  g: [100, 160], b: [80,  130] }, // Banesco verde
  { r: [200,255], g: [150, 220], b: [0,   60]  }, // Banco de Venezuela amarillo/rojo
];

/**
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ isReceipt: boolean, score: number, reason: string }>}
 */
async function isPaymentReceipt(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .resize(200, 200, { fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const aspectRatio = height / width;
    const isPortrait  = aspectRatio >= THRESHOLDS.PORTRAIT_MIN_RATIO;
    const isLandscape = aspectRatio <= THRESHOLDS.LANDSCAPE_MAX_RATIO;

    if (!isPortrait && !isLandscape) {
      return { isReceipt: false, score: 0.10, reason: "aspect_ratio_invalid" };
    }

    let lightPixels = 0;
    let bankColorHits = 0;
    const total = width * height;

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (r > 200 && g > 200 && b > 200) lightPixels++;

      for (const c of BANK_COLORS) {
        if (
          r >= c.r[0] && r <= c.r[1] &&
          g >= c.g[0] && g <= c.g[1] &&
          b >= c.b[0] && b <= c.b[1]
        ) {
          bankColorHits++;
          break;
        }
      }
    }

    const lightRatio     = lightPixels / total;
    const bankColorRatio = bankColorHits / total;

    let score = 0;
    score += lightRatio >= THRESHOLDS.MIN_LIGHT_PIXEL_RATIO
      ? 0.50
      : (lightRatio * 0.50) / THRESHOLDS.MIN_LIGHT_PIXEL_RATIO;

    if (isPortrait)            score += 0.25;
    if (isLandscape)           score += 0.20;
    if (bankColorRatio > 0.05) score += 0.25;

    score = Math.min(score, 1.00);

    return {
      isReceipt: score >= THRESHOLDS.MIN_CONFIDENCE,
      score:     Math.round(score * 100) / 100,
      reason:    score >= THRESHOLDS.MIN_CONFIDENCE ? "receipt_detected" : "low_score",
    };
  } catch (err) {
    return { isReceipt: false, score: 0, reason: `error: ${err.message}` };
  }
}

module.exports = { isPaymentReceipt };
