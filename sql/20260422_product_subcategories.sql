-- Subcategorías de catálogo (repuestos) ligadas a category_products.
-- Prerrequisito: npm run db:category-products  (sql/20260421_category_products.sql)
-- Idempotente: seguro ejecutar más de una vez.

CREATE TABLE IF NOT EXISTS product_subcategories (
  id BIGSERIAL PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES category_products (id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  code_ml TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_subcategories_category_name UNIQUE (category_id, name)
);

CREATE INDEX IF NOT EXISTS idx_product_subcategories_category_id
  ON product_subcategories (category_id);

COMMENT ON TABLE product_subcategories IS 'Subcategorías de producto bajo una fila de category_products.';
COMMENT ON COLUMN product_subcategories.category_id IS 'FK a category_products.id (categoría padre).';
COMMENT ON COLUMN product_subcategories.name IS 'Nombre legible de la subcategoría.';
COMMENT ON COLUMN product_subcategories.sort_order IS 'Orden dentro de la categoría.';
COMMENT ON COLUMN product_subcategories.code_ml IS 'Código o referencia ML opcional.';

-- products.subcategory_id → product_subcategories (si la columna ya existe, solo se añade FK)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS subcategory_id BIGINT;

COMMENT ON COLUMN products.subcategory_id IS 'Subcategoría de catálogo; FK a product_subcategories(id).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_products_product_subcategory'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT fk_products_product_subcategory
      FOREIGN KEY (subcategory_id) REFERENCES product_subcategories (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_subcategory_id
  ON products (subcategory_id)
  WHERE subcategory_id IS NOT NULL;

-- updated_at automático si existe set_updated_at() (p. ej. exchange-rates / wms)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_product_subcategories_updated_at ON product_subcategories;
    CREATE TRIGGER trg_product_subcategories_updated_at
      BEFORE UPDATE ON product_subcategories
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Ejemplo (descomentar y ajustar category_id según tu category_products):
-- INSERT INTO product_subcategories (category_id, name, sort_order)
-- VALUES (1, 'Pastillas de freno', 10)
-- ON CONFLICT (category_id, name) DO NOTHING;
