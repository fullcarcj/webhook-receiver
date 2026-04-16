-- Sugerencias de identidad (vendedor confirma en UI). Ejecutar: npm run db:crm-candidates

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS identity_candidates JSONB;

COMMENT ON COLUMN crm_chats.identity_candidates IS
  'JSON: phoneMatches, mlBuyerMatches, keywordHint — sin cambiar identity_status a declared por sugerencias.';
