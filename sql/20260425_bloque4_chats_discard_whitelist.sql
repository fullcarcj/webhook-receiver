-- Bloque 4 · crm_chats: descarte de ruido + whitelist operativo
-- Idempotente. Ejecutar: npm run db:chats-discard-whitelist

BEGIN;

-- 1. Descarte de ruido en crm_chats (columnas aditivas, no toca status omnicanal)
ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS discarded_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS discard_note   TEXT,
  ADD COLUMN IF NOT EXISTS discarded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN crm_chats.discarded_at IS
  'Momento en que un operador marcó el chat como ruido. NULL = no descartado.';
COMMENT ON COLUMN crm_chats.discard_note IS
  'Nota obligatoria del operador explicando por qué es ruido.';

CREATE INDEX IF NOT EXISTS idx_crm_chats_discarded
  ON crm_chats (discarded_at DESC)
  WHERE discarded_at IS NOT NULL;

-- 2. Whitelist de números operativos (propietario, admin, pruebas)
CREATE TABLE IF NOT EXISTS operational_phone_whitelist (
  id          BIGSERIAL    PRIMARY KEY,
  phone       TEXT         NOT NULL UNIQUE,
  label       TEXT,
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE operational_phone_whitelist IS
  'Números de teléfono que el sistema omnicanal ignora al crear chats: propietario, admin, pruebas.
   El hook de mlInboxBridge y whatsapp/processors/messages verifica esta tabla antes de upsert.';

CREATE INDEX IF NOT EXISTS idx_opwl_phone
  ON operational_phone_whitelist (phone);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS operational_phone_whitelist;
-- ALTER TABLE crm_chats
--   DROP COLUMN IF EXISTS discarded_at,
--   DROP COLUMN IF EXISTS discard_note,
--   DROP COLUMN IF EXISTS discarded_by;
-- COMMIT;
