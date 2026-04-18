-- Paso 2 · Smoke tests · exceptions + bot_actions
-- Ejecutar tras: npm run db:bot-actions && npm run db:exceptions

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 1 · Tablas creadas (debe devolver 2 filas)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('exceptions', 'bot_actions')
ORDER BY table_name;
-- ESPERADO: bot_actions · exceptions

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 2 · Índices creados (debe haber al menos 7)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT tablename, indexname
FROM pg_indexes
WHERE tablename IN ('exceptions', 'bot_actions')
ORDER BY tablename, indexname;

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 3 · CHECK constraints (debe haber 4: 1 de bot_actions + 3 de exceptions)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('exceptions'::regclass, 'bot_actions'::regclass)
  AND contype = 'c'
ORDER BY conname;

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 4 · Insert + countOpen de exceptions
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO exceptions (entity_type, entity_id, reason, severity, context)
VALUES ('payment', 999999, 'smoke_test_paso2', 'low', '{"test": true}'::jsonb)
RETURNING id, status, created_at;
-- Anotar el id devuelto

SELECT COUNT(*)::int AS open_count FROM exceptions WHERE status = 'open';
-- Debe incluir la fila del smoke

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 5 · Trigger updated_at (updated_at debe actualizarse al resolver)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE exceptions
SET status          = 'resolved',
    resolved_by     = (SELECT id FROM users LIMIT 1),
    resolved_at     = NOW(),
    resolution_note = 'Smoke test cleanup Paso 2'
WHERE reason = 'smoke_test_paso2';

SELECT id, status, resolved_at, updated_at,
       (updated_at >= resolved_at) AS trigger_ok
FROM exceptions
WHERE reason = 'smoke_test_paso2';
-- ESPERADO: trigger_ok = true

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 6 · Limpieza del smoke
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM exceptions WHERE reason = 'smoke_test_paso2';

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 7 · Insert de bot_action
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO bot_actions (action_type, provider, confidence)
VALUES ('payment_reconciled', 'smoke_test', 0.99)
RETURNING id, action_type, created_at;

DELETE FROM bot_actions WHERE provider = 'smoke_test';

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 8 · Verificar inboxService devuelve exceptions real
-- (ejecutar via HTTP: GET /api/inbox/counts y verificar que "exceptions" viene del query)
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT COUNT(*)::int FROM exceptions WHERE status = 'open';
-- Comparar con el campo "exceptions" de /api/inbox/counts

-- ─────────────────────────────────────────────────────────────────────────────
-- SMOKE 9 · bot_actions del motor (tras deploy + match real o L3 real)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT action_type, COUNT(*) AS n
FROM bot_actions
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY action_type
ORDER BY n DESC;
-- Post-deploy: aparecerá payment_reconciled (L1/L2) o manual_review_required (L3)
