-- Anti-spam Wasender: registro de envíos para deduplicación y rate limit por tipo.
-- Ejecutar: npm run db:wa-anti-spam  (o scripts/run-sql-file-pg.js)
-- Mantenimiento: purgar registros con sent_at < now() - interval '30 days' periódicamente (ver src/services/waAntiSpam.js).

DO $$
BEGIN
  CREATE TYPE wa_message_type AS ENUM ('REMINDER', 'MARKETING', 'CRITICAL', 'CHAT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS wa_sent_messages_log (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NULL REFERENCES customers (id) ON DELETE SET NULL,
  phone_e164 TEXT NOT NULL,
  message_type wa_message_type NOT NULL,
  content_hash CHAR(64) NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Búsqueda del último envío por teléfono + ventana temporal (purga / monitoreo)
CREATE INDEX IF NOT EXISTS idx_wa_sent_log_phone_sent
  ON wa_sent_messages_log (phone_e164, sent_at DESC);

-- Anti-duplicado 24h: mismo hash al mismo destino
CREATE INDEX IF NOT EXISTS idx_wa_sent_log_phone_hash_sent
  ON wa_sent_messages_log (phone_e164, content_hash, sent_at DESC);

-- Opcional: reportes por cliente
CREATE INDEX IF NOT EXISTS idx_wa_sent_log_customer_sent
  ON wa_sent_messages_log (customer_id, sent_at DESC)
  WHERE customer_id IS NOT NULL;

-- Recordatorios diarios (rate limit REMINDER por día en zona Caracas — filtro en query)
CREATE INDEX IF NOT EXISTS idx_wa_sent_log_reminder_phone_sent
  ON wa_sent_messages_log (phone_e164, sent_at DESC)
  WHERE message_type = 'REMINDER';

COMMENT ON TABLE wa_sent_messages_log IS 'Log de envíos Wasender para anti-spam; purgar >30 días en operación.';
