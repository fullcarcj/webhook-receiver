"use strict";

/**
 * Lee opciones estilo `--name=value` o `--name value` (evita que `--limit 100` no llegue como valor).
 * @param {string[]} argv
 * @param {string} name - sin `--`, ej. `ml-user-id`, `limit`
 * @returns {string|null}
 */
function parseCliOption(argv, name) {
  const eq = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(eq));
  if (hit != null) {
    const v = hit.slice(eq.length);
    return v === "" ? null : v;
  }
  const flag = `--${name}`;
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) {
    const next = argv[idx + 1];
    if (next && !String(next).startsWith("-")) return String(next);
  }
  return null;
}

module.exports = { parseCliOption };
