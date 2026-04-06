-- WMS — Auditoría bin_stock v2 (parche idempotente)
-- Prerequisito: sql/wms-bins.sql ejecutado.
-- Ejecutar después: psql $DATABASE_URL -f sql/wms-audit-v2.sql

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. ENUM movement_reason (incluye SYSTEM_PURGE y valores usados por Node)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  CREATE TYPE movement_reason AS ENUM (
    'PURCHASE_RECEIPT',
    'SALE_DISPATCH',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'RESERVATION',
    'RESERVATION_CANCEL',
    'ADJUSTMENT_UP',
    'ADJUSTMENT_DOWN',
    'DAMAGE',
    'RETURN',
    'SYSTEM_PURGE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE movement_reason ADD VALUE IF NOT EXISTS 'SYSTEM_PURGE';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Quitar triggers antiguos (antes de tocar columnas / función)
-- ═══════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_audit_bin_stock_change ON bin_stock;
DROP TRIGGER IF EXISTS trg_audit_bin_stock ON bin_stock;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. bin_stock: inventario cíclico
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE bin_stock
  ADD COLUMN IF NOT EXISTS last_counted_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. stock_movements_audit: evolución hacia old/new + deltas generados
--    (migración desde esquema v1: delta_* almacenados + reason TEXT)
-- ═══════════════════════════════════════════════════════════════════════════

-- 3a — Renombrar deltas “manuales” v1 (is_generated distinto de ALWAYS)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'stock_movements_audit'
      AND c.column_name = 'delta_available'
      AND COALESCE(c.is_generated, 'NEVER') <> 'ALWAYS'
  ) THEN
    ALTER TABLE stock_movements_audit RENAME COLUMN delta_available TO _audit_delta_avail_v1;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'stock_movements_audit'
      AND c.column_name = 'delta_reserved'
      AND COALESCE(c.is_generated, 'NEVER') <> 'ALWAYS'
  ) THEN
    ALTER TABLE stock_movements_audit RENAME COLUMN delta_reserved TO _audit_delta_res_v1;
  END IF;
END $$;

-- bin_stock_id sin FK: en AFTER DELETE el id ya no existe en bin_stock (referencia histórica).
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'stock_movements_audit'
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) LIKE '%bin_stock_id%'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE stock_movements_audit DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE stock_movements_audit
  ADD COLUMN IF NOT EXISTS bin_stock_id BIGINT;

ALTER TABLE stock_movements_audit
  ADD COLUMN IF NOT EXISTS old_qty_available NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS old_qty_reserved NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS new_qty_available NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS new_qty_reserved NUMERIC(18,4);

-- Backfill desde v1 (deltas históricos → old=0, new=delta)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_movements_audit' AND column_name = '_audit_delta_avail_v1'
  ) THEN
    EXECUTE $u$
      UPDATE stock_movements_audit
      SET
        old_qty_available = COALESCE(old_qty_available, 0),
        old_qty_reserved = COALESCE(old_qty_reserved, 0),
        new_qty_available = COALESCE(new_qty_available, COALESCE(_audit_delta_avail_v1, 0)),
        new_qty_reserved = COALESCE(new_qty_reserved, COALESCE(_audit_delta_res_v1, 0))
    $u$;
  ELSE
    UPDATE stock_movements_audit
    SET
      old_qty_available = COALESCE(old_qty_available, 0),
      old_qty_reserved = COALESCE(old_qty_reserved, 0),
      new_qty_available = COALESCE(new_qty_available, 0),
      new_qty_reserved = COALESCE(new_qty_reserved, 0)
    WHERE old_qty_available IS NULL OR new_qty_available IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_movements_audit' AND column_name = '_audit_delta_avail_v1'
  ) THEN
    ALTER TABLE stock_movements_audit DROP COLUMN IF EXISTS _audit_delta_avail_v1;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_movements_audit' AND column_name = '_audit_delta_res_v1'
  ) THEN
    ALTER TABLE stock_movements_audit DROP COLUMN IF EXISTS _audit_delta_res_v1;
  END IF;
END $$;

-- reason: TEXT → ENUM (valores desconocidos → ADJUSTMENT_UP)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movements_audit'
      AND column_name = 'reason'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE stock_movements_audit
      ALTER COLUMN reason TYPE movement_reason USING (
        CASE
          WHEN reason IS NULL THEN 'ADJUSTMENT_UP'::movement_reason
          WHEN reason IN (
            'PURCHASE_RECEIPT', 'SALE_DISPATCH', 'TRANSFER_IN', 'TRANSFER_OUT',
            'RESERVATION', 'RESERVATION_CANCEL', 'ADJUSTMENT_UP', 'ADJUSTMENT_DOWN',
            'DAMAGE', 'RETURN', 'SYSTEM_PURGE'
          ) THEN reason::movement_reason
          ELSE 'ADJUSTMENT_UP'::movement_reason
        END
      );
  END IF;
END $$;

-- user_id: TEXT → INTEGER (inválidos → NULL)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movements_audit'
      AND column_name = 'user_id'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE stock_movements_audit
      ALTER COLUMN user_id TYPE INTEGER USING (
        CASE
          WHEN user_id IS NULL OR trim(user_id::text) = '' THEN NULL
          WHEN trim(user_id::text) ~ '^[0-9]+$' THEN trim(user_id::text)::integer
          ELSE NULL
        END
      );
  END IF;
END $$;

