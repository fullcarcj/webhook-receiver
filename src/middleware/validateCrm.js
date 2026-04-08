"use strict";

/**
 * @param {import("zod").ZodSchema} schema
 * @param {unknown} data
 * @returns {{ ok: true, data: unknown } | { ok: false, error: import("zod").ZodError }}
 */
function safeParse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, error: r.error };
}

module.exports = { safeParse };
