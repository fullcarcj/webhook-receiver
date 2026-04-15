-- Solo columnas nuevas (sin CREATE TABLE).
-- category_products, product_subcategories, crm_vehicle_brands + products.sku ya existen en este proyecto.
-- Formato SKU generado: SS-SSS-MMM-NNNN (prefijos A-Z; correlativo 4 dígitos).
-- Idempotente donde PostgreSQL lo permite.

-- ── category_products.sku_prefix ─────────────────────────────────────────────
ALTER TABLE category_products
  ADD COLUMN IF NOT EXISTS sku_prefix VARCHAR(2);

UPDATE category_products cp
SET sku_prefix = (
  chr((65 + (((t.rn - 1)::bigint / 26) % 26))::int) ||
  chr((65 + ((t.rn - 1) % 26))::int)
)
FROM (
  SELECT id, row_number() OVER (ORDER BY id) AS rn
  FROM category_products
) t
WHERE cp.id = t.id
  AND (cp.sku_prefix IS NULL OR btrim(cp.sku_prefix::text) = '');

ALTER TABLE category_products
  ALTER COLUMN sku_prefix SET NOT NULL;

ALTER TABLE category_products
  DROP CONSTRAINT IF EXISTS chk_category_products_sku_prefix_az;
ALTER TABLE category_products
  ADD CONSTRAINT chk_category_products_sku_prefix_az
  CHECK (sku_prefix ~ '^[A-Z]{2}$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_products_sku_prefix
  ON category_products (sku_prefix);

COMMENT ON COLUMN category_products.sku_prefix IS 'Prefijo 2 letras A-Z (único) para armado de SKU.';

-- ── product_subcategories.sku_prefix ─────────────────────────────────────────
ALTER TABLE product_subcategories
  ADD COLUMN IF NOT EXISTS sku_prefix VARCHAR(3);

UPDATE product_subcategories ps
SET sku_prefix = (
  chr((65 + (((t.rn - 1)::bigint / 676) % 26))::int) ||
  chr((65 + (((t.rn - 1)::bigint / 26) % 26))::int) ||
  chr((65 + ((t.rn - 1) % 26))::int)
)
FROM (
  SELECT id, row_number() OVER (ORDER BY id) AS rn
  FROM product_subcategories
) t
WHERE ps.id = t.id
  AND (ps.sku_prefix IS NULL OR btrim(ps.sku_prefix::text) = '');

ALTER TABLE product_subcategories
  ALTER COLUMN sku_prefix SET NOT NULL;

ALTER TABLE product_subcategories
  DROP CONSTRAINT IF EXISTS chk_product_subcategories_sku_prefix_az;
ALTER TABLE product_subcategories
  ADD CONSTRAINT chk_product_subcategories_sku_prefix_az
  CHECK (sku_prefix ~ '^[A-Z]{3}$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_subcategories_sku_prefix
  ON product_subcategories (sku_prefix);

COMMENT ON COLUMN product_subcategories.sku_prefix IS 'Prefijo 3 letras A-Z (único global) para armado de SKU.';

-- ── crm_vehicle_brands.sku_prefix (solo si la tabla CRM ya fue migrada) ─────
DO $$
BEGIN
  IF to_regclass('public.crm_vehicle_brands') IS NULL THEN
    RAISE NOTICE 'Omitido sku_prefix en crm_vehicle_brands: tabla no existe (ejecuta migración CRM antes).';
    RETURN;
  END IF;

  ALTER TABLE crm_vehicle_brands
    ADD COLUMN IF NOT EXISTS sku_prefix VARCHAR(3);

  UPDATE crm_vehicle_brands b
  SET sku_prefix = (
    chr((65 + (((t.rn - 1)::bigint / 676) % 26))::int) ||
    chr((65 + (((t.rn - 1)::bigint / 26) % 26))::int) ||
    chr((65 + ((t.rn - 1) % 26))::int)
  )
  FROM (
    SELECT id, row_number() OVER (ORDER BY id) AS rn
    FROM crm_vehicle_brands
  ) t
  WHERE b.id = t.id
    AND (b.sku_prefix IS NULL OR btrim(b.sku_prefix::text) = '');

  ALTER TABLE crm_vehicle_brands
    ALTER COLUMN sku_prefix SET NOT NULL;

  ALTER TABLE crm_vehicle_brands
    DROP CONSTRAINT IF EXISTS chk_crm_vehicle_brands_sku_prefix_az;
  ALTER TABLE crm_vehicle_brands
    ADD CONSTRAINT chk_crm_vehicle_brands_sku_prefix_az
    CHECK (sku_prefix ~ '^[A-Z]{3}$');

  CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_vehicle_brands_sku_prefix
    ON crm_vehicle_brands (sku_prefix);

  COMMENT ON COLUMN crm_vehicle_brands.sku_prefix IS 'Prefijo 3 letras A-Z (único) para armado de SKU.';
END $$;
