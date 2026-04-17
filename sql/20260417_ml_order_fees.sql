-- ============================================================
-- Módulo: Rentabilidad por orden ML
-- Agrega columnas de fees/comisiones a sales_orders para
-- calcular el payout neto real de cada venta en ML.
-- Idempotente (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS ml_sale_fee_usd      NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS ml_shipping_cost_usd NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS ml_taxes_usd         NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS ml_payout_usd        NUMERIC(20,2);

COMMENT ON COLUMN sales_orders.ml_sale_fee_usd
  IS 'Comisión ML por la venta (marketplace fee, extraído de payments[0].sale_fee o fee_details)';
COMMENT ON COLUMN sales_orders.ml_shipping_cost_usd
  IS 'Costo de envío cobrado por ML al vendedor (order.shipping.cost)';
COMMENT ON COLUMN sales_orders.ml_taxes_usd
  IS 'Retenciones fiscales aplicadas por ML (order.taxes.amount)';
COMMENT ON COLUMN sales_orders.ml_payout_usd
  IS 'Neto real recibido: total_paid_amount - ml_sale_fee - ml_shipping_cost - ml_taxes';

-- Índice para acelerar las queries de rentabilidad por período
CREATE INDEX IF NOT EXISTS idx_sales_orders_ml_fees
  ON sales_orders(source, created_at, ml_payout_usd)
  WHERE source = 'mercadolibre';
