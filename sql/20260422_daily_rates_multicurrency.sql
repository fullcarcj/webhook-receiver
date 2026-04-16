-- Ferrari ERP — Extensión multi-moneda en daily_exchange_rates
-- Agrega from_currency / to_currency con defaults backward-compatible.
-- Requiere: currency-management.sql, 20260422_companies_branches.sql (currencies)
-- Idempotente. El scraper BCV y currencyService.js siguen funcionando sin cambios.
-- CRÍTICO: NO modifica ni elimina la constraint uq_company_rate_date
--          que usa currencyService.js en los INSERT ... ON CONFLICT.

ALTER TABLE daily_exchange_rates
  ADD COLUMN IF NOT EXISTS from_currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS to_currency   TEXT NOT NULL DEFAULT 'VES';

-- Índice compuesto para consultas "tasa a una fecha exacta por par de monedas"
-- Habilita: getExchangeRate(company_id, 'USD', 'VES', '2025-10-01')
CREATE INDEX IF NOT EXISTS idx_der_company_pair_date
  ON daily_exchange_rates (company_id, from_currency, to_currency, rate_date DESC)
  WHERE active_rate IS NOT NULL;

-- Comentarios de intención (no hardcodear pares en lógica de negocio)
COMMENT ON COLUMN daily_exchange_rates.from_currency
  IS 'Moneda origen. Default USD — único par soportado por el scraper BCV.';
COMMENT ON COLUMN daily_exchange_rates.to_currency
  IS 'Moneda destino. Default VES — usar currencies.code como referencia.';
