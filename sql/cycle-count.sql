-- Conteo cíclico de inventario (Ferrari ERP / WMS)
-- Prerrequisitos: sql/wms-bins.sql, sql/wms-audit-v2.sql (trg_audit_bin_stock, movement_reason)
-- Los ajustes usan set_config('app.*') para que audit_bin_stock_change registre reference_type = cycle_count.
-- psql $DATABASE_URL -f sql/cycle-count.sql

-- ═══════════════════════════════════════════════════════════════════════════
-- ENUMs
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  CREATE TYPE count_session_mode AS ENUM ('BY_AISLE', 'BY_SKU', 'BY_BIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE count_session_status AS ENUM (
    'DRAFT',
    'IN_PROGRESS',
    'PENDING_APPROVAL',
    'COMPLETED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE count_line_status AS ENUM (
    'PENDING',
    'COUNTED',
    'MATCHED',
    'DISCREPANCY',
    'ADJUSTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Config (una sola fila id=1; notas operativas — sin umbral de auto-aprobación)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS count_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT only_one_row CHECK (id = 1)
);

INSERT INTO count_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_count_config_updated_at ON count_config;
CREATE TRIGGER trg_count_config_updated_at
  BEFORE UPDATE ON count_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Sesiones y líneas
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS count_sessions (
  id               BIGSERIAL PRIMARY KEY,
  mode             count_session_mode   NOT NULL,
  reference_name   TEXT                 NOT NULL,
  aisle_id         BIGINT REFERENCES warehouse_aisles(id) ON DELETE SET NULL,
  filter_sku       TEXT,
  filter_bin_id    BIGINT REFERENCES warehouse_bins(id) ON DELETE SET NULL,
  status           count_session_status NOT NULL DEFAULT 'DRAFT',
  created_by       INTEGER,
  approved_by      INTEGER,
  approved_at      TIMESTAMPTZ,
  approval_notes   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_count_sessions_status ON count_sessions (status);

DROP TRIGGER IF EXISTS trg_count_sessions_updated_at ON count_sessions;
CREATE TRIGGER trg_count_sessions_updated_at
  BEFORE UPDATE ON count_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS count_lines (
  id                    BIGSERIAL PRIMARY KEY,
  session_id            BIGINT NOT NULL REFERENCES count_sessions(id) ON DELETE CASCADE,
  bin_id                BIGINT NOT NULL REFERENCES warehouse_bins(id) ON DELETE CASCADE,
  producto_sku          TEXT   NOT NULL,
  qty_system            NUMERIC(18,4) NOT NULL,
  qty_counted           NUMERIC(18,4),
  difference_value_usd  NUMERIC(12,4),
  status                count_line_status NOT NULL DEFAULT 'PENDING',
  counted_at            TIMESTAMPTZ,
  counted_by            INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_count_line_session_bin_sku UNIQUE (session_id, bin_id, producto_sku)
);

CREATE INDEX IF NOT EXISTS idx_count_lines_session ON count_lines (session_id);
CREATE INDEX IF NOT EXISTS idx_count_lines_status ON count_lines (session_id, status);

DROP TRIGGER IF EXISTS trg_count_lines_updated_at ON count_lines;
CREATE TRIGGER trg_count_lines_updated_at
  BEFORE UPDATE ON count_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- generate_count_lines: snapshot qty_system = bin_stock.qty_available
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION generate_count_lines(p_session_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_sess   count_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_sess FROM count_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesión % no encontrada', p_session_id;
  END IF;
  IF v_sess.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Sesión % no está en DRAFT (status=%)', p_session_id, v_sess.status;
  END IF;

  IF v_sess.mode = 'BY_AISLE' THEN
    IF v_sess.aisle_id IS NULL THEN
      RAISE EXCEPTION 'BY_AISLE requiere aisle_id';
    END IF;
    INSERT INTO count_lines (session_id, bin_id, producto_sku, qty_system, status)
    SELECT p_session_id, bs.bin_id, bs.producto_sku, bs.qty_available, 'PENDING'::count_line_status
    FROM bin_stock bs
    JOIN warehouse_bins wb ON wb.id = bs.bin_id
    JOIN warehouse_shelves ws ON ws.id = wb.shelf_id
    WHERE ws.aisle_id = v_sess.aisle_id
    ON CONFLICT (session_id, bin_id, producto_sku) DO NOTHING;
  ELSIF v_sess.mode = 'BY_SKU' THEN
    IF v_sess.filter_sku IS NULL OR btrim(v_sess.filter_sku) = '' THEN
      RAISE EXCEPTION 'BY_SKU requiere filter_sku';
    END IF;
    INSERT INTO count_lines (session_id, bin_id, producto_sku, qty_system, status)
    SELECT p_session_id, bs.bin_id, bs.producto_sku, bs.qty_available, 'PENDING'::count_line_status
    FROM bin_stock bs
    WHERE bs.producto_sku = v_sess.filter_sku
    ON CONFLICT (session_id, bin_id, producto_sku) DO NOTHING;
  ELSIF v_sess.mode = 'BY_BIN' THEN
    IF v_sess.filter_bin_id IS NULL THEN
      RAISE EXCEPTION 'BY_BIN requiere filter_bin_id';
    END IF;
    INSERT INTO count_lines (session_id, bin_id, producto_sku, qty_system, status)
    SELECT p_session_id, bs.bin_id, bs.producto_sku, bs.qty_available, 'PENDING'::count_line_status
    FROM bin_stock bs
    WHERE bs.bin_id = v_sess.filter_bin_id
    ON CONFLICT (session_id, bin_id, producto_sku) DO NOTHING;
  ELSE
    RAISE EXCEPTION 'Modo de sesión no soportado: %', v_sess.mode;
  END IF;

  UPDATE count_sessions
  SET status = 'IN_PROGRESS'::count_session_status, updated_at = now()
  WHERE id = p_session_id;

  RETURN (SELECT COUNT(*)::INT FROM count_lines WHERE session_id = p_session_id);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- submit_count_line: MATCHED si igual; si no DISCREPANCY (siempre requiere aprobación admin)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION submit_count_line(
  p_line_id     BIGINT,
  p_qty_counted NUMERIC(18,4),
  p_user_id     INTEGER DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_line       count_lines%ROWTYPE;
  v_precio     NUMERIC(15,6);
  v_diff_val   NUMERIC(12,4);
  v_new_status count_line_status;
BEGIN
  SELECT * INTO v_line FROM count_lines WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Línea % no encontrada', p_line_id;
  END IF;
  IF v_line.status NOT IN ('PENDING', 'COUNTED') THEN
    RAISE EXCEPTION 'Línea ya procesada: %', v_line.status;
  END IF;

  SELECT precio_usd INTO v_precio
  FROM productos WHERE sku = v_line.producto_sku;

  v_diff_val := ABS(p_qty_counted - v_line.qty_system)
                * COALESCE(v_precio, 0);

  v_new_status := CASE
    WHEN p_qty_counted = v_line.qty_system THEN 'MATCHED'::count_line_status
    ELSE 'DISCREPANCY'::count_line_status
  END;

  UPDATE count_lines SET
    qty_counted          = p_qty_counted,
    difference_value_usd = v_diff_val,
    status               = v_new_status,
    counted_at           = now(),
    counted_by           = p_user_id,
    updated_at           = now()
  WHERE id = p_line_id;

  IF v_new_status = 'DISCREPANCY' THEN
    UPDATE count_sessions SET
      status     = 'PENDING_APPROVAL'::count_session_status,
      updated_at = now()
    WHERE id = v_line.session_id
      AND status = 'IN_PROGRESS'::count_session_status;
  END IF;

  -- Todas las líneas contadas y ninguna discrepancia → COMPLETED (solo desde IN_PROGRESS)
  IF NOT EXISTS (
    SELECT 1 FROM count_lines cl
    WHERE cl.session_id = v_line.session_id
      AND cl.status IN ('PENDING'::count_line_status, 'COUNTED'::count_line_status)
  ) AND NOT EXISTS (
    SELECT 1 FROM count_lines cl2
    WHERE cl2.session_id = v_line.session_id
      AND cl2.status = 'DISCREPANCY'::count_line_status
  ) THEN
    UPDATE count_sessions SET
      status = 'COMPLETED'::count_session_status,
      updated_at = now()
    WHERE id = v_line.session_id
      AND status = 'IN_PROGRESS'::count_session_status;
  END IF;

  RETURN jsonb_build_object(
    'line_id',           p_line_id,
    'qty_system',        v_line.qty_system,
    'qty_counted',       p_qty_counted,
    'difference',        p_qty_counted - v_line.qty_system,
    'diff_value_usd',    v_diff_val,
    'status',            v_new_status::text,
    'requires_approval', v_new_status = 'DISCREPANCY'::count_line_status
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- apply_count_adjustment: ajusta solo qty_available; contexto auditoría
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apply_count_adjustment(
  p_line_id BIGINT,
  p_user_id INTEGER,
  p_notes   TEXT
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_line  count_lines%ROWTYPE;
  v_delta NUMERIC(18,4);
  v_sid   BIGINT;
  v_rc    INT;
BEGIN
  SELECT * INTO v_line FROM count_lines WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Línea % no encontrada', p_line_id;
  END IF;
  IF v_line.status <> 'DISCREPANCY' THEN
    RAISE EXCEPTION 'apply_count_adjustment solo aplica a DISCREPANCY (línea %)', p_line_id;
  END IF;

  v_delta := COALESCE(v_line.qty_counted, 0) - v_line.qty_system;
  v_sid := v_line.session_id;

  IF v_delta = 0 THEN
    RETURN;
  END IF;

  PERFORM set_config(
    'app.movement_reason',
    CASE WHEN v_delta > 0 THEN 'ADJUSTMENT_UP' ELSE 'ADJUSTMENT_DOWN' END::text,
    true
  );
  PERFORM set_config('app.reference_id', 'COUNT-SESSION-' || v_sid::text, true);
  PERFORM set_config('app.reference_type', 'cycle_count', true);
  PERFORM set_config('app.user_id', COALESCE(p_user_id::text, ''), true);
  PERFORM set_config('app.movement_notes', COALESCE(p_notes, 'Conteo cíclico'), true);

  UPDATE bin_stock
  SET
    qty_available = qty_available + v_delta,
    last_counted_at = now(),
    updated_at = now()
  WHERE bin_id = v_line.bin_id AND producto_sku = v_line.producto_sku;

  GET DIAGNOSTICS v_rc = ROW_COUNT;

  IF v_rc = 0 THEN
    IF v_delta < 0 THEN
      RAISE EXCEPTION 'Sin fila bin_stock para bin_id=% sku=%', v_line.bin_id, v_line.producto_sku;
    END IF;
    INSERT INTO bin_stock (bin_id, producto_sku, qty_available, qty_reserved)
    VALUES (v_line.bin_id, v_line.producto_sku, v_delta, 0);
  END IF;

  IF EXISTS (
    SELECT 1 FROM bin_stock
    WHERE bin_id = v_line.bin_id AND producto_sku = v_line.producto_sku
      AND (qty_available < 0 OR qty_reserved < 0)
  ) THEN
    RAISE EXCEPTION 'Stock negativo tras ajuste de conteo (línea %)', p_line_id;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- approve_count_session: solo líneas DISCREPANCY → ADJUSTED
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION approve_count_session(
  p_session_id BIGINT,
  p_user_id    INTEGER,
  p_notes      TEXT
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_sess count_sessions%ROWTYPE;
  v_line RECORD;
  v_applied INT := 0;
BEGIN
  SELECT * INTO v_sess FROM count_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sesión % no encontrada', p_session_id;
  END IF;
  IF v_sess.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'Sesión % no está en PENDING_APPROVAL (status=%)', p_session_id, v_sess.status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM count_lines
    WHERE session_id = p_session_id
      AND status IN ('PENDING'::count_line_status, 'COUNTED'::count_line_status)
  ) THEN
    RAISE EXCEPTION 'Quedan líneas sin conteo en la sesión %', p_session_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM count_lines
    WHERE session_id = p_session_id AND status = 'DISCREPANCY'::count_line_status
  ) THEN
    RAISE EXCEPTION 'No hay líneas en DISCREPANCY para aprobar en la sesión %', p_session_id;
  END IF;

  FOR v_line IN
    SELECT id FROM count_lines
    WHERE session_id = p_session_id AND status = 'DISCREPANCY'::count_line_status
    ORDER BY id
    FOR UPDATE
  LOOP
    PERFORM apply_count_adjustment(v_line.id, p_user_id, p_notes);
    UPDATE count_lines
    SET status = 'ADJUSTED'::count_line_status, updated_at = now()
    WHERE id = v_line.id;
    v_applied := v_applied + 1;
  END LOOP;

  UPDATE count_sessions SET
    status = 'COMPLETED'::count_session_status,
    approved_by = p_user_id,
    approved_at = now(),
    approval_notes = p_notes,
    updated_at = now()
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'session_id',     p_session_id,
    'lines_adjusted', v_applied,
    'status',         'COMPLETED'
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Vista resumen (admin / pendientes)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_count_sessions_summary AS
SELECT
  s.id,
  s.mode,
  s.reference_name,
  s.status,
  s.created_at,
  s.updated_at,
  s.approved_at,
  COUNT(cl.id)::bigint                                    AS total_lines,
  COUNT(*) FILTER (WHERE cl.status = 'PENDING')::bigint    AS pending_lines,
  COUNT(*) FILTER (WHERE cl.status = 'DISCREPANCY')::bigint AS discrepancy_lines,
  COUNT(*) FILTER (WHERE cl.status = 'MATCHED')::bigint    AS matched_lines,
  COUNT(*) FILTER (WHERE cl.status = 'ADJUSTED')::bigint   AS adjusted_lines
FROM count_sessions s
LEFT JOIN count_lines cl ON cl.session_id = s.id
GROUP BY s.id, s.mode, s.reference_name, s.status, s.created_at, s.updated_at, s.approved_at;
