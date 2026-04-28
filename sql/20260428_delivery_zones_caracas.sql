-- Zonas de delivery Caracas — precios en USD; conversión a Bs con tasa BCV activa.
-- base_cost_bs / client_price_bs se usan como placeholder numérico (= USD price).
-- La UI convierte a Bs en tiempo real usando la tasa del día.
-- Ejecutar: npm run db:delivery-zones-caracas
-- Idempotente (ON CONFLICT DO UPDATE).

INSERT INTO delivery_zones
  (zone_name, description, base_cost_usd, base_cost_bs, client_price_bs, currency_pago, estimated_minutes, is_active)
VALUES
  (
    'Tarifa S · Plaza Venezuela - Chacaito',
    'Cobertura: Plaza Venezuela, Sabana Grande, Chacaito y zonas aledañas.',
    2.00, 2.00, 2.00, 'USD', 30, TRUE
  ),
  (
    'Tarifa M · Capitolio - Altamira',
    'Cobertura: Capitolio, El Silencio, Bello Monte, La Castellana, Altamira.',
    3.00, 3.00, 3.00, 'USD', 45, TRUE
  ),
  (
    'Tarifa L · Agua Salud - La California',
    'Cobertura: Agua Salud, El Paraíso, Los Chaguaramos, Santa Eduvigis, La California.',
    4.00, 4.00, 4.00, 'USD', 60, TRUE
  ),
  (
    'Tarifa XL · Propatria - Petare',
    'Cobertura: Propatria, Caricuao, El Valle, Coche, Petare y zonas limítrofes.',
    5.00, 5.00, 5.00, 'USD', 75, TRUE
  ),
  (
    'Tarifa XXL · Los Teques - La Guaira',
    'Cobertura: Los Teques, Guarenas, Guatire, Maiquetía, La Guaira y Miranda-costa.',
    12.00, 12.00, 12.00, 'USD', 120, TRUE
  )
ON CONFLICT (zone_name) DO UPDATE
  SET description      = EXCLUDED.description,
      base_cost_usd    = EXCLUDED.base_cost_usd,
      base_cost_bs     = EXCLUDED.base_cost_bs,
      client_price_bs  = EXCLUDED.client_price_bs,
      currency_pago    = EXCLUDED.currency_pago,
      estimated_minutes= EXCLUDED.estimated_minutes,
      is_active        = EXCLUDED.is_active,
      updated_at       = NOW();
