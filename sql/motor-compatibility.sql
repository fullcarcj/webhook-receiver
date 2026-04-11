-- Ferrari ERP — Motor Compatibility N:N + Valve Specs (v2)
-- Tabla canónica: products (NO productos). Precio: precio_usd.
--
-- MIGRACIÓN IDEMPOTENTE:
--   - Si las tablas existen con schema legacy (productos, producto_sku, model_id en engines)
--     → migra columnas y FK en su lugar.
--   - Si no existen → crea con schema nuevo.
--
-- Prerrequisito: products con sku, descripcion, precio_usd, landed_cost_usd.
--   (sql/landed-cost.sql ya agrega landed_cost_usd a products.)
-- Ejecutar con: npm run db:catalog

-- ─────────────────────────────────────────────────────
-- Función helper: stock disponible por SKU (tolerante si
-- bin_stock no existe — WMS puede no estar instalado)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION catalog_get_stock(p_sku TEXT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
BEGIN
  RETURN (
    SELECT COALESCE(SUM(qty_available), 0)
    FROM bin_stock
    WHERE product_sku = p_sku
  );
EXCEPTION
  WHEN undefined_table THEN RETURN 0;
  WHEN undefined_column THEN RETURN 0;
END;
$$;

-- ─────────────────────────────────────────────────────
-- products: landed_cost_usd (si no existe)
-- (landed-cost.sql lo agrega; esto es safety-net)
-- ─────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS landed_cost_usd NUMERIC(15,6);

-- ─────────────────────────────────────────────────────
-- vehicle_makes
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_makes (
  id         SERIAL      PRIMARY KEY,
  name       TEXT        NOT NULL,
  country    TEXT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_make_name UNIQUE (name)
);

ALTER TABLE vehicle_makes
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO vehicle_makes (name, country) VALUES
  ('Toyota','JP'),('Ford','US'),('Chevrolet','US'),
  ('Nissan','JP'),('Mitsubishi','JP'),('Hyundai','KR'),
  ('Kia','KR'),('Volkswagen','DE'),('Honda','JP'),
  ('Dodge','US'),('Jeep','US'),('Mazda','JP'),
  ('Isuzu','JP'),('Mercedes','DE'),('BMW','DE'),
  ('Renault','FR'),('Fiat','IT'),('Peugeot','FR')
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- vehicle_models
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_models (
  id         SERIAL      PRIMARY KEY,
  make_id    INTEGER     NOT NULL REFERENCES vehicle_makes(id),
  name       TEXT        NOT NULL,
  body_type  TEXT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_model_make_name UNIQUE (make_id, name)
);

ALTER TABLE vehicle_models
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_vm_make
  ON vehicle_models (make_id, is_active);

-- ─────────────────────────────────────────────────────
-- engines — migración del schema legacy al nuevo
--
-- OLD: engines(model_id FK NOT NULL, year_from, year_to, engine_code, ...)
-- NEW: engines standalone (model_id opcional/null), sin year range.
--      La relación engine ↔ model ↔ year va en engine_model_years.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS engines (
  id              SERIAL      PRIMARY KEY,
  engine_code     TEXT        NOT NULL,
  displacement_cc INTEGER,
  cylinders       INTEGER,
  fuel_type       TEXT        NOT NULL DEFAULT 'GASOLINE',
  valve_config    TEXT,
  notes           TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_engine_code UNIQUE (engine_code)
);

-- Si la tabla ya existía con model_id NOT NULL → hacerlo nullable
-- para que los motores "canónicos" (nuevos) no necesiten model_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'engines'
      AND column_name = 'model_id'
  ) THEN
    BEGIN
      ALTER TABLE engines ALTER COLUMN model_id DROP NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

-- Agregar columnas nuevas si no existen
ALTER TABLE engines
  ADD COLUMN IF NOT EXISTS valve_config TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Índice parcial legacy (solo si engines tiene model_id de schema antiguo).
