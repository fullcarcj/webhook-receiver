-- Marca manual "atendido" cuando el vendedor respondió fuera del hilo (no hay outbound en crm_messages).
-- El badge "pendiente" usa: último mensaje inbound Y (sin marca O mensaje posterior a la marca).
-- Ejecutar: npm run db:crm-chats-marked-attended

ALTER TABLE crm_chats
  ADD COLUMN IF NOT EXISTS marked_attended_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN crm_chats.marked_attended_at IS
  'Operador marcó el hilo como atendido (p. ej. respuesta en ML/app externa). '
  'Se oculta el pendiente hasta que llegue un inbound con created_at posterior a esta marca.';
