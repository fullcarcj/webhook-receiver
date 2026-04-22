-- Índice sobre products.sku_old para resolución rápida desde seller_sku de ML
-- y para la migración de precios desde FileMaker (lookup por sku_old).
-- La columna ya existe en BD; solo se agrega el índice si falta.

CREATE INDEX IF NOT EXISTS idx_products_sku_old
  ON products (sku_old)
  WHERE sku_old IS NOT NULL;