-- Si la tabla es nueva (sin model_id) → el UNIQUE uq_engine_code del CREATE TABLE es suficiente.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'engines'
      AND column_name = 'model_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'uq_engine_code_canonical'
    ) THEN
      EXECUTE $idx$
        CREATE UNIQUE INDEX uq_engine_code_canonical
          ON engines (engine_code)
          WHERE model_id IS NULL
      $idx$;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_engines_code
  ON engines (engine_code);
CREATE INDEX IF NOT EXISTS idx_engines_displacement
  ON engines (displacement_cc, cylinders);

-- ─────────────────────────────────────────────────────
-- engine_model_years — N:M engines ↔ vehicle_models con rango de años
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS engine_model_years (
  id         SERIAL      PRIMARY KEY,
  model_id   INTEGER     NOT NULL REFERENCES vehicle_models(id),
  engine_id  INTEGER     NOT NULL REFERENCES engines(id),
  year_from  INTEGER     NOT NULL,
  year_to    INTEGER     NOT NULL,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_emy UNIQUE (model_id, engine_id, year_from, year_to),
  CONSTRAINT chk_year_range CHECK (year_to >= year_from),
  CONSTRAINT chk_year_valid CHECK (year_from >= 1950 AND year_to <= 2050)
);

CREATE INDEX IF NOT EXISTS idx_emy_model  ON engine_model_years (model_id);
CREATE INDEX IF NOT EXISTS idx_emy_engine ON engine_model_years (engine_id);
CREATE INDEX IF NOT EXISTS idx_emy_years  ON engine_model_years (year_from, year_to);

-- Poblar engine_model_years desde engines legacy (model_id NOT NULL, year_from NOT NULL)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'engines'
      AND column_name = 'model_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'engines'
      AND column_name = 'year_from'
  ) THEN
    INSERT INTO engine_model_years (model_id, engine_id, year_from, year_to)
    SELECT
      e.model_id,
      e.id,
      e.year_from,
      COALESCE(e.year_to, e.year_from)
    FROM engines e
    WHERE e.model_id IS NOT NULL
      AND e.year_from IS NOT NULL
      AND e.year_from >= 1950
      AND COALESCE(e.year_to, e.year_from) <= 2050
      AND COALESCE(e.year_to, e.year_from) >= e.year_from
    ON CONFLICT (model_id, engine_id, year_from, year_to) DO NOTHING;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────
-- motor_compatibility — N:N products ↔ engines
--
-- Migración: producto_sku → product_sku, FK productos → products
-- Borrado lógico (is_active=FALSE — nunca DELETE).
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS motor_compatibility (
  id          BIGSERIAL   PRIMARY KEY,
  product_sku TEXT        NOT NULL REFERENCES products(sku),
  engine_id   INTEGER     NOT NULL REFERENCES engines(id),
  position    TEXT,
  notes       TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_compat UNIQUE (product_sku, engine_id, position)
);

-- Migrar producto_sku → product_sku si existe la columna legacy
DO $$
DECLARE fkname TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'motor_compatibility'
      AND column_name = 'producto_sku'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'motor_compatibility'
      AND column_name = 'product_sku'
  ) THEN
    SELECT c.conname INTO fkname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'motor_compatibility'
      AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) ILIKE '%producto_sku%'
    LIMIT 1;
    IF fkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE motor_compatibility DROP CONSTRAINT %I', fkname);
    END IF;
    ALTER TABLE motor_compatibility RENAME COLUMN producto_sku TO product_sku;
  END IF;
END $$;

-- Re-apuntar FK a products (canónico)
DO $$
DECLARE fkname TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'motor_compatibility'
      AND column_name = 'product_sku'
  ) THEN
    SELECT c.conname INTO fkname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'motor_compatibility'
      AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) ILIKE '%productos%'
    LIMIT 1;
    IF fkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE motor_compatibility DROP CONSTRAINT %I', fkname);
    END IF;
    ALTER TABLE motor_compatibility
      DROP CONSTRAINT IF EXISTS motor_compatibility_product_sku_fkey;
    BEGIN
      ALTER TABLE motor_compatibility
        ADD CONSTRAINT motor_compatibility_product_sku_fkey
        FOREIGN KEY (product_sku) REFERENCES products(sku);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

