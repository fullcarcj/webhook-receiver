-- OEM extraído del prefijo legacy en sku_old (antes del primer '_').
-- Ejecutar: npm run db:product-oem-codes

CREATE TABLE IF NOT EXISTS product_oem_codes (
  id               SERIAL PRIMARY KEY,
  product_id       BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  oem_original     TEXT NOT NULL,
  oem_normalized   TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'sku_old',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_oem_codes_product_id UNIQUE (product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_oem_product_id ON product_oem_codes (product_id);
CREATE INDEX IF NOT EXISTS idx_product_oem_normalized ON product_oem_codes (oem_normalized);

COMMENT ON TABLE product_oem_codes IS 'Código OEM/fabricante derivado del prefijo legacy (antes del primer _ en sku_old).';
COMMENT ON COLUMN product_oem_codes.oem_original IS 'Prefijo tal cual en sku_old, p.ej. 86620A';
COMMENT ON COLUMN product_oem_codes.oem_normalized IS 'OEM sin sufijo A-F final opcional; solo alfanuméricos, mayúsculas.';
