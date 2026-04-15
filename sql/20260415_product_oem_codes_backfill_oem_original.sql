-- Repara oem_original vacío/NULL desde products.sku_old (prefijo antes del primer '_').
-- Idempotente. Ejecutar con: node scripts/run-sql-file-pg.js sql/20260415_product_oem_codes_backfill_oem_original.sql

UPDATE product_oem_codes poc
SET oem_original = NULLIF(btrim(split_part(p.sku_old::text, '_', 1)), '')
FROM products p
WHERE poc.product_id = p.id
  AND p.sku_old IS NOT NULL
  AND btrim(p.sku_old::text) <> ''
  AND (
    poc.oem_original IS NULL
    OR btrim(poc.oem_original::text) = ''
  );
