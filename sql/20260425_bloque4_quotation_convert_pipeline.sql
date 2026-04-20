-- Bloque 4 · inventario_presupuesto: conversión formal + pipeline Kanban
-- Idempotente. Ejecutar: npm run db:quotation-convert-pipeline
-- Pre-requisito: sql/20260419_sprint1_presupuesto_extensions.sql

BEGIN;

-- 1. Columnas de conversión formal
ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS conversion_document_id  TEXT,
  ADD COLUMN IF NOT EXISTS conversion_note          TEXT,
  ADD COLUMN IF NOT EXISTS converted_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_by             INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN inventario_presupuesto.conversion_document_id IS
  'ID del documento formal que certifica la conversión: N° de orden, referencia de pago, nota de entrega, etc.';
COMMENT ON COLUMN inventario_presupuesto.converted_by IS
  'Usuario que registró la conversión.';

-- 2. Pipeline Kanban: etapa visible en el tablero de seguimiento
--    Valores: lead | quoted | negotiating | accepted | converted | lost
ALTER TABLE inventario_presupuesto
  ADD COLUMN IF NOT EXISTS pipeline_stage TEXT NOT NULL DEFAULT 'lead';

ALTER TABLE inventario_presupuesto
  DROP CONSTRAINT IF EXISTS inv_presupuesto_pipeline_stage_chk;
ALTER TABLE inventario_presupuesto
  ADD CONSTRAINT inv_presupuesto_pipeline_stage_chk
  CHECK (pipeline_stage IN ('lead', 'quoted', 'negotiating', 'accepted', 'converted', 'lost'));

COMMENT ON COLUMN inventario_presupuesto.pipeline_stage IS
  'Etapa en el pipeline Kanban de seguimiento de cotizaciones.
   lead=contacto inicial · quoted=enviada · negotiating=en negociación
   accepted=aprobada · converted=cerrada con documento · lost=perdida/descartada';

-- 3. Índice para el tablero Kanban (filtra por stage + fecha)
CREATE INDEX IF NOT EXISTS idx_inv_presupuesto_pipeline
  ON inventario_presupuesto (pipeline_stage, fecha_creacion DESC)
  WHERE pipeline_stage NOT IN ('converted', 'lost');

-- 4. Backfill: cotizaciones existentes quedan en etapa según su status actual
UPDATE inventario_presupuesto SET pipeline_stage = 'quoted'
  WHERE status = 'sent' AND pipeline_stage = 'lead';

UPDATE inventario_presupuesto SET pipeline_stage = 'converted'
  WHERE status = 'converted' AND pipeline_stage = 'lead';

UPDATE inventario_presupuesto SET pipeline_stage = 'lost'
  WHERE status IN ('cancelled_by_buyer', 'cancelled_by_operator', 'expired')
    AND pipeline_stage = 'lead';

COMMIT;

-- Rollback:
-- BEGIN;
-- ALTER TABLE inventario_presupuesto
--   DROP COLUMN IF EXISTS conversion_document_id,
--   DROP COLUMN IF EXISTS conversion_note,
--   DROP COLUMN IF EXISTS converted_at,
--   DROP COLUMN IF EXISTS converted_by,
--   DROP COLUMN IF EXISTS pipeline_stage;
-- DROP INDEX IF EXISTS idx_inv_presupuesto_pipeline;
-- COMMIT;
