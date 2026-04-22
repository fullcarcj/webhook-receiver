-- Bloque 5 · Chats internos "NO CLIENTE" (personal de empresa)
-- Idempotente. Ejecutar: npm run db:internal-chat-mode
--
-- Extiende operational_phone_whitelist con modo 'ignore' (comportamiento previo)
-- y 'muted' (aparece en bandeja marcado como NO CLIENTE, sin pipeline de ventas).
-- Añade is_operational a crm_chats para lookup O(1) sin JOIN en caliente.

BEGIN;

-- 1. Columna mode en whitelist (DEFAULT 'ignore' preserva comportamiento previo)
ALTER TABLE operational_phone_whitelist
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'ignore'
    CONSTRAINT opwl_mode_check CHECK (mode IN ('ignore', 'muted'));

COMMENT ON COLUMN operational_phone_whitelist.mode IS
  'ignore = no crea chat (comportamiento original);
   muted  = crea chat pero marcado is_operational=true (persona interna / NO CLIENTE).';

-- 2. Flag is_operational en crm_chats
ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS is_operational BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN crm_chats.is_operational IS
  'TRUE cuando el número está en operational_phone_whitelist con mode=''muted''.
   Esos chats aparecen en bandeja con etiqueta NO CLIENTE y sin pipeline de ventas.';

CREATE INDEX IF NOT EXISTS idx_crm_chats_operational
  ON crm_chats (is_operational)
  WHERE is_operational = TRUE;

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE operational_phone_whitelist DROP COLUMN IF EXISTS mode;
-- ALTER TABLE crm_chats DROP COLUMN IF EXISTS is_operational;
-- COMMIT;
