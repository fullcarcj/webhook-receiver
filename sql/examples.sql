-- Catálogo paginado con precio Bs del día, filtrable por búsqueda
SELECT
  v.sku,
  v.name,
  v.price_usd,
  v.price_bs,
  v.price_bs_bcv,
  v.price_bs_binance,
  v.active_rate_type,
  v.spread_alert_triggered,
  v.rate_date
FROM v_product_prices_bs v
WHERE v.company_id = 1
  AND ($1::text IS NULL OR v.name ILIKE '%' || $1 || '%' OR v.sku ILIKE '%' || $1 || '%')
ORDER BY v.name
LIMIT $2 OFFSET $3;

-- Historial de tasas con brecha BCV/Binance
SELECT
  rate_date,
  bcv_rate,
  binance_rate,
  adjusted_rate,
  active_rate_type,
  active_rate,
  spread_current_pct,
  spread_alert_triggered,
  is_manual_override,
  overridden_by_user_id,
  override_reason
FROM daily_exchange_rates
WHERE company_id = $1
  AND rate_date BETWEEN $2 AND $3
ORDER BY rate_date DESC
LIMIT $4 OFFSET $5;

