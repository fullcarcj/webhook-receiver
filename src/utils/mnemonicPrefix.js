"use strict";

/**
 * Palabras gramaticales comunes (es) que no aportan a iniciales compuestas.
 */
const STOP_WORDS = new Set([
  "DE",
  "LA",
  "EL",
  "LOS",
  "LAS",
  "Y",
  "O",
  "A",
  "EN",
  "UN",
  "UNA",
  "UNOS",
  "UNAS",
  "DEL",
  "AL",
  "POR",
  "CON",
  "SIN",
  "SOBRE",
  "PARA",
]);

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

/**
 * @param {string} name
 * @returns {string[]}
 */
function tokenizeWords(name) {
  const s = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z\s]/g, " ")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
  return s.split(" ").filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/**
 * Consonantes en orden (Y cuenta como consonante para casos tipo Toyota → TYT).
 * @param {string} word
 */
function consonantSkeleton(word) {
  let out = "";
  for (const c of String(word || "").toUpperCase()) {
    if (!/[A-Z]/.test(c)) continue;
    if (VOWELS.has(c)) continue;
    out += c;
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Genera un prefijo mnemotécnico de longitud fija (2 = categorías, 3 = subcategorías/marcas).
 * @param {string} name
 * @param {2|3} length
 * @returns {string}
 */
function generateMnemonicPrefix(name, length) {
  const L = length === 2 || length === 3 ? length : 3;
  const words = tokenizeWords(name);
  if (words.length === 0) return "X".repeat(L);

  if (L === 2) {
    if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.slice(0, 2);
    const w = words[0];
    if (w.length >= 2) return w.slice(0, 2);
    return `${w}X`.slice(0, 2);
  }

  // L === 3
  if (words.length >= 3) {
    return `${words[0][0]}${words[1][0]}${words[2][0]}`.slice(0, 3);
  }

  if (words.length === 2) {
    const w1 = words[0];
    const w2 = words[1];
    if (w2.length <= 4) {
      return `${w1[0]}${w2.slice(0, 2)}`.slice(0, 3);
    }
    return `${w1[0]}${w1[1] || w1[0]}${w2[0]}`.slice(0, 3);
  }

  const w = words[0];
  const cons = consonantSkeleton(w);
  if (cons.length >= 3) return cons.slice(0, 3);
  if (cons.length > 0) {
    const pad = `${cons}${w}`.replace(/[AEIOU]/g, "").toUpperCase();
    if (pad.length >= 3) return pad.slice(0, 3);
  }
  return `${w}${w}`.replace(/[aeiou]/gi, "").toUpperCase().slice(0, 3) || "XXX".slice(0, 3);
}

/**
 * Variaciones deterministas si el prefijo base ya existe (misma longitud, solo A-Z).
 * @param {string} base
 * @param {number} length
 * @param {number} max
 */
function* iteratePrefixVariants(base, length, max = 200) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let b = String(base || "A")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, length);
  while (b.length < length) b += "X";
  b = b.slice(0, length);

  yield b;

  let count = 1;
  const arr = b.split("");
  for (let pos = length - 1; pos >= 0 && count < max; pos--) {
    const start = alphabet.indexOf(arr[pos]);
    if (start < 0) continue;
    for (let k = 1; k < 26 && count < max; k++) {
      const copy = [...arr];
      copy[pos] = alphabet[(start + k) % 26];
      count++;
      yield copy.join("");
    }
  }
}

module.exports = {
  generateMnemonicPrefix,
  iteratePrefixVariants,
  tokenizeWords,
};
