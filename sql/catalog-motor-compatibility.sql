-- ════════════════════════════════════════════════════════
-- Ferrari ERP — Catálogo técnico: compatibilidad de motores
-- Relación N:N entre productos (válvulas) y motores
-- Un SKU puede ser compatible con múltiples motores.
-- Un motor puede usar múltiples SKUs.
-- ════════════════════════════════════════════════════════
--
-- Prerrequisitos: tabla productos(sku), vista v_stock_by_sku (sql/wms-bins.sql).
-- set_updated_at() se define en shipping-providers.sql o wms-bins.sql.
-- Orden sugerido: después de wms-bins.sql (paso 4 en run-migrations.md).
--

-- Columna usada en v_catalog_compatibility (idempotente si ya existe en BD)
ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS landed_cost_usd NUMERIC(15,4);


-- ─────────────────────────────────────────────────────
-- 1. vehicle_makes — marcas de vehículo
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_makes (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  country    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_make_name UNIQUE (name)
);

INSERT INTO vehicle_makes (name, country) VALUES
  ('Toyota',      'JP'),
  ('Ford',        'US'),
  ('Chevrolet',   'US'),
  ('Nissan',      'JP'),
  ('Honda',       'JP'),
  ('Mitsubishi',  'JP'),
  ('Hyundai',     'KR'),
  ('Kia',         'KR'),
  ('Volkswagen',  'DE'),
  ('Mack',        'US'),
  ('Caterpillar', 'US')
ON CONFLICT (name) DO NOTHING;


-- ─────────────────────────────────────────────────────
-- 2. vehicle_models — modelos por marca
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_models (
  id         BIGSERIAL PRIMARY KEY,
  make_id    BIGINT NOT NULL REFERENCES vehicle_makes(id),
  name       TEXT   NOT NULL,
  body_type  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_model_make UNIQUE (make_id, name)
);

CREATE INDEX IF NOT EXISTS idx_models_make ON vehicle_models (make_id);


-- ─────────────────────────────────────────────────────
-- 3. engines — motores específicos
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS engines (
  id                BIGSERIAL PRIMARY KEY,
  model_id          BIGINT  NOT NULL REFERENCES vehicle_models(id),

  year_from         SMALLINT NOT NULL,
  year_to           SMALLINT,

  displacement_cc   INTEGER  NOT NULL,
  displacement_l    NUMERIC(4,1) GENERATED ALWAYS AS
                      (ROUND(displacement_cc / 1000.0, 1)) STORED,
  cylinders         SMALLINT,
  fuel_type         TEXT,
  engine_code       TEXT,
  power_hp          SMALLINT,
  valves_per_cyl    SMALLINT,

  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_engine UNIQUE (model_id, year_from, displacement_cc, engine_code),
  CONSTRAINT chk_years CHECK (year_to IS NULL OR year_to >= year_from),
  CONSTRAINT chk_displacement CHECK (displacement_cc > 0),
  CONSTRAINT chk_cylinders    CHECK (cylinders IS NULL OR cylinders > 0)
);

CREATE INDEX IF NOT EXISTS idx_engines_model
  ON engines (model_id);
CREATE INDEX IF NOT EXISTS idx_engines_year
  ON engines (year_from, year_to);
CREATE INDEX IF NOT EXISTS idx_engines_code
  ON engines (engine_code)
  WHERE engine_code IS NOT NULL;


-- ─────────────────────────────────────────────────────
-- 4. motor_compatibility — unión N:N productos ↔ engines
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS motor_compatibility (
  id            BIGSERIAL PRIMARY KEY,
  producto_sku  TEXT   NOT NULL REFERENCES productos(sku),
  engine_id     BIGINT NOT NULL REFERENCES engines(id),
  position      TEXT   NOT NULL DEFAULT 'INTAKE',
  qty_per_engine SMALLINT NOT NULL DEFAULT 1,
  is_oem        BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sku_engine_position UNIQUE (producto_sku, engine_id, position),
  CONSTRAINT chk_position CHECK (position IN ('INTAKE','EXHAUST','BOTH')),
  CONSTRAINT chk_qty      CHECK (qty_per_engine > 0)
);

CREATE INDEX IF NOT EXISTS idx_compat_sku
  ON motor_compatibility (producto_sku);
CREATE INDEX IF NOT EXISTS idx_compat_engine
  ON motor_compatibility (engine_id);


-- ─────────────────────────────────────────────────────
-- 5. valve_specs — atributos técnicos por SKU
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS valve_specs (
  producto_sku      TEXT PRIMARY KEY REFERENCES productos(sku),

  head_diameter_mm  NUMERIC(6,2) NOT NULL,
  stem_diameter_mm  NUMERIC(5,2) NOT NULL,
  total_length_mm   NUMERIC(7,2) NOT NULL,
  stem_length_mm    NUMERIC(7,2),
  seat_angle_deg    NUMERIC(4,1),
  face_angle_deg    NUMERIC(4,1),

  material          TEXT,
  coating           TEXT,
  valve_type        TEXT NOT NULL DEFAULT 'INTAKE',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_head_diam   CHECK (head_diameter_mm  > 0),
  CONSTRAINT chk_stem_diam   CHECK (stem_diameter_mm  > 0),
  CONSTRAINT chk_length      CHECK (total_length_mm   > 0),
  CONSTRAINT chk_valve_type  CHECK (valve_type IN ('INTAKE','EXHAUST','UNIVERSAL'))
);

CREATE INDEX IF NOT EXISTS idx_valve_head_diam
  ON valve_specs (head_diameter_mm);
