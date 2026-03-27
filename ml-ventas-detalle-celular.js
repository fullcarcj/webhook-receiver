/**
 * Extrae teléfono VE móvil: 11 dígitos, prefijo 04, sin espacios ni guiones.
 * Prioriza el bloque " | Tel " … "</p>"; si no, primer 04 + 9 dígitos en el HTML.
 *
 * Nombre y apellido: port del guion FileMaker sobre RESULTADO_LLAMADA_G (GET detalle):
 * 1) posición de "buyer_info_text"; 2) "label" desde ahí;
 * 3) Middle entre el 2.º y 3.º delimitador \u003e (6 caracteres en el HTML/JSON embebido).
 * Fórmula FM equivalente: inicio = pos(2º) + 6; longitud = (pos(3º) + 6) - pos(2º) - 12.
 */

function cleanDigits(s) {
  return String(s).replace(/[\s\u00A0\-().]/g, "");
}

/** Secuencia literal típica en JSON embebido en la página (equiv. a `>`). */
const DELIM_U003E = "\\u003e";

/** ML .ve: nombre en JSON como `<b>nombre</b>` escapado (\u003C = <, \u003E = >). */
const MARKER_BUYER_DATA_LABEL_BOLD = '"buyer","data":{"label":"\\u003Cb\\u003E';
/** Cierre `</b>` en JSON: `/` literal o `\u002F` (ML Nordic suele usar `\u003C\u002Fb\u003E`). */
const CLOSE_B_BOLD_ESC_VARIANTS = [
  "\\u003C/b\\u003E",
  "\\u003c/b\\u003e",
  "\\u003C\\u002Fb\\u003E",
  "\\u003c\\u002fb\\u003e",
];

/** Apertura/cierre `<b>…</b>` en escapes JSON; cierre con `/b` o `\u002F`+`b` (Nordic). */
const RE_BOLD_ESC_BLOCK =
  /\\u003[cC]b\\u003[eE]([\s\S]*?)\\u003[cC](?:\\u002[fF][bB]|[/][bB])\\u003[eE]/g;