-- Columnas nuevas
ALTER TABLE motor_compatibility
  ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Actualizar check de posición: aceptar INLET (nuevo) + INTAKE (legacy)
DO $$
BEGIN
  ALTER TABLE motor_compatibility DROP CONSTRAINT IF EXISTS chk_position;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_mc_sku
  ON motor_compatibility (product_sku) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_mc_engine
  ON motor_compatibility (engine_id)   WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_mc_updated_at ON motor_compatibility;
CREATE TRIGGER trg_mc_updated_at
  BEFORE UPDATE ON motor_compatibility
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- valve_specs — specs técnicas de válvulas
--
-- Migración: producto_sku → product_sku, FK productos → products
--            total_length_mm → overall_length_mm
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS valve_specs (
  id                BIGSERIAL    PRIMARY KEY,
  product_sku       TEXT         NOT NULL UNIQUE REFERENCES products(sku),
  head_diameter_mm  NUMERIC(6,2) NOT NULL,
  stem_diameter_mm  NUMERIC(6,3) NOT NULL,
  overall_length_mm NUMERIC(7,2) NOT NULL,
  material          TEXT,
  stem_material     TEXT,
  face_angle_deg    NUMERIC(5,2) NOT NULL DEFAULT 45.00,
  margin_mm         NUMERIC(5,2),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT chk_head  CHECK (head_diameter_mm  > 0),
  CONSTRAINT chk_stem  CHECK (stem_diameter_mm  > 0),
  CONSTRAINT chk_len   CHECK (overall_length_mm > 0),
  CONSTRAINT chk_angle CHECK (face_angle_deg BETWEEN 0 AND 90)
);

-- Migrar producto_sku → product_sku
DO $$
DECLARE fkname TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'valve_specs'
      AND column_name = 'producto_sku'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'valve_specs'
      AND column_name = 'product_sku'
  ) THEN
    SELECT c.conname INTO fkname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'valve_specs'
      AND c.contype IN ('f','p')
      AND pg_get_constraintdef(c.oid) ILIKE '%producto_sku%'
    LIMIT 1;
    IF fkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE valve_specs DROP CONSTRAINT %I', fkname);
    END IF;
    ALTER TABLE valve_specs RENAME COLUMN producto_sku TO product_sku;
  END IF;
END $$;

-- Migrar total_length_mm → overall_length_mm
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'valve_specs'
      AND column_name = 'total_length_mm'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'valve_specs'
      AND column_name = 'overall_length_mm'
  ) THEN
    ALTER TABLE valve_specs RENAME COLUMN total_length_mm TO overall_length_mm;
  END IF;
END $$;

-- Re-apuntar FK a products
DO $$
DECLARE fkname TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'valve_specs'
      AND column_name = 'product_sku'
  ) THEN
    SELECT c.conname INTO fkname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'valve_specs'
      AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) ILIKE '%productos%'
    LIMIT 1;
    IF fkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE valve_specs DROP CONSTRAINT %I', fkname);
    END IF;
    ALTER TABLE valve_specs
      DROP CONSTRAINT IF EXISTS valve_specs_product_sku_fkey;
    BEGIN
      ALTER TABLE valve_specs
        ADD CONSTRAINT valve_specs_product_sku_fkey
        FOREIGN KEY (product_sku) REFERENCES products(sku);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

-- Columnas nuevas
ALTER TABLE valve_specs
  ADD COLUMN IF NOT EXISTS stem_material     TEXT,
  ADD COLUMN IF NOT EXISTS margin_mm         NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

