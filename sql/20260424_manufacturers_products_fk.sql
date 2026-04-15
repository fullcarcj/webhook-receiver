-- Fabricantes del repuesto (Aisin, GMB, Gates, …) y vínculo en products.
-- brand_id en products sigue siendo la marca de VEHÍCULO (MMM del SKU) → crm_vehicle_brands.
-- manufacturer_id = fabricante del repuesto.
--
-- Ejecutar: npm run db:manufacturers
-- Prerrequisitos: db:crm (crm_vehicle_brands) si se añade la FK de brand_id.

-- ── 1. Tabla manufacturers ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manufacturers (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manufacturers_name_lower
  ON manufacturers (lower(trim(name)));

COMMENT ON TABLE manufacturers IS 'Fabricante del repuesto (aftermarket); distinto de crm_vehicle_brands (marca de vehículo).';
COMMENT ON COLUMN manufacturers.name IS 'Nombre legible del fabricante; único operativo vía aplicación o índice si se añade UNIQUE.';

-- ── 2. Columna manufacturer_id en products ───────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS manufacturer_id BIGINT;

COMMENT ON COLUMN products.manufacturer_id IS 'FK opcional al fabricante del repuesto; distinto de brand_id (vehículo / SKU).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_products_manufacturer'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT fk_products_manufacturer
      FOREIGN KEY (manufacturer_id) REFERENCES manufacturers (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_manufacturer_id
  ON products (manufacturer_id)
  WHERE manufacturer_id IS NOT NULL;

-- ── 3. FK brand_id → crm_vehicle_brands (solo si tabla existe y sin huérfanos)
DO $$
DECLARE
  n_orphans int;
BEGIN
  IF to_regclass('public.crm_vehicle_brands') IS NULL THEN
    RAISE NOTICE 'Omitido fk_products_brand_vehicle: public.crm_vehicle_brands no existe.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_products_brand_vehicle') THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO n_orphans
  FROM products p
  WHERE p.brand_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM crm_vehicle_brands b WHERE b.id = p.brand_id);

  IF n_orphans > 0 THEN
    RAISE EXCEPTION
      'No se puede crear fk_products_brand_vehicle: hay % filas en products con brand_id no presente en crm_vehicle_brands. Corregir datos y reintentar.',
      n_orphans;
  END IF;

  ALTER TABLE products
    ADD CONSTRAINT fk_products_brand_vehicle
    FOREIGN KEY (brand_id) REFERENCES crm_vehicle_brands (id)
    ON DELETE SET NULL;
END $$;
