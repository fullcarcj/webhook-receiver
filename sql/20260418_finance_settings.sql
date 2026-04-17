-- Módulo Finanzas — tabla de configuración clave/valor (tolerancias, IGTF, flags).
-- Idempotente: CREATE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS finance_settings (
  id            BIGSERIAL PRIMARY KEY,
  setting_key   TEXT NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  value_type    TEXT NOT NULL DEFAULT 'string'
    CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  description   TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    TEXT
);

INSERT INTO finance_settings
  (setting_key, setting_value, value_type, description)
VALUES
  ('igtf_rate_pct', '3.00', 'number',
   'Tasa IGTF en porcentaje'),
  ('tolerance_usd', '0.50', 'number',
   'Tolerancia de discrepancia en USD'),
  ('auto_reconcile_enabled', 'true', 'boolean',
   'Activar conciliación automática'),
  ('alert_unjustified_days', '3', 'number',
   'Días sin justificar antes de alerta'),
  ('igtf_applies_to',
   '["USD_CASH","ZELLE","BINANCE","PANAMA"]',
   'json',
   'Métodos de pago que generan IGTF')
ON CONFLICT (setting_key) DO NOTHING;