-- Índices B-Tree para búsqueda de equivalencias ±0.5mm
CREATE INDEX IF NOT EXISTS idx_vs_head   ON valve_specs (head_diameter_mm);
CREATE INDEX IF NOT EXISTS idx_vs_stem   ON valve_specs (stem_diameter_mm);
CREATE INDEX IF NOT EXISTS idx_vs_length ON valve_specs (overall_length_mm);

DROP TRIGGER IF EXISTS trg_vs_updated_at ON valve_specs;
CREATE TRIGGER trg_vs_updated_at
  BEFORE UPDATE ON valve_specs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- v_catalog_compatibility — catálogo técnico principal
-- "¿Qué SKUs sirven para Toyota Corolla 2000?"
-- Usa catalog_get_stock() para tolerar WMS no instalado.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_catalog_compatibility AS
SELECT
  mc.product_sku,
  p.descripcion,
  p.precio_usd,
  p.landed_cost_usd,
  e.engine_code,
  e.displacement_cc,
  e.cylinders,
  e.fuel_type,
  e.valve_config,
  mc.position,
  mc.notes           AS compat_notes,
  vm.name            AS model_name,
  vm.body_type,
  vma.name           AS make_name,
  vma.id             AS make_id,
  vm.id              AS model_id,
  e.id               AS engine_id,
  emy.year_from,
  emy.year_to,
  catalog_get_stock(mc.product_sku) AS total_stock,
  vs.head_diameter_mm,
  vs.stem_diameter_mm,
  vs.overall_length_mm,
  vs.material,
  vs.face_angle_deg,
  mc.is_active
FROM motor_compatibility   mc
JOIN products              p   ON p.sku      = mc.product_sku
JOIN engines               e   ON e.id       = mc.engine_id
LEFT JOIN engine_model_years emy ON emy.engine_id = e.id
LEFT JOIN vehicle_models   vm  ON vm.id      = emy.model_id
LEFT JOIN vehicle_makes    vma ON vma.id     = vm.make_id
LEFT JOIN valve_specs      vs  ON vs.product_sku = mc.product_sku
WHERE mc.is_active = TRUE;

-- ─────────────────────────────────────────────────────
-- v_valve_equivalences — sustitutos con dimensiones ±0.5mm
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_valve_equivalences AS
SELECT
  v1.product_sku                              AS sku_original,
  v2.product_sku                              AS sku_equivalente,
  p2.descripcion                              AS desc_equivalente,
  p2.precio_usd,
  ABS(v1.head_diameter_mm  - v2.head_diameter_mm)  AS diff_head_mm,
  ABS(v1.stem_diameter_mm  - v2.stem_diameter_mm)  AS diff_stem_mm,
  ABS(v1.overall_length_mm - v2.overall_length_mm) AS diff_length_mm,
  catalog_get_stock(v2.product_sku)           AS stock_disponible
FROM valve_specs v1
JOIN valve_specs v2 ON
  v1.product_sku            != v2.product_sku
  AND ABS(v1.head_diameter_mm  - v2.head_diameter_mm)  <= 0.5
  AND ABS(v1.stem_diameter_mm  - v2.stem_diameter_mm)  <= 0.5
  AND ABS(v1.overall_length_mm - v2.overall_length_mm) <= 0.5
JOIN products p2 ON p2.sku = v2.product_sku
ORDER BY v1.product_sku,
  (ABS(v1.head_diameter_mm  - v2.head_diameter_mm) +
   ABS(v1.stem_diameter_mm  - v2.stem_diameter_mm) +
   ABS(v1.overall_length_mm - v2.overall_length_mm));

-- ─────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'vehicle_makes','vehicle_models','engines',
    'engine_model_years','motor_compatibility','valve_specs')
ORDER BY table_name;
-- Esperado: 6 filas

SELECT COUNT(*) AS total_makes FROM vehicle_makes;
-- Esperado: >= 18

SELECT viewname FROM pg_views
WHERE schemaname = 'public'
  AND viewname IN ('v_catalog_compatibility','v_valve_equivalences')
ORDER BY viewname;
-- Esperado: 2 filas
