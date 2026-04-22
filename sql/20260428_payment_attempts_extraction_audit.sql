-- Auditoría de extracción Gemini (comprobantes) para ops-logs y soporte.
-- Ejecutar: npm run db:payment-attempts-extraction-audit
-- Requiere: payment_attempts (20260412 u otra base equivalente).

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS extraction_status TEXT;

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS extraction_error TEXT;

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS extraction_raw_snippet TEXT;

COMMENT ON COLUMN payment_attempts.extraction_status IS
  'Resultado pipeline visión: ok | parsed_empty | download_failed | vision_error | json_parse | empty_response | invalid_shape';
COMMENT ON COLUMN payment_attempts.extraction_error IS
  'Mensaje de error o explicación corta (fallo API, parseo JSON, etc.)';
COMMENT ON COLUMN payment_attempts.extraction_raw_snippet IS
  'Recorte de la respuesta del modelo cuando falla el parseo JSON (solo diagnóstico)';
