-- Ferrari ERP — Landed cost (costo real de importación, BY_VOLUME / CBM)
-- Catálogo: products (sku, precio_usd | unit_price_usd, description).
-- Prerrequisitos: products, daily_exchange_rates (active_rate), set_updated_at().
-- Compatibilidad: mantiene columnas legacy de shipping (producto_sku, flete dinámico) vía trigger de espejo.
-- Idempotente: CREATE IF NOT EXISTS, ALTER … ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE.
-- psql $DATABASE_URL -f sql/landed-cost.sql

-- ── Parche histórico shipping (no quitar; otros scripts lo asumen) ─────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'import_shipment_lines'
  ) THEN
    ALTER TABLE import_shipment_lines
      ADD COLUMN IF NOT EXISTS shipping_category_id BIGINT
        REFERENCES shipping_categories(id),
      ADD COLUMN IF NOT EXISTS volume_cbm_used NUMERIC(10,6),
      ADD COLUMN IF NOT EXISTS freight_line_usd NUMERIC(15,4),
      ADD COLUMN IF NOT EXISTS rate_snapshot_cbm NUMERIC(12,4),
      ADD COLUMN IF NOT EXISTS freight_source TEXT;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────
-- ENUM estado embarque
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE shipment_status AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────
-- import_shipments
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_shipments (
  id                  BIGSERIAL PRIMARY KEY,
  company_id          INTEGER         NOT NULL DEFAULT 1,
  shipment_ref        TEXT,
  supplier_name       TEXT,
  origin_country      TEXT,
  incoterm            TEXT,
  status              shipment_status NOT NULL DEFAULT 'OPEN',
  total_expenses_usd  NUMERIC(15,4)   NOT NULL DEFAULT 0,
  rate_applied        NUMERIC(15,6),
  rate_date           DATE,
  total_fob_usd       NUMERIC(15,4),
  total_landed_usd    NUMERIC(15,4),
  closed_at           TIMESTAMPTZ,
  closed_by           INTEGER,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS shipment_ref TEXT;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS supplier_name TEXT;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS origin_country TEXT;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS incoterm TEXT;
DO $$ BEGIN
  ALTER TABLE import_shipments
    ALTER COLUMN status TYPE shipment_status USING status::text::shipment_status;
EXCEPTION
  WHEN undefined_column THEN NULL;
  WHEN invalid_text_representation THEN NULL;
  WHEN datatype_mismatch THEN NULL;
END $$;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS total_expenses_usd NUMERIC(15,4) NOT NULL DEFAULT 0;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS rate_applied NUMERIC(15,6);
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS rate_date DATE;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS total_fob_usd NUMERIC(15,4);
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS total_landed_usd NUMERIC(15,4);
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS closed_by INTEGER;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE import_shipments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE import_shipments DROP CONSTRAINT IF EXISTS chk_expenses_pos;
ALTER TABLE import_shipments ADD CONSTRAINT chk_expenses_pos CHECK (total_expenses_usd >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipment_ref
  ON import_shipments (company_id, shipment_ref)
  WHERE shipment_ref IS NOT NULL AND btrim(shipment_ref) <> '';

CREATE INDEX IF NOT EXISTS idx_shipments_company_status
  ON import_shipments (company_id, status);
CREATE INDEX IF NOT EXISTS idx_shipments_created
  ON import_shipments (created_at DESC);

DROP TRIGGER IF EXISTS trg_shipments_updated_at ON import_shipments;
CREATE TRIGGER trg_shipments_updated_at
  BEFORE UPDATE ON import_shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- import_shipment_lines (product_sku canónico + producto_sku legacy)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_shipment_lines (
  id                    BIGSERIAL PRIMARY KEY,
  shipment_id           BIGINT        NOT NULL REFERENCES import_shipments(id) ON DELETE CASCADE,
  product_sku           TEXT          NOT NULL REFERENCES products(sku),
  quantity              NUMERIC(12,3) NOT NULL,
  unit_fob_usd          NUMERIC(15,6) NOT NULL,
  unit_volume_cbm       NUMERIC(10,6) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS product_sku TEXT REFERENCES products(sku);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS producto_sku TEXT;
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS quantity NUMERIC(12,3);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS unit_fob_usd NUMERIC(15,6);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS unit_volume_cbm NUMERIC(10,6);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS allocated_expense_usd NUMERIC(15,6);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS landed_cost_usd NUMERIC(15,6);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS applied_to_product BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS shipping_category_id BIGINT REFERENCES shipping_categories(id);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS volume_cbm_used NUMERIC(10,6);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS freight_line_usd NUMERIC(15,4);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS rate_snapshot_cbm NUMERIC(12,4);
ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS freight_source TEXT;

-- line_fob_usd generada: si la columna ya existía sin GENERATED, PG no permite ADD así — crear solo en tablas nuevas arriba.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'import_shipment_lines'
      AND column_name = 'line_fob_usd'
  ) THEN
    ALTER TABLE import_shipment_lines
      ADD COLUMN line_fob_usd NUMERIC(15,4)
      GENERATED ALWAYS AS (quantity * unit_fob_usd) STORED;
  END IF;
END $$;

UPDATE import_shipment_lines
SET product_sku = NULLIF(btrim(producto_sku), '')
WHERE (product_sku IS NULL OR btrim(product_sku) = '')
  AND producto_sku IS NOT NULL
  AND EXISTS (SELECT 1 FROM products pr WHERE pr.sku = btrim(import_shipment_lines.producto_sku));

UPDATE import_shipment_lines
SET producto_sku = product_sku
WHERE (producto_sku IS NULL OR btrim(producto_sku) = '')
  AND product_sku IS NOT NULL;

ALTER TABLE import_shipment_lines ADD COLUMN IF NOT EXISTS fob_line_usd NUMERIC(15,4);
UPDATE import_shipment_lines
SET unit_fob_usd = ROUND((fob_line_usd / NULLIF(quantity, 0))::numeric, 6)
WHERE unit_fob_usd IS NULL AND fob_line_usd IS NOT NULL AND quantity > 0;

UPDATE import_shipment_lines
SET unit_volume_cbm = ROUND((volume_cbm_used / NULLIF(quantity, 0))::numeric, 6)
WHERE unit_volume_cbm IS NULL
  AND volume_cbm_used IS NOT NULL
  AND quantity > 0
  AND volume_cbm_used > 0;

CREATE OR REPLACE FUNCTION import_shipment_lines_sync_skus()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_sku IS NOT NULL AND (NEW.producto_sku IS NULL OR btrim(NEW.producto_sku) = '') THEN
    NEW.producto_sku := NEW.product_sku;
  ELSIF NEW.producto_sku IS NOT NULL AND (NEW.product_sku IS NULL OR btrim(NEW.product_sku) = '') THEN
    NEW.product_sku := btrim(NEW.producto_sku);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_isl_sync_skus ON import_shipment_lines;
CREATE TRIGGER trg_isl_sync_skus
  BEFORE INSERT OR UPDATE OF product_sku, producto_sku ON import_shipment_lines
  FOR EACH ROW EXECUTE FUNCTION import_shipment_lines_sync_skus();

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipment_line_sku
  ON import_shipment_lines (shipment_id, product_sku);

CREATE INDEX IF NOT EXISTS idx_isl_shipment ON import_shipment_lines (shipment_id);
CREATE INDEX IF NOT EXISTS idx_isl_sku ON import_shipment_lines (product_sku);

DROP TRIGGER IF EXISTS trg_isl_updated_at ON import_shipment_lines;
CREATE TRIGGER trg_isl_updated_at
  BEFORE UPDATE ON import_shipment_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE import_shipment_lines DROP CONSTRAINT IF EXISTS chk_line_qty;
ALTER TABLE import_shipment_lines ADD CONSTRAINT chk_line_qty CHECK (quantity > 0);
ALTER TABLE import_shipment_lines DROP CONSTRAINT IF EXISTS chk_line_fob;
ALTER TABLE import_shipment_lines ADD CONSTRAINT chk_line_fob CHECK (unit_fob_usd > 0);
ALTER TABLE import_shipment_lines DROP CONSTRAINT IF EXISTS chk_line_volume;
ALTER TABLE import_shipment_lines ADD CONSTRAINT chk_line_volume CHECK (unit_volume_cbm > 0);

-- ─────────────────────────────────────────────────────
-- landed_cost_audit (append-only)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landed_cost_audit (
  id                    BIGSERIAL PRIMARY KEY,
  shipment_id           BIGINT        NOT NULL REFERENCES import_shipments(id),
  product_sku           TEXT          NOT NULL,
  old_landed_cost_usd   NUMERIC(15,6),
  new_landed_cost_usd   NUMERIC(15,6) NOT NULL,
  allocated_expense_usd NUMERIC(15,6) NOT NULL,
  line_volume_cbm       NUMERIC(15,6) NOT NULL,
  total_volume_cbm      NUMERIC(15,6) NOT NULL,
  allocation_pct        NUMERIC(8,4)  NOT NULL,
  quantity              NUMERIC(12,3) NOT NULL,
  applied_by            INTEGER,
  applied_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lca_shipment ON landed_cost_audit (shipment_id);
CREATE INDEX IF NOT EXISTS idx_lca_sku ON landed_cost_audit (product_sku, applied_at DESC);

-- ─────────────────────────────────────────────────────
-- products — precio_usd (spec) + landed snapshot
-- ─────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS precio_usd NUMERIC(15,6);
UPDATE products
SET precio_usd = unit_price_usd
WHERE precio_usd IS NULL AND unit_price_usd IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS landed_cost_usd   NUMERIC(15,6),
  ADD COLUMN IF NOT EXISTS last_shipment_id BIGINT REFERENCES import_shipments(id),
  ADD COLUMN IF NOT EXISTS landed_updated_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────
-- calculate_landed_cost — solo preview (read-only)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_landed_cost(p_shipment_id BIGINT)
RETURNS TABLE (
  product_sku           TEXT,
  descripcion           TEXT,
  quantity              NUMERIC(12,3),
  unit_fob_usd          NUMERIC(15,6),
  line_fob_usd          NUMERIC(15,4),
  unit_volume_cbm       NUMERIC(10,6),
  line_volume_cbm       NUMERIC(15,6),
  allocation_pct        NUMERIC(8,4),
  allocated_expense_usd NUMERIC(15,6),
  landed_cost_usd       NUMERIC(15,6),
  current_landed_usd    NUMERIC(15,6),
  margin_if_sold_at_current NUMERIC(8,4)
)
LANGUAGE plpgsql AS $$
DECLARE
  v_ship       import_shipments%ROWTYPE;
  v_total_cbm  NUMERIC(15,6);
BEGIN
  SELECT * INTO v_ship FROM import_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % no encontrado', p_shipment_id;
  END IF;

  SELECT COALESCE(SUM(quantity * unit_volume_cbm), 0)
    INTO v_total_cbm
  FROM import_shipment_lines
  WHERE shipment_id = p_shipment_id;

  IF v_total_cbm = 0 THEN
    RAISE EXCEPTION 'Total CBM es 0 — todas las líneas deben tener unit_volume_cbm > 0';
  END IF;

  RETURN QUERY
  SELECT
    isl.product_sku,
    COALESCE(NULLIF(trim(p.description), ''), p.sku::text) AS descripcion,
    isl.quantity,
    isl.unit_fob_usd,
    isl.line_fob_usd,
    isl.unit_volume_cbm,
    ROUND(isl.quantity * isl.unit_volume_cbm, 6) AS line_volume_cbm,
    ROUND((isl.quantity * isl.unit_volume_cbm) / v_total_cbm * 100, 4) AS allocation_pct,
    ROUND(
      v_ship.total_expenses_usd
      * (isl.quantity * isl.unit_volume_cbm)
      / v_total_cbm,
    6) AS allocated_expense_usd,
    ROUND(
      (isl.line_fob_usd
        + v_ship.total_expenses_usd
          * (isl.quantity * isl.unit_volume_cbm)
          / v_total_cbm
      ) / NULLIF(isl.quantity, 0),
    6) AS landed_cost_usd,
    p.landed_cost_usd AS current_landed_usd,
    CASE WHEN COALESCE(p.precio_usd, p.unit_price_usd, 0) > 0
      THEN ROUND(
        (COALESCE(p.precio_usd, p.unit_price_usd, 0)
          - (isl.line_fob_usd
              + v_ship.total_expenses_usd
                * (isl.quantity * isl.unit_volume_cbm)
                / v_total_cbm
            ) / NULLIF(isl.quantity, 0)
        ) / COALESCE(p.precio_usd, p.unit_price_usd, 1) * 100,
      2)
    END AS margin_if_sold_at_current
  FROM import_shipment_lines isl
  JOIN products p ON p.sku = isl.product_sku
  WHERE isl.shipment_id = p_shipment_id
  ORDER BY (isl.quantity * isl.unit_volume_cbm) DESC;
END;
$$;

-- ─────────────────────────────────────────────────────
-- close_shipment — irreversible (transacción implícita en función)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_shipment(
  p_shipment_id BIGINT,
  p_user_id     INTEGER DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_ship      import_shipments%ROWTYPE;
  v_rate      NUMERIC(15,6);
  v_rate_date DATE;
  v_line      RECORD;
  v_old_cost  NUMERIC(15,6);
  v_total_cbm NUMERIC(15,6);
  v_count     INTEGER := 0;
  v_total_fob NUMERIC(15,4) := 0;
BEGIN
  SELECT * INTO v_ship FROM import_shipments
  WHERE id = p_shipment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shipment % no encontrado', p_shipment_id;
  END IF;
  IF v_ship.status = 'CLOSED'::shipment_status THEN
    RAISE EXCEPTION 'Shipment % ya está cerrado', p_shipment_id;
  END IF;
  IF v_ship.status = 'CANCELLED'::shipment_status THEN
    RAISE EXCEPTION 'No se puede cerrar un shipment cancelado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM import_shipment_lines WHERE shipment_id = p_shipment_id
  ) THEN
    RAISE EXCEPTION 'El shipment no tiene líneas — agregar SKUs primero';
  END IF;

  SELECT COALESCE(SUM(quantity * unit_volume_cbm), 0)
    INTO v_total_cbm
  FROM import_shipment_lines
  WHERE shipment_id = p_shipment_id;

  IF v_total_cbm = 0 THEN
    RAISE EXCEPTION 'Total CBM es 0 — verificar unit_volume_cbm en las líneas';
  END IF;

  SELECT active_rate, rate_date
    INTO v_rate, v_rate_date
  FROM daily_exchange_rates
  WHERE company_id = v_ship.company_id
    AND active_rate IS NOT NULL
    AND rate_date <= CURRENT_DATE
  ORDER BY rate_date DESC
  LIMIT 1;

  IF v_rate IS NULL THEN
    RAISE EXCEPTION 'No hay tasa de cambio disponible — ejecutar fetch de tasas primero';
  END IF;

  FOR v_line IN
    SELECT * FROM calculate_landed_cost(p_shipment_id)
  LOOP
    SELECT landed_cost_usd INTO v_old_cost
    FROM products WHERE sku = v_line.product_sku;

    UPDATE import_shipment_lines SET
      allocated_expense_usd = v_line.allocated_expense_usd,
      landed_cost_usd       = v_line.landed_cost_usd,
      applied_to_product    = TRUE,
      applied_at            = now(),
      updated_at            = now()
    WHERE shipment_id = p_shipment_id
      AND product_sku = v_line.product_sku;

    UPDATE products SET
      landed_cost_usd   = v_line.landed_cost_usd,
      last_shipment_id  = p_shipment_id,
      landed_updated_at = now()
    WHERE sku = v_line.product_sku;

    INSERT INTO landed_cost_audit (
      shipment_id, product_sku,
      old_landed_cost_usd, new_landed_cost_usd,
      allocated_expense_usd,
      line_volume_cbm, total_volume_cbm,
      allocation_pct, quantity,
      applied_by
    ) VALUES (
      p_shipment_id, v_line.product_sku,
      v_old_cost, v_line.landed_cost_usd,
      v_line.allocated_expense_usd,
      v_line.line_volume_cbm, v_total_cbm,
      v_line.allocation_pct, v_line.quantity,
      p_user_id
    );

    v_total_fob := v_total_fob + COALESCE(v_line.line_fob_usd, 0);
    v_count     := v_count + 1;
  END LOOP;

  UPDATE import_shipments SET
    status            = 'CLOSED'::shipment_status,
    rate_applied      = v_rate,
    rate_date         = v_rate_date,
    total_fob_usd     = v_total_fob,
    total_landed_usd  = v_total_fob + v_ship.total_expenses_usd,
    closed_at         = now(),
    closed_by         = p_user_id,
    updated_at        = now()
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'shipment_id',        p_shipment_id,
    'skus_updated',       v_count,
    'total_fob_usd',      v_total_fob,
    'total_expenses_usd', v_ship.total_expenses_usd,
    'total_landed_usd',   v_total_fob + v_ship.total_expenses_usd,
    'total_cbm',          v_total_cbm,
    'rate_applied',       v_rate,
    'rate_date',          v_rate_date,
    'closed_at',          now()
  );
END;
$$;

-- ─────────────────────────────────────────────────────
-- Vista resumen
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_shipments_summary AS
SELECT
  s.id,
  s.company_id,
  s.shipment_ref,
  s.supplier_name,
  s.origin_country,
  s.incoterm,
  s.status,
  s.total_expenses_usd,
  COUNT(l.id)              AS total_skus,
  SUM(l.quantity)          AS total_units,
  ROUND(COALESCE(SUM(l.quantity * l.unit_volume_cbm), 0), 4) AS total_cbm,
  COALESCE(SUM(l.line_fob_usd), 0)::numeric(15,4) AS total_fob_usd,
  COALESCE(SUM(l.line_fob_usd), 0)::numeric(15,4) + s.total_expenses_usd AS total_landed_usd,
  s.rate_applied,
  s.rate_date,
  s.closed_at,
  s.created_at
FROM import_shipments s
LEFT JOIN import_shipment_lines l ON l.shipment_id = s.id
GROUP BY s.id, s.company_id, s.shipment_ref, s.supplier_name, s.origin_country, s.incoterm,
         s.status, s.total_expenses_usd, s.rate_applied, s.rate_date, s.closed_at, s.created_at
ORDER BY s.created_at DESC;
