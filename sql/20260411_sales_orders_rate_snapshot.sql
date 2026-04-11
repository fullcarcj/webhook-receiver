-- Snapshot de tasa completo en sales_orders: alinea con el triplete de purchases/sales POS.
-- Prerrequisito: sql/20260409_sales_global.sql (columnas total_amount_bs, exchange_rate_bs_per_usd)
-- Ejecutar: npm run db:sales-rate-snapshot

-- Tipo enumerado ya existe en la BD (creado por exchange-rates.sql).
-- Intentamos agregar las columnas; si ya existen, DO NOTHING.
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS rate_type TEXT,
  ADD COLUMN IF NOT EXISTS rate_date DATE;

-- Retroalimentar las filas existentes que ya tienen exchange_rate_bs_per_usd pero no rate_type/rate_date:
-- tomamos la tasa activa más reciente como aproximación (es un backfill de datos históricos).
UPDATE sales_orders so
SET
  rate_type = COALESCE(
    (SELECT active_rate_type::text FROM daily_exchange_rates
     WHERE rate_date <= so.created_at::date
     ORDER BY rate_date DESC LIMIT 1),
    'BCV'
  ),
  rate_date = COALESCE(
    (SELECT rate_date FROM daily_exchange_rates
     WHERE rate_date <= so.created_at::date
     ORDER BY rate_date DESC LIMIT 1),
    so.created_at::date
  )
WHERE exchange_rate_bs_per_usd IS NOT NULL
  AND rate_type IS NULL;

COMMENT ON COLUMN sales_orders.rate_type IS 'Tipo de tasa usada al crear la orden (BCV, BINANCE, ADJUSTED)';
COMMENT ON COLUMN sales_orders.rate_date IS 'Fecha de la tasa usada al crear la orden';