CREATE INDEX IF NOT EXISTS idx_valve_stem_diam
  ON valve_specs (stem_diameter_mm);
CREATE INDEX IF NOT EXISTS idx_valve_length
  ON valve_specs (total_length_mm);

CREATE INDEX IF NOT EXISTS idx_valve_dimensions
  ON valve_specs (head_diameter_mm, stem_diameter_mm, total_length_mm);

DROP TRIGGER IF EXISTS trg_valve_specs_updated_at ON valve_specs;
CREATE TRIGGER trg_valve_specs_updated_at
  BEFORE UPDATE ON valve_specs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ─────────────────────────────────────────────────────
-- 6. Vista catálogo técnico (v_stock_by_sku: qty_*_total)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_catalog_compatibility AS
SELECT
  mc.id                   AS compat_id,
  mc.producto_sku,
  p.descripcion,
  p.precio_usd,
  p.landed_cost_usd,

  mc.position,
  mc.qty_per_engine,
  mc.is_oem,

  e.id                    AS engine_id,
  e.engine_code,
  e.year_from,
  e.year_to,
  e.displacement_cc,
  e.displacement_l,
  e.cylinders,
  e.fuel_type,
  e.valves_per_cyl,

  vm.name                 AS model_name,
  vmk.name                AS make_name,

  vs.head_diameter_mm,
  vs.stem_diameter_mm,
  vs.total_length_mm,
  vs.seat_angle_deg,
  vs.material,
  vs.valve_type,

  COALESCE(stk.qty_available_total, 0) AS stock_available,
  COALESCE(stk.qty_reserved_total,  0) AS stock_reserved

FROM motor_compatibility mc
JOIN productos        p    ON p.sku     = mc.producto_sku
JOIN engines          e    ON e.id      = mc.engine_id
JOIN vehicle_models   vm   ON vm.id     = e.model_id
JOIN vehicle_makes    vmk  ON vmk.id    = vm.make_id
LEFT JOIN valve_specs vs   ON vs.producto_sku = mc.producto_sku
LEFT JOIN v_stock_by_sku stk ON stk.producto_sku = mc.producto_sku;


-- ─────────────────────────────────────────────────────
-- 7. Vista equivalencias técnicas (dimensiones ± tolerancia)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_valve_equivalences AS
SELECT
  base.producto_sku       AS sku_original,
  equiv.producto_sku      AS sku_equivalente,
  equiv_p.descripcion     AS descripcion_equivalente,
  equiv_p.precio_usd      AS precio_equivalente,

  ABS(equiv.head_diameter_mm - base.head_diameter_mm) AS diff_head_mm,
  ABS(equiv.stem_diameter_mm - base.stem_diameter_mm) AS diff_stem_mm,
  ABS(equiv.total_length_mm  - base.total_length_mm)  AS diff_length_mm,

  equiv.head_diameter_mm,
  equiv.stem_diameter_mm,
  equiv.total_length_mm,
  equiv.material,

  COALESCE(stk.qty_available_total, 0) AS stock_disponible

FROM valve_specs base
JOIN valve_specs equiv
  ON equiv.producto_sku != base.producto_sku
  AND ABS(equiv.head_diameter_mm - base.head_diameter_mm) <= 0.5
  AND ABS(equiv.stem_diameter_mm - base.stem_diameter_mm) <= 0.5
  AND ABS(equiv.total_length_mm  - base.total_length_mm)  <= 1.0
  AND (equiv.valve_type = base.valve_type OR equiv.valve_type = 'UNIVERSAL')
JOIN productos equiv_p ON equiv_p.sku = equiv.producto_sku
LEFT JOIN v_stock_by_sku stk ON stk.producto_sku = equiv.producto_sku
WHERE COALESCE(stk.qty_available_total, 0) > 0;


-- ════════════════════════════════════════════════════════
-- Referencia: consultas y verificación (ejecutar en psql)
-- ════════════════════════════════════════════════════════
--
-- Búsqueda por vehículo (ejemplo):
-- SELECT producto_sku, descripcion, position, qty_per_engine, is_oem,
--        head_diameter_mm, stem_diameter_mm, total_length_mm,
--        stock_available, precio_usd
-- FROM v_catalog_compatibility
-- WHERE make_name = 'Toyota' AND model_name = 'Corolla'
--   AND year_from <= 2003 AND (year_to IS NULL OR year_to >= 2003)
--   AND displacement_l = 1.8
-- ORDER BY is_oem DESC, position, precio_usd;
--
-- Datos de prueba para equivalencias (requiere filas en productos para esos SKU):
-- INSERT INTO productos (sku, descripcion, precio_usd) VALUES
--   ('SKU-BASE-001', 'Test base', 0), ('SKU-EQUIV-001', 'Test equiv', 0)
-- ON CONFLICT (sku) DO NOTHING;
-- INSERT INTO valve_specs (producto_sku, head_diameter_mm, stem_diameter_mm,
--   total_length_mm, seat_angle_deg, material, valve_type) VALUES
--   ('SKU-BASE-001', 38.00, 7.00, 112.50, 45.0, 'stainless_steel', 'INTAKE'),
--   ('SKU-EQUIV-001', 38.30, 6.95, 113.20, 45.0, 'stainless_steel', 'INTAKE')
-- ON CONFLICT (producto_sku) DO NOTHING;
-- SELECT sku_equivalente, diff_head_mm, diff_stem_mm, diff_length_mm
-- FROM v_valve_equivalences WHERE sku_original = 'SKU-BASE-001';
