-- Columnas para media en crm_messages + índices para consultas por tipo y transcripción.
-- Ejecutar: npm run db:crm-messages-media

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS file_size     BIGINT,
  ADD COLUMN IF NOT EXISTS duration_sec  INT,
  ADD COLUMN IF NOT EXISTS transcription TEXT;

CREATE INDEX IF NOT EXISTS idx_crm_messages_media_type
  ON crm_messages (type, created_at DESC)
  WHERE type IN ('image', 'audio', 'video', 'document', 'sticker');

CREATE INDEX IF NOT EXISTS idx_crm_messages_transcription
  ON crm_messages (customer_id, created_at DESC)
  WHERE transcription IS NOT NULL;
