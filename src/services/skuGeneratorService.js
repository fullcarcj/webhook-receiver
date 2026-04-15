"use strict";

const { pool } = require("../../db");

/**
 * Reglas de negocio (contrato):
 * - Formato estricto: SS-SSS-MMM-NNNN (2-3-3-4, solo A-Z en prefijos, dígitos en correlativo).
 * - El correlativo NNNN es independiente por cada combinación SS-SSS-MMM (reinicia por prefijo).
 * - Inmutabilidad: el SKU no se modifica tras asignarse (no incluir `sku` en PATCH de producto).
 * - Atomicidad: el SKU definitivo debe reservarse en la MISMA transacción que el INSERT del producto
 *   usando `allocateNextSku(client, ...)`. Llamar a `allocateNextSku`, luego INSERT, luego COMMIT.
 *
 * Tablas reales: category_products (SS), product_subcategories (SSS), crm_vehicle_brands (MMM).
 */

const SKU_ROW_RE = /^[A-Z]{2}-[A-Z]{3}-[A-Z]{3}-[0-9]{4}$/;

/**
 * Solo lectura: obtiene los tres prefijos. Útil para validar antes de crear el producto.
 * @param {number} subcategoryId
 * @param {number} brandId
 * @returns {Promise<{ ss: string, sss: string, mmm: string, prefix: string }>}
 */
async function getSkuPrefixParts(subcategoryId, brandId) {
  const sid = Number(subcategoryId);
  const bid = Number(brandId);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(bid) || bid <= 0) {
    const e = new Error("subcategory_id y brand_id deben ser enteros positivos");
    e.code = "INVALID_IDS";
    throw e;
  }

  const { rows } = await pool.query(
    `
    SELECT
      cp.sku_prefix AS cat_prefix,
      ps.sku_prefix AS sub_prefix,
      b.sku_prefix  AS brand_prefix
    FROM product_subcategories ps
    JOIN category_products cp ON cp.id = ps.category_id
    JOIN crm_vehicle_brands b ON b.id = $2
    WHERE ps.id = $1
    `,
    [sid, bid]
  );

  if (!rows.length) {
    const e = new Error(
      "No existe la combinación subcategoría + marca, o faltan datos de catálogo"
    );
    e.code = "PREFIX_LOOKUP_FAILED";
    throw e;
  }

  const cat = String(rows[0].cat_prefix || "").trim();
  const sub = String(rows[0].sub_prefix || "").trim();
  const br = String(rows[0].brand_prefix || "").trim();

  if (!cat || !sub || !br) {
    const e = new Error(
      "Falta prefijo de categoría, subcategoría o marca (sku_prefix incompleto en BD)"
    );
    e.code = "MISSING_PREFIX";
    throw e;
  }

  if (cat.length !== 2 || !/^[A-Z]{2}$/.test(cat)) {
    const e = new Error("Prefijo de sistema (categoría) inválido: debe ser exactamente 2 letras A-Z");
    e.code = "INVALID_PREFIX_SS";
    throw e;
  }
  if (sub.length !== 3 || !/^[A-Z]{3}$/.test(sub)) {
    const e = new Error("Prefijo de subcategoría inválido: debe ser exactamente 3 letras A-Z");
    e.code = "INVALID_PREFIX_SSS";
    throw e;
  }
  if (br.length !== 3 || !/^[A-Z]{3}$/.test(br)) {
    const e = new Error("Prefijo de marca inválido: debe ser exactamente 3 letras A-Z");
    e.code = "INVALID_PREFIX_MMM";
    throw e;
  }

  const prefix = `${cat}-${sub}-${br}`;
  return { ss: cat, sss: sub, mmm: br, prefix };
}

