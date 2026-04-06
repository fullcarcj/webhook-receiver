CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_productos_sku_trgm
  ON productos USING GIN (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_productos_descripcion_trgm
  ON productos USING GIN (descripcion gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_productos_price_usd
  ON productos (precio_usd);

CREATE INDEX IF NOT EXISTS idx_der_company_date
  ON daily_exchange_rates (company_id, rate_date DESC);

CREATE INDEX IF NOT EXISTS idx_der_company_date_valid
  ON daily_exchange_rates (company_id, rate_date DESC)
  WHERE active_rate IS NOT NULL;

ANALYZE productos;
ANALYZE daily_exchange_rates;

EXPLAIN (ANALYZE, BUFFERS)
SELECT sku, descripcion, precio_usd
FROM productos
WHERE descripcion ILIKE '%valvula%'
LIMIT 50;

