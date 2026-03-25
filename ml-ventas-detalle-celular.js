/**
 * Extrae teléfono VE móvil: 11 dígitos, prefijo 04, sin espacios ni guiones.
 * Prioriza el bloque " | Tel " … "</p>"; si no, primer 04 + 9 dígitos en el HTML.
 */

function cleanDigits(s) {
  return String(s).replace(/[\s\u00A0\-().]/g, "");
}

/**
 * @param {string|null|undefined} html
 * @returns {string|null}
 */
function extractCelularFromVentasHtml(html) {
  if (html == null || typeof html !== "string" || !html.trim()) return null;

  const marker = " | Tel ";
  const idx = html.indexOf(marker);
  if (idx >= 0) {
    const start = idx + marker.length;
    let end = html.indexOf("</p>", start);
    if (end < 0) end = html.indexOf("</div>", start);
    if (end < 0) end = html.indexOf("<", start);
    const slice = end >= start ? html.slice(start, end >= 0 ? end : start + 120) : "";
    const cleaned = cleanDigits(slice);
    const m = cleaned.match(/04\d{9}/);
    if (m && m[0].length === 11) return m[0];
  }

  const cleanedAll = cleanDigits(html);
  const matches = cleanedAll.match(/04\d{9}/g);
  if (matches && matches.length) {
    const first = matches.find((x) => x.length === 11);
    if (first) return first;
  }

  return null;
}

module.exports = { extractCelularFromVentasHtml, cleanDigits };