/** `label` seguido de comillas y apertura en escape o HTML real; cierre con `/` o `\u002F`. */
const RE_LABEL_THEN_BOLD =
  /["']label["']\s*:\s*["'](?:\\u003[cC]b\\u003[eE]|<b>)([\s\S]*?)(?:\\u003[cC](?:\\u002[fF][bB]|[/][bB])\\u003[eE]|<\/b>)["']/i;

/**
 * Resultado del modo FileMaker (delimitadores) o regex sueltos que cruza tags `<script>`:
 * el `>` como delimitador tomaba el 2.º/3.º `>` del HTML y devolvía p. ej. `window._gt={ctx:{}};</script>`.
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeGarbageNombreExtract(s) {
  const t = String(s).trim();
  if (!t) return true;
  if (t.length > 160) return true;
  if (/window\.|document\.|newrelic|__NEWRELIC/i.test(t)) return true;
  if (/<\/?script|function\s*\(|=>|\{ctx:|\}\s*;\s*<\/|=\s*\{\s*ctx\s*:/i.test(t)) return true;
  if (/[<>{};=]{3,}/.test(t)) return true;
  return false;
}

/**
 * Tras el marcador buyer/data/label + `\u003Cb\u003E`, ML suele llevar nombre y apellido como las dos primeras palabras.
 * @param {string} segment texto entre `\u003E` de `<b>` y `</b>`
 * @returns {string|null}
 */
function firstTwoWordsFromSegment(segment) {
  const s = String(segment)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .trim();
  const inner = s.startsWith('"') && s.endsWith('"') && s.length > 1 ? s.slice(1, -1).trim() : s;
  const parts = inner.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1]}`;
}

/**
 * @param {string} haystack
 * @param {string} needle
 * @param {number} fromIndex
 * @param {number} n 1-based (1 = primera aparición desde fromIndex)
 * @returns {number}
 */
function nthIndexOf(haystack, needle, fromIndex, n) {
  if (n < 1 || !needle) return -1;
  let pos = fromIndex;
  for (let i = 0; i < n; i++) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) return -1;
    if (i === n - 1) return idx;
    pos = idx + needle.length;
  }
  return -1;
}

/**
 * @param {string} html
 * @param {number} ubi2
 * @param {string} delim
 * @returns {string|null}
 */
function middleBetweenSecondAndThirdDelim(html, ubi2, delim) {
  const dlen = delim.length;
  const p2 = nthIndexOf(html, delim, ubi2, 2);
  const p3 = nthIndexOf(html, delim, ubi2, 3);
  if (p2 < 0 || p3 < 0 || p3 <= p2) return null;
  const len = p3 - p2 - dlen;
  if (len <= 0) return null;
  return html.slice(p2 + dlen, p2 + dlen + len);
}

/** Prefijos exactos probados antes del regex (minificado / mayúsculas en \\u003X). */
const MARKER_BOLD_PREFIX_VARIANTS = [
  MARKER_BUYER_DATA_LABEL_BOLD,
  '"buyer","data":{"label":"\\u003cb\\u003e',
  '"data":{"label":"\\u003Cb\\u003E',
  '"data":{"label":"\\u003cb\\u003e',
];

/**
 * Anclas para BD (equivalente FileMaker: quitar prefijo, luego buscar label en el resto):
 * - Modo A: `buyer_info_text` + primera `"label"` en el trozo restante.
 * - Modo B (ML .ve real): `"buyer","data":{"label":"\u003Cb\u003E` — sin `buyer_info_text` en el bundle.
 * @param {string|null|undefined} html
 * @returns {{ pos_buyer_info_text: number|null, pos_label: number|null }}
 */
function computeVentasDetalleAnchorPositions(html) {
  if (html == null || typeof html !== "string" || !html.trim()) {
    return { pos_buyer_info_text: null, pos_label: null };
  }
  let ubi1 = html.indexOf('"buyer_info_text"');
  if (ubi1 < 0) ubi1 = html.indexOf("buyer_info_text");
  if (ubi1 >= 0) {
    const afterBuyer = html.slice(ubi1);
    let rel = afterBuyer.indexOf('"label"');
    if (rel < 0) rel = afterBuyer.indexOf("label");
    if (rel < 0) return { pos_buyer_info_text: ubi1, pos_label: null };
    return { pos_buyer_info_text: ubi1, pos_label: rel };
  }

  let idxBold = -1;
  for (const prefix of MARKER_BOLD_PREFIX_VARIANTS) {
    idxBold = html.indexOf(prefix);
    if (idxBold >= 0) break;
  }
  if (idxBold < 0) return { pos_buyer_info_text: null, pos_label: null };
  const afterBuyer = html.slice(idxBold);
  const rel = afterBuyer.indexOf('"label":"');
  if (rel < 0) return { pos_buyer_info_text: idxBold, pos_label: null };
  return { pos_buyer_info_text: idxBold, pos_label: rel };
}

/**
 * Contenido entre `\u003Xb\u003Y` y `\u003X/b\u003Y` (mismas X/Y que la apertura).
 * @param {string} html
 * @param {number} start
 * @returns {string|null}
 */
function sliceBoldEscFromOpen(html, start) {
  let end = -1;
  for (const close of CLOSE_B_BOLD_ESC_VARIANTS) {
    const i = html.indexOf(close, start);
    if (i >= 0 && (end < 0 || i < end)) end = i;
  }
  if (end < 0 || end <= start) return null;
  return html.slice(start, end);
}

/**
 * Cualquier bloque `\u003[cC]b\u003[eE]…\u003[cC]/b\u003[eE]` cerca de buyer/label (ML cambia el bundle).
 * @param {string} html
 * @returns {string|null}
 */
function extractInnerFromRegexBoldBlocks(html) {
  const candidates = [];
  let m;
  const re = new RegExp(RE_BOLD_ESC_BLOCK.source, "gi");
  while ((m = re.exec(html)) !== null) {
    const inner = m[1];
    const before = html.slice(Math.max(0, m.index - 160), m.index);
    let score = 0;
    if (/buyer|"buyer"|'buyer'/i.test(before)) score += 2;
    if (/label|"label"/i.test(before)) score += 2;
    if (/data|"data"/i.test(before)) score += 1;
    candidates.push({ score, inner, index: m.index });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0].inner;
}

/**
 * `label` + valor como `<b>texto</b>` literal (sin escapar unicode en JSON).
 * @param {string} html
 * @returns {string|null}
 */
function extractInnerFromLiteralLabelBold(html) {
  const needles = ['"label":"<b>', '"label": "<b>', "'label':'<b>"];
  for (const n of needles) {
    const idx = html.indexOf(n);
    if (idx < 0) continue;
    const start = idx + n.length;
    const end = html.indexOf("</b>", start);
    if (end > start) return html.slice(start, end);
  }
  return null;
}

/**
 * Las **dos palabras** tras el `<b>` del label (varias formas que usa ML en el HTML).
 * @param {string} html
 * @returns {string|null}
 */
function extractNombreFromBuyerDataLabelBold(html) {
  if (html == null || typeof html !== "string") return null;

  for (const prefix of MARKER_BOLD_PREFIX_VARIANTS) {
    const idx = html.indexOf(prefix);
    if (idx < 0) continue;
    const inner = sliceBoldEscFromOpen(html, idx + prefix.length);
    if (inner) {
      const w = firstTwoWordsFromSegment(inner);
      if (w) return w;
    }
  }

  const fromRe = extractInnerFromRegexBoldBlocks(html);
  if (fromRe) {
    const w = firstTwoWordsFromSegment(fromRe);
    if (w) return w;
  }

  const m = html.match(RE_LABEL_THEN_BOLD);
  if (m && m[1]) {
    const w = firstTwoWordsFromSegment(m[1]);
    if (w) return w;
  }

  const lit = extractInnerFromLiteralLabelBold(html);
  if (lit) return firstTwoWordsFromSegment(lit);

  return null;
}

/**
 * Orden: 1) JSON Nordic `data.label` + `<b>…</b>` escapado (incl. `\u002F` en `</b>`).
 * 2) Guion FM solo con delimitadores `\u003e` / `\u003c` (nunca `>` suelto: cruza `<script>` y devuelve basura).
 * @param {string|null|undefined} html
 * @returns {string|null}
 */
function extractNombreApellidoFromVentasHtml(html) {
  if (html == null || typeof html !== "string" || !html.trim()) return null;

  const fromBold = extractNombreFromBuyerDataLabelBold(html);
  if (fromBold && !looksLikeGarbageNombreExtract(fromBold)) return fromBold;

  const { pos_buyer_info_text: ubi1, pos_label: offsetLabel } = computeVentasDetalleAnchorPositions(html);
  if (ubi1 != null && offsetLabel != null) {
    const ubi2Abs = ubi1 + offsetLabel;
    const delims = [DELIM_U003E, "\\u003c"];
    for (const delim of delims) {
      const raw = middleBetweenSecondAndThirdDelim(html, ubi2Abs, delim);
      if (raw == null || !String(raw).trim()) continue;
      let s = String(raw)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\u0026/g, "&")
        .trim();
      if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
        s = s.slice(1, -1).trim();
      }
      if (s && !looksLikeGarbageNombreExtract(s)) return s;
    }
  }

  return null;
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

module.exports = {
  extractCelularFromVentasHtml,
  extractNombreApellidoFromVentasHtml,
  extractNombreFromBuyerDataLabelBold,
  firstTwoWordsFromSegment,
  computeVentasDetalleAnchorPositions,
  looksLikeGarbageNombreExtract,
  cleanDigits,
};

