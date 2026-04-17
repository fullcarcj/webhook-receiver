-- Aclara que finance_settings y financial_settings no son duplicados:
-- - finance_settings: pares clave/valor (IGTF global, tolerancia caja, etc.)
-- - financial_settings: parámetros del motor de precios por empresa
COMMENT ON TABLE finance_settings IS 'Configuración financiera genérica (setting_key/setting_value); distinta de financial_settings (motor de precios).';
COMMENT ON TABLE financial_settings IS 'Parámetros del motor de precios por company_id; distinta de finance_settings (KV).';
