-- Paso 3 · Smoke tests · handoffGuard
-- Sin migraciones DDL: este paso es puro código aplicativo.

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 1 · Confirmar que bot_handoffs existe y tiene índice activo
-- ─────────────────────────────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'bot_handoffs';
-- ESPERADO: 1 fila

SELECT indexname FROM pg_indexes WHERE tablename = 'bot_handoffs' ORDER BY indexname;
-- ESPERADO: idx_bot_handoffs_active_unique (garantía de 1 handoff activo por chat)

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 2 · Estado actual de handoffs activos
-- ─────────────────────────────────────────────────────────────────────────────
SELECT id, chat_id, to_user_id, started_at
FROM bot_handoffs
WHERE ended_at IS NULL
ORDER BY started_at DESC
LIMIT 5;
-- Si hay filas: hay chats tomados por vendedores ahora mismo

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 3 · isHandedOver funcional (vía endpoint HTTP)
-- Ejecutar con curl o Postman:
--
--   GET /api/sales/chats/<CHAT_ID>/handoff-status
--   Header: X-Admin-Secret: <ADMIN_SECRET>  (o JWT)
--
-- Chat con handoff activo del smoke 2:
--   ESPERADO: { "is_handed_over": true, "handoff": { "id": N, "to_user_id": M, ... } }
-- Chat sin handoff:
--   ESPERADO: { "is_handed_over": false, "handoff": null }
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 4 · Verificar que guard bloquea y loguea (post-deploy con tráfico real)
-- Ejecutar tras que entre un mensaje a un chat con handoff activo
-- ─────────────────────────────────────────────────────────────────────────────
SELECT id, chat_id, action_type, output_result, created_at
FROM bot_actions
WHERE action_type = 'handoff_triggered'
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 5;
-- ESPERADO: filas con output_result->>'blocked' = 'true'

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 5 · Mensajes marcados 'skipped' en chats con handoff activo
-- ─────────────────────────────────────────────────────────────────────────────
SELECT m.id, m.chat_id, m.ai_reply_status, m.created_at
FROM crm_messages m
WHERE m.ai_reply_status = 'skipped'
  AND m.direction = 'inbound'
  AND EXISTS (
    SELECT 1 FROM bot_handoffs bh
    WHERE bh.chat_id = m.chat_id AND bh.ended_at IS NULL
  )
  AND m.created_at > NOW() - INTERVAL '1 hour'
ORDER BY m.created_at DESC
LIMIT 10;
-- ESPERADO: mensajes entrantes skipped en chats con handoff activo

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 6 · Regresión · chats SIN handoff siguen procesándose normal
-- ─────────────────────────────────────────────────────────────────────────────
SELECT m.id, m.chat_id, m.ai_reply_status
FROM crm_messages m
WHERE m.ai_reply_status IN ('ai_replied', 'pending_ai_reply', 'needs_human_review')
  AND m.direction = 'inbound'
  AND NOT EXISTS (
    SELECT 1 FROM bot_handoffs bh
    WHERE bh.chat_id = m.chat_id AND bh.ended_at IS NULL
  )
  AND m.created_at > NOW() - INTERVAL '24 hours'
ORDER BY m.created_at DESC
LIMIT 10;
-- ESPERADO: mensajes con estado normal (no skipped) en chats sin handoff

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 7 · Regresión ML questions · preguntas sin chat vinculado no bloqueadas
-- ─────────────────────────────────────────────────────────────────────────────
-- Verificar que los outcomes de ml_questions_ia_auto_log no muestran 'handoff_active'
-- para buyers sin chat WA vinculado (expected: absent or 0 rows)
SELECT outcome, COUNT(*) AS n
FROM ml_questions_ia_auto_log
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY outcome
ORDER BY n DESC;
-- 'handoff_active' aparecerá solo si hubo preguntas de buyers con chat activo tomado por vendedor

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE E2E manual (escenario de 7 pasos — documentar resultado)
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Elegir chat sin handoff
-- 2. Enviar mensaje → verificar bot responde normalmente
-- 3. POST /api/sales/chats/<ID>/take-over   → handoff activo
-- 4. Enviar otro mensaje al chat
-- 5. Verificar:
--    a) Bot NO responde (sin mensaje saliente en crm_messages con direction='outbound')
--    b) crm_messages.ai_reply_status = 'skipped' en el mensaje entrante
--    c) bot_actions: action_type = 'handoff_triggered', output_result->>'blocked' = 'true'
-- 6. POST /api/sales/chats/<ID>/return-to-bot  → handoff cerrado
-- 7. Enviar mensaje → bot responde de nuevo
