-- Inbox cotizaciones: extiende inventario_presupuesto con chat, canal y auditoría.
-- Requiere: crm_chats, sales_channels, users, inventario_presupuesto (existente).
-- Idempotente. Ejecutar: npm run db:presupuesto-inbox

ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS chat_id BIGINT
    REFERENCES crm_chats(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel_id SMALLINT
    REFERENCES sales_channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by INTEGER
    REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventario_presupuesto'
      AND column_name = 'updated_at'
  ) THEN
    EXECUTE 'ALTER TABLE inventario_presupuesto
             ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_chat
  ON inventario_presupuesto (chat_id)
  WHERE chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_channel
  ON inventario_presupuesto (channel_id)
  WHERE channel_id IS NOT NULL;

-- Verificación manual:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'inventario_presupuesto'
--   AND column_name IN ('chat_id','channel_id','created_by');
-- SELECT DISTINCT status FROM inventario_presupuesto LIMIT 50;