ALTER TABLE stock_movements_audit
  ALTER COLUMN old_qty_available SET NOT NULL,
  ALTER COLUMN old_qty_reserved SET NOT NULL,
  ALTER COLUMN new_qty_available SET NOT NULL,
  ALTER COLUMN new_qty_reserved SET NOT NULL;

-- Deltas generados (solo si no existen ya como generados)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movements_audit'
      AND column_name = 'delta_available'
  ) THEN
    ALTER TABLE stock_movements_audit
      ADD COLUMN delta_available NUMERIC(18,4)
        GENERATED ALWAYS AS (new_qty_available - old_qty_available) STORED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movements_audit'
      AND column_name = 'delta_reserved'
  ) THEN
    ALTER TABLE stock_movements_audit
      ADD COLUMN delta_reserved NUMERIC(18,4)
        GENERATED ALWAYS AS (new_qty_reserved - old_qty_reserved) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sma_bin_stock_id ON stock_movements_audit (bin_stock_id)
  WHERE bin_stock_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Función del trigger (INSERT + UPDATE + DELETE)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION audit_bin_stock_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_reason          movement_reason;
  v_reference_id    TEXT;
  v_reference_type  TEXT;
  v_user_id         INTEGER;
  v_notes           TEXT;
  v_raw_reason      TEXT;
  v_old_available   NUMERIC(18,4);
  v_old_reserved    NUMERIC(18,4);
  v_new_available   NUMERIC(18,4);
  v_new_reserved    NUMERIC(18,4);
  v_bin_stock_id    BIGINT;
  v_bin_id          BIGINT;
  v_sku             TEXT;
BEGIN
  v_raw_reason     := current_setting('app.movement_reason', TRUE);
  v_reference_id   := current_setting('app.reference_id', TRUE);
  v_reference_type := current_setting('app.reference_type', TRUE);
  v_user_id        := NULLIF(current_setting('app.user_id', TRUE), '')::INTEGER;
  v_notes          := current_setting('app.movement_notes', TRUE);

  BEGIN
    v_reason := COALESCE(NULLIF(v_raw_reason, ''), 'ADJUSTMENT_UP')::movement_reason;
  EXCEPTION WHEN invalid_text_representation THEN
    v_reason := 'ADJUSTMENT_UP';
    v_notes  := 'WARN: reason desconocido "' || COALESCE(v_raw_reason, '')
                || '". ' || COALESCE(v_notes, '');
  END;

  IF TG_OP = 'INSERT' THEN
    v_bin_stock_id  := NEW.id;
    v_bin_id        := NEW.bin_id;
    v_sku           := NEW.producto_sku;
    v_old_available := 0;
    v_old_reserved  := 0;
    v_new_available := NEW.qty_available;
    v_new_reserved  := NEW.qty_reserved;
    IF NULLIF(v_raw_reason, '') IS NULL THEN
      v_reason := 'PURCHASE_RECEIPT';
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.qty_available IS NOT DISTINCT FROM NEW.qty_available
       AND OLD.qty_reserved IS NOT DISTINCT FROM NEW.qty_reserved
    THEN
      RETURN NEW;
    END IF;

    v_bin_stock_id  := NEW.id;
    v_bin_id        := NEW.bin_id;
    v_sku           := NEW.producto_sku;
    v_old_available := OLD.qty_available;
    v_old_reserved  := OLD.qty_reserved;
    v_new_available := NEW.qty_available;
    v_new_reserved  := NEW.qty_reserved;

  ELSIF TG_OP = 'DELETE' THEN
    v_bin_stock_id  := OLD.id;
    v_bin_id        := OLD.bin_id;
    v_sku           := OLD.producto_sku;
    v_old_available := OLD.qty_available;
    v_old_reserved  := OLD.qty_reserved;
    v_new_available := 0;
    v_new_reserved  := 0;
    IF NULLIF(v_raw_reason, '') IS NULL THEN
      v_reason := 'SYSTEM_PURGE';
      v_notes  := 'CASCADE desde warehouse_bins. ' || COALESCE(v_notes, '');
    END IF;
    v_notes := 'FILA ELIMINADA. ' || COALESCE(v_notes, '');

  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  INSERT INTO stock_movements_audit (
    bin_stock_id, bin_id, producto_sku, reason,
    old_qty_available, old_qty_reserved,
    new_qty_available, new_qty_reserved,
    reference_id, reference_type, user_id, notes
  ) VALUES (
    v_bin_stock_id, v_bin_id, v_sku, v_reason,
    v_old_available, v_old_reserved,
    v_new_available, v_new_reserved,
    NULLIF(v_reference_id, ''),
    NULLIF(v_reference_type, ''),
    v_user_id,
    NULLIF(v_notes, '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_bin_stock
  AFTER INSERT
     OR UPDATE OF qty_available, qty_reserved
     OR DELETE
  ON bin_stock
  FOR EACH ROW
  EXECUTE FUNCTION audit_bin_stock_change();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Verificación (comentarios; ejecutar manualmente)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT trigger_name, event_manipulation
-- FROM information_schema.triggers
-- WHERE event_object_table = 'bin_stock' AND trigger_name = 'trg_audit_bin_stock'
-- ORDER BY event_manipulation;
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'stock_movements_audit'
--   AND column_name IN ('delta_available','delta_reserved');
--
-- SELECT enumlabel FROM pg_enum
-- JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
-- WHERE pg_type.typname = 'movement_reason'
-- ORDER BY enumsortorder;
