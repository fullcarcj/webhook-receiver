"use strict";

/** Prefijo de sitio ML (MLA, MLV, …) → TLD de `articulo.mercadolibre.*` */
const ML_SITE_TLD = {
  MLA: "com.ar",
  MLB: "com.bo",
  MLC: "cl",
  MLM: "com.mx",
  MCO: "com.co",
  MCR: "co.cr",
  MLU: "com.uy",
  MLV: "com.ve",
  MPE: "com.pe",
  MPT: "pt",
  MEC: "com.ec",
  MLBO: "com.bo",
  MGT: "com.gt",
  MHN: "com.hn",
  MNI: "com.ni",
  MPA: "com.pa",
  MPY: "com.py",
  MRD: "com.do",
  MSR: "com.sv",
};

/**
 * Normaliza id tipo MLA1234567890 → MLA-1234567890 (ruta típica en articulo.*).
 * @param {string} itemId
 * @returns {string}
 */
function prettyMlItemPath(itemId) {
  const s = String(itemId || "").trim();
  const m = s.match(/^([A-Z]{2,4})(\d{5,})$/i);
  if (!m) return encodeURIComponent(s);
  return `${m[1].toUpperCase()}-${m[2]}`;
}

/**
 * URL pública de la ficha del ítem (fallback si `ml_listings.permalink` viene vacío).
 * @param {string|null|undefined} itemId ej. MLA123 o MLV502…
 * @param {string|null|undefined} [siteId] ej. MLA desde fila listing
 * @returns {string|null}
 */
function mercadoLibreItemPublicUrl(itemId, siteId) {
  const id = itemId != null ? String(itemId).trim() : "";
  if (!id || /^https?:\/\//i.test(id)) return id || null;
  const fromId = id.match(/^([A-Z]{2,4})\d/i);
  const prefix = (siteId && String(siteId).trim().match(/^[A-Z]{2,4}$/i)?.[0]?.toUpperCase()) ||
    (fromId ? fromId[1].toUpperCase() : null) ||
    "MLV";
  const tld = ML_SITE_TLD[prefix] || "com.ve";
  return `https://articulo.mercadolibre.${tld}/${prettyMlItemPath(id)}`;
}

/**
 * @param {string|null|undefined} permalink desde API / ml_listings
 * @param {string|null|undefined} itemId
 * @param {string|null|undefined} siteId
 * @returns {string|null}
 */
function resolveMercadoLibreListingUrl(permalink, itemId, siteId) {
  const p = permalink != null ? String(permalink).trim() : "";
  if (p && /^https?:\/\//i.test(p)) return p;
  return mercadoLibreItemPublicUrl(itemId, siteId);
}

module.exports = {
  mercadoLibreItemPublicUrl,
  resolveMercadoLibreListingUrl,
  prettyMlItemPath,
};
