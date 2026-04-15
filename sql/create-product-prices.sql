-- Snapshots de precio por producto y canal (BCV / Binance / tasa ajustada en paralelo).
-- Ejecutar: npm run db:product-prices
-- Prerrequisito: tabla products(id).

CREATE TABLE IF NOT EXISTS product_prices (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
    -- valores: 'mostrador' | 'whatsapp' | 'ml' | 'ecommerce'

  -- PRECIO BASE EN USD (calculado con Binance + políticas)
  price_usd NUMERIC NOT NULL,

  -- PRECIO EN BS POR CADA TASA (las tres simultáneas)
  price_bs_bcv      NUMERIC NOT NULL,
  price_bs_binance  NUMERIC NOT NULL,
  price_bs_ajuste   NUMERIC NOT NULL,

  -- SNAPSHOT DE COSTOS AL MOMENTO DEL CÁLCULO
  landed_cost_usd     NUMERIC NOT NULL,
  costo_operativo_usd NUMERIC NOT NULL,

  -- SNAPSHOT DE TASAS USADAS
  bcv_rate      NUMERIC NOT NULL,
  binance_rate  NUMERIC NOT NULL,
  adjusted_rate NUMERIC NOT NULL,
  rate_date     DATE NOT NULL,

  -- MÁRGENES CALCULADOS
  margin_usd NUMERIC NOT NULL,
  margin_pct NUMERIC NOT NULL,

  -- TRAZABILIDAD COMPLETA
  policy_snapshot JSONB NOT NULL,
    -- copia de financial_settings + pricing_policies
    -- usados en el cálculo
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (product_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_product_prices_product
  ON product_prices (product_id);

CREATE INDEX IF NOT EXISTS idx_product_prices_channel
  ON product_prices (channel);

CREATE INDEX IF NOT EXISTS idx_product_prices_rate_date
  ON product_prices (rate_date);

CREATE INDEX IF NOT EXISTS idx_product_prices_calculated
  ON product_prices (calculated_at);

COMMENT ON TABLE product_prices IS 'Precios por canal; tres columnas Bs (BCV, Binance, ajuste) + snapshot de tasas y políticas.';