/**
 * Reserva el siguiente SKU dentro de una transacción abierta.
 * Debe llamarse después de validar el producto y en el mismo `client` que hará INSERT en `products`.
 *
 * Concurrencia: usa `pg_advisory_xact_lock(hashtext(prefijo))` para serializar por combinación
 * SS-SSS-MMM (evita dos correlativos 0001 si aún no hay filas en `products`).
 *
 * @param {import('pg').PoolClient} client — cliente con transacción activa (BEGIN ya ejecutado).
 * @param {number} subcategoryId
 * @param {number} brandId
 * @returns {Promise<string>} SKU completo, p.ej. MO-BAG-TYT-0001
 */
async function allocateNextSku(client, subcategoryId, brandId) {
  if (!client || typeof client.query !== "function") {
    const e = new Error("allocateNextSku requiere un PoolClient de pg con transacción activa");
    e.code = "INVALID_CLIENT";
    throw e;
  }

  const sid = Number(subcategoryId);
  const bid = Number(brandId);
  if (!Number.isInteger(sid) || sid <= 0 || !Number.isInteger(bid) || bid <= 0) {
    const e = new Error("subcategory_id y brand_id deben ser enteros positivos");
    e.code = "INVALID_IDS";
    throw e;
  }

  const lockRes = await client.query(
    `
    SELECT
      cp.sku_prefix AS cat_prefix,
      ps.sku_prefix AS sub_prefix,
      b.sku_prefix  AS brand_prefix
    FROM product_subcategories ps
    JOIN category_products cp ON cp.id = ps.category_id
    JOIN crm_vehicle_brands b ON b.id = $2
    WHERE ps.id = $1
    FOR UPDATE OF ps, cp, b
    `,
    [sid, bid]
  );

  if (!lockRes.rows.length) {
    const e = new Error(
      "No existe la combinación subcategoría + marca, o combinación inválida"
    );
    e.code = "PREFIX_LOOKUP_FAILED";
    throw e;
  }

  const cat = String(lockRes.rows[0].cat_prefix || "").trim();
  const sub = String(lockRes.rows[0].sub_prefix || "").trim();
  const br = String(lockRes.rows[0].brand_prefix || "").trim();

  if (!cat || !sub || !br) {
    const e = new Error(
      "Falta prefijo de categoría, subcategoría o marca — abortar creación de SKU"
    );
    e.code = "MISSING_PREFIX";
    throw e;
  }

  if (cat.length !== 2 || !/^[A-Z]{2}$/.test(cat)) {
    const e = new Error("Prefijo de sistema (SS) inválido o ausente");
    e.code = "INVALID_PREFIX_SS";
    throw e;
  }
  if (sub.length !== 3 || !/^[A-Z]{3}$/.test(sub)) {
    const e = new Error("Prefijo de subcategoría (SSS) inválido o ausente");
    e.code = "INVALID_PREFIX_SSS";
    throw e;
  }
  if (br.length !== 3 || !/^[A-Z]{3}$/.test(br)) {
    const e = new Error("Prefijo de marca (MMM) inválido o ausente");
    e.code = "INVALID_PREFIX_MMM";
    throw e;
  }

  const triple = `${cat}-${sub}-${br}`;

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [triple]);

  const likePattern = `${triple}-%`;

  const maxRes = await client.query(
    `
    SELECT COALESCE(MAX(
      (regexp_match(sku, '^[A-Z]{2}-[A-Z]{3}-[A-Z]{3}-([0-9]{4})$'))[1]::int
    ), 0) AS max_n
    FROM products
    WHERE sku LIKE $1
      AND sku ~ $2
    `,
    [likePattern, "^[A-Z]{2}-[A-Z]{3}-[A-Z]{3}-[0-9]{4}$"]
  );

  let maxN = Number(maxRes.rows[0].max_n);
  if (!Number.isFinite(maxN)) maxN = 0;
  const next = maxN + 1;
  if (next > 9999) {
    const e = new Error("Se agotó el correlativo (máximo 9999) para esta combinación de prefijos");
    e.code = "SKU_COUNTER_EXHAUSTED";
    throw e;
  }

  const num = String(next).padStart(4, "0");
  return `${triple}-${num}`;
}

module.exports = {
  allocateNextSku,
  getSkuPrefixParts,
  SKU_ROW_RE,
};
