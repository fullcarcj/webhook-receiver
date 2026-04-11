-- Ferrari ERP — Proveedores de envío, categorías y tarifas dinámicas
-- Idempotente. Evoluciona el esquema legacy (shipping_providers/categories por CBM)
-- sin romper FKs existentes en import_shipment_lines / productos.
-- Catálogo canónico: products (sku, precio_usd, description).
-- psql $DATABASE_URL -f sql/shipping-providers.sql

-- ─────────────────────────────────────────────────────
-- Base legacy (instalación desde cero; seguro si ya existe)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TYPE transport_mode AS ENUM ('SEA','AIR','ROAD','MULTIMODAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rate_basis AS ENUM ('CBM','KG','FLAT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS shipping_providers (
  id             BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL DEFAULT 1,
  name           TEXT NOT NULL,
  transport_mode transport_mode NOT NULL DEFAULT 'SEA',
  contact_email  TEXT,
  contact_phone  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_provider_name UNIQUE (company_id, name)
);

DROP TRIGGER IF EXISTS trg_providers_updated_at ON shipping_providers;
CREATE TRIGGER trg_providers_updated_at
  BEFORE UPDATE ON shipping_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shipping_categories (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL DEFAULT 1,
  provider_id      BIGINT REFERENCES shipping_providers(id),
  name             TEXT NOT NULL,
  description      TEXT,
  transport_mode   transport_mode NOT NULL DEFAULT 'SEA',
  rate_per_cbm     NUMERIC(12,4) NOT NULL,
  min_charge_cbm   NUMERIC(10,4) NOT NULL DEFAULT 0.10,
  avg_volume_cbm   NUMERIC(10,6),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from       DATE NOT NULL DEFAULT CURRENT_DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_category_name UNIQUE (company_id, provider_id, name),
  CONSTRAINT chk_rate_positive CHECK (rate_per_cbm > 0),
  CONSTRAINT chk_min_charge CHECK (min_charge_cbm >= 0)
);

CREATE INDEX IF NOT EXISTS idx_shipping_cat_provider ON shipping_categories (provider_id);
CREATE INDEX IF NOT EXISTS idx_shipping_cat_company ON shipping_categories (company_id, is_active);

DROP TRIGGER IF EXISTS trg_categories_updated_at ON shipping_categories;
CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON shipping_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shipping_rate_history (
  id                   BIGSERIAL PRIMARY KEY,
  shipping_category_id BIGINT NOT NULL REFERENCES shipping_categories(id),
  rate_per_cbm         NUMERIC(12,4) NOT NULL,
  min_charge_cbm       NUMERIC(10,4) NOT NULL,
  effective_from       DATE NOT NULL,
  effective_to         DATE,
  changed_by_user_id   INTEGER,
  change_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rate_hist_positive CHECK (rate_per_cbm > 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_hist_category
  ON shipping_rate_history (shipping_category_id, effective_from DESC);

CREATE OR REPLACE FUNCTION archive_shipping_rate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.rate_per_cbm <> NEW.rate_per_cbm OR
     OLD.min_charge_cbm <> NEW.min_charge_cbm THEN
    UPDATE shipping_rate_history
      SET effective_to = CURRENT_DATE - 1
    WHERE shipping_category_id = OLD.id
      AND effective_to IS NULL;
    INSERT INTO shipping_rate_history
      (shipping_category_id, rate_per_cbm, min_charge_cbm, effective_from)
    VALUES (NEW.id, NEW.rate_per_cbm, NEW.min_charge_cbm, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_archive_shipping_rate ON shipping_categories;
CREATE TRIGGER trg_archive_shipping_rate
  BEFORE UPDATE ON shipping_categories
  FOR EACH ROW EXECUTE FUNCTION archive_shipping_rate();

CREATE OR REPLACE FUNCTION seed_shipping_rate_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO shipping_rate_history
    (shipping_category_id, rate_per_cbm, min_charge_cbm, effective_from)
  VALUES (NEW.id, NEW.rate_per_cbm, NEW.min_charge_cbm,
          COALESCE(NEW.valid_from, CURRENT_DATE));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_shipping_rate ON shipping_categories;
CREATE TRIGGER trg_seed_shipping_rate
  AFTER INSERT ON shipping_categories
  FOR EACH ROW EXECUTE FUNCTION seed_shipping_rate_history();

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS shipping_category_id BIGINT
    REFERENCES shipping_categories(id),
  ADD COLUMN IF NOT EXISTS volume_cbm NUMERIC(10,6);

CREATE INDEX IF NOT EXISTS idx_productos_shipping_cat
  ON productos (shipping_category_id)
  WHERE shipping_category_id IS NOT NULL;

-- ─────────────────────────────────────────────────────
-- ENUMs nuevos
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE shipping_scope AS ENUM (
    'INTERNATIONAL',
    'NATIONAL',
    'BOTH'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE shipment_mode AS ENUM (
    'SEA_FCL',
    'SEA_LCL',
    'AIR',
    'LAND',
    'COURIER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enum propio para tarifas dinámicas (no altera rate_basis legacy de shipping_categories)
DO $$ BEGIN
  CREATE TYPE freight_rate_basis AS ENUM ('CBM', 'KG', 'CBM_OR_KG', 'FLAT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────
-- settings_shipping
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings_shipping (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL DEFAULT 1,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  value_type     TEXT NOT NULL DEFAULT 'string',
  description    TEXT,
  allowed_values TEXT,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_by     INTEGER,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ss_key UNIQUE (company_id, key, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_ss_company_key
  ON settings_shipping (company_id, key, effective_from DESC);

CREATE OR REPLACE FUNCTION get_shipping_setting(
  p_key        TEXT,
  p_company_id INTEGER DEFAULT 1,
  p_date       DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT value FROM settings_shipping
  WHERE company_id = p_company_id
    AND key = p_key
    AND effective_from <= p_date
  ORDER BY effective_from DESC
  LIMIT 1;
$$;

INSERT INTO settings_shipping
  (company_id, key, value, value_type, description, allowed_values)
VALUES
  (1, 'default_rate_basis', 'CBM_OR_KG', 'enum',
   'Base de cálculo del flete por defecto.',
   'CBM,KG,CBM_OR_KG,FLAT'),
  (1, 'default_volumetric_factor', '5000', 'number',
   'Factor volumétrico estándar (cm³/kg).', NULL),
  (1, 'preferred_import_mode', 'SEA_LCL', 'enum',
   'Modo preferido importaciones.',
   'SEA_FCL,SEA_LCL,AIR'),
  (1, 'preferred_national_mode', 'LAND', 'enum',
   'Modo preferido nacional.',
   'LAND,COURIER'),
  (1, 'freight_markup_pct', '15', 'number',
   '% margen en quote_all_providers (no aplica a landed cost).', NULL)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────
-- shipping_providers — columnas nuevas (legacy: transport_mode, etc.)
-- ─────────────────────────────────────────────────────
ALTER TABLE shipping_providers
  ADD COLUMN IF NOT EXISTS scope shipping_scope,
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS origin_country TEXT,
  ADD COLUMN IF NOT EXISTS destination TEXT;

UPDATE shipping_providers SET scope = COALESCE(scope, 'BOTH'::shipping_scope) WHERE scope IS NULL;

ALTER TABLE shipping_providers
  ALTER COLUMN scope SET DEFAULT 'BOTH'::shipping_scope;

-- ─────────────────────────────────────────────────────
-- shipping_categories — categorías globales (provider_id puede ser NULL)
-- ─────────────────────────────────────────────────────
ALTER TABLE shipping_categories
  ADD COLUMN IF NOT EXISTS volumetric_factor NUMERIC(8,4) NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  ALTER TABLE shipping_categories ALTER COLUMN provider_id DROP NOT NULL;
EXCEPTION
  WHEN undefined_column THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_default_global
  ON shipping_categories (company_id)
  WHERE is_default = TRUE AND provider_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sc_company_name_global
  ON shipping_categories (company_id, name)
  WHERE provider_id IS NULL;

-- Semillas globales (solo si no existen filas equivalentes)
INSERT INTO shipping_categories
  (company_id, provider_id, name, description, volumetric_factor, is_default,
   transport_mode, rate_per_cbm, min_charge_cbm, is_active)
SELECT 1, NULL, 'General', 'Categoría por defecto (envío)', 5000, TRUE,
       'SEA'::transport_mode, 1, 0.1, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM shipping_categories c
  WHERE c.company_id = 1 AND c.provider_id IS NULL AND c.name = 'General'
);

INSERT INTO shipping_categories
  (company_id, provider_id, name, description, volumetric_factor, is_default,
   transport_mode, rate_per_cbm, min_charge_cbm, is_active)
SELECT 1, NULL, 'Válvulas de Motor', 'Válvulas de acero y bronce', 5000, FALSE,
       'SEA'::transport_mode, 1, 0.1, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM shipping_categories c
  WHERE c.company_id = 1 AND c.provider_id IS NULL AND c.name = 'Válvulas de Motor'
);

INSERT INTO shipping_categories
  (company_id, provider_id, name, description, volumetric_factor, is_default,
   transport_mode, rate_per_cbm, min_charge_cbm, is_active)
SELECT 1, NULL, 'Juntas y Sellos', 'Juntas de goma, sellos y empaques', 5000, FALSE,
       'SEA'::transport_mode, 1, 0.1, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM shipping_categories c
  WHERE c.company_id = 1 AND c.provider_id IS NULL AND c.name = 'Juntas y Sellos'
);

INSERT INTO shipping_categories
  (company_id, provider_id, name, description, volumetric_factor, is_default,
   transport_mode, rate_per_cbm, min_charge_cbm, is_active)
SELECT 1, NULL, 'Filtros', 'Filtros de aceite, aire y combustible', 5000, FALSE,
       'SEA'::transport_mode, 1, 0.1, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM shipping_categories c
  WHERE c.company_id = 1 AND c.provider_id IS NULL AND c.name = 'Filtros'
);

INSERT INTO shipping_categories
  (company_id, provider_id, name, description, volumetric_factor, is_default,
   transport_mode, rate_per_cbm, min_charge_cbm, is_active)
SELECT 1, NULL, 'Piezas Metálicas', 'Pistones, anillos, bielas y similares', 5000, FALSE,
       'SEA'::transport_mode, 1, 0.1, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM shipping_categories c
  WHERE c.company_id = 1 AND c.provider_id IS NULL AND c.name = 'Piezas Metálicas'
);

-- ─────────────────────────────────────────────────────
-- products — vínculo a categoría de envío + peso/volumen
-- ─────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS shipping_category_id BIGINT
    REFERENCES shipping_categories(id),
  ADD COLUMN IF NOT EXISTS unit_weight_kg NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS unit_volume_cbm NUMERIC(10,6);

CREATE INDEX IF NOT EXISTS idx_products_shipping_cat
  ON products (shipping_category_id)
  WHERE shipping_category_id IS NOT NULL;

-- ─────────────────────────────────────────────────────
-- shipping_rates — append-only
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_rates (
  id               BIGSERIAL PRIMARY KEY,
  provider_id      BIGINT NOT NULL REFERENCES shipping_providers(id),
  category_id      BIGINT REFERENCES shipping_categories(id),
  shipment_mode    shipment_mode NOT NULL,
  rate_basis       freight_rate_basis NOT NULL,
  rate_per_cbm_usd NUMERIC(10,4),
  rate_per_kg_usd  NUMERIC(10,4),
  flat_rate_usd    NUMERIC(10,4),
  min_charge_usd   NUMERIC(10,4) NOT NULL DEFAULT 0,
  surcharge_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to     DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rate_cbm CHECK (
    rate_basis NOT IN ('CBM', 'CBM_OR_KG')
    OR rate_per_cbm_usd IS NOT NULL
  ),
  CONSTRAINT chk_rate_kg CHECK (
    rate_basis NOT IN ('KG', 'CBM_OR_KG')
    OR rate_per_kg_usd IS NOT NULL
  ),
  CONSTRAINT chk_rate_flat CHECK (
    rate_basis != 'FLAT'
    OR flat_rate_usd IS NOT NULL
  ),
  CONSTRAINT chk_rate_dates CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  CONSTRAINT chk_min_charge CHECK (min_charge_usd >= 0),
  CONSTRAINT chk_surcharge CHECK (surcharge_pct >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_rates_effective
  ON shipping_rates (provider_id, category_id, shipment_mode, effective_from)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_sr_provider_date
  ON shipping_rates (provider_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_sr_category_date
  ON shipping_rates (category_id, effective_from DESC)
  WHERE category_id IS NOT NULL;

-- ─────────────────────────────────────────────────────
-- Vista tarifas vigentes
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_shipping_rates_current AS
SELECT DISTINCT ON (sr.provider_id, sr.category_id, sr.shipment_mode)
  sr.id,
  sp.name AS provider_name,
  sp.scope,
  sc.name AS category_name,
  sr.shipment_mode,
  sr.rate_basis,
  sr.rate_per_cbm_usd,
  sr.rate_per_kg_usd,
  sr.flat_rate_usd,
  sr.min_charge_usd,
  sr.surcharge_pct,
  sr.effective_from,
  sr.effective_to,
  sr.notes,
  sr.provider_id,
  sr.category_id
FROM shipping_rates sr
JOIN shipping_providers sp ON sp.id = sr.provider_id
LEFT JOIN shipping_categories sc ON sc.id = sr.category_id
WHERE sr.effective_from <= CURRENT_DATE
  AND (sr.effective_to IS NULL OR sr.effective_to >= CURRENT_DATE)
  AND sp.is_active = TRUE
ORDER BY
  sr.provider_id,
  sr.category_id,
  sr.shipment_mode,
  sr.effective_from DESC;

-- ─────────────────────────────────────────────────────
-- calculate_freight()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_freight(
  p_provider_id   BIGINT,
  p_category_id   BIGINT,
  p_shipment_mode shipment_mode,
  p_total_cbm     NUMERIC(12,6),
  p_total_kg      NUMERIC(12,4),
  p_date          DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  provider_name       TEXT,
  category_name       TEXT,
  shipment_mode       TEXT,
  rate_basis          TEXT,
  rate_per_cbm_usd    NUMERIC(10,4),
  rate_per_kg_usd     NUMERIC(10,4),
  cbm_charge_usd      NUMERIC(12,4),
  kg_charge_usd       NUMERIC(12,4),
  volumetric_kg       NUMERIC(12,4),
  base_freight_usd    NUMERIC(12,4),
  surcharge_usd       NUMERIC(12,4),
  min_charge_usd      NUMERIC(10,4),
  total_freight_usd   NUMERIC(12,4),
  applied_basis       TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_rate    shipping_rates%ROWTYPE;
  v_sp      shipping_providers%ROWTYPE;
  v_vol_kg  NUMERIC(12,4) := 0;
  v_cbm_ch  NUMERIC(12,4) := 0;
  v_kg_ch   NUMERIC(12,4) := 0;
  v_base    NUMERIC(12,4) := 0;
  v_sur     NUMERIC(12,4) := 0;
  v_total   NUMERIC(12,4) := 0;
  v_basis   TEXT;
  v_vol_charge NUMERIC(12,4) := 0;
  v_cat_display TEXT := 'General';
BEGIN
  SELECT sr.* INTO v_rate
  FROM shipping_rates sr
  WHERE sr.provider_id = p_provider_id
    AND sr.shipment_mode = p_shipment_mode
    AND (sr.category_id = p_category_id OR sr.category_id IS NULL)
    AND sr.effective_from <= p_date
    AND (sr.effective_to IS NULL OR sr.effective_to >= p_date)
  ORDER BY
    (sr.category_id IS NOT NULL) DESC,
    sr.effective_from DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Sin tarifa vigente para proveedor=% categoría=% modo=%',
      p_provider_id, p_category_id, p_shipment_mode;
  END IF;

  SELECT * INTO v_sp FROM shipping_providers WHERE id = p_provider_id;

  SELECT COALESCE(
    (SELECT sc.name FROM shipping_categories sc
     WHERE sc.id = COALESCE(v_rate.category_id, p_category_id) LIMIT 1),
    (SELECT sc.name FROM shipping_categories sc
     WHERE sc.company_id = v_sp.company_id AND sc.is_default = TRUE
     ORDER BY (sc.provider_id IS NULL) DESC, sc.id LIMIT 1),
    'General'
  ) INTO v_cat_display;

  IF v_rate.rate_per_cbm_usd IS NOT NULL THEN
    v_cbm_ch := ROUND(p_total_cbm * v_rate.rate_per_cbm_usd, 4);
  END IF;

  IF v_rate.rate_per_kg_usd IS NOT NULL THEN
    v_vol_kg := ROUND(p_total_cbm * 1000.0, 4);
    v_kg_ch := ROUND(p_total_kg * v_rate.rate_per_kg_usd, 4);
  END IF;

  CASE v_rate.rate_basis
    WHEN 'CBM' THEN
      v_base := v_cbm_ch;
      v_basis := 'CBM';
    WHEN 'KG' THEN
      v_base := v_kg_ch;
      v_basis := 'KG';
    WHEN 'CBM_OR_KG' THEN
      v_vol_charge := ROUND(v_vol_kg * v_rate.rate_per_kg_usd, 4);
      IF v_vol_charge >= v_kg_ch THEN
        v_base := v_cbm_ch;
        v_basis := 'VOLUMETRIC';
      ELSE
        v_base := v_kg_ch;
        v_basis := 'KG';
      END IF;
    WHEN 'FLAT' THEN
      v_base := v_rate.flat_rate_usd;
      v_basis := 'FLAT';
    ELSE
      v_base := v_cbm_ch;
      v_basis := 'CBM';
  END CASE;

  v_sur := ROUND(v_base * v_rate.surcharge_pct / 100, 4);
  v_total := GREATEST(v_base + v_sur, v_rate.min_charge_usd);
  IF v_total = v_rate.min_charge_usd
     AND (v_base + v_sur) < v_rate.min_charge_usd THEN
    v_basis := 'MINIMUM';
  END IF;

  RETURN QUERY SELECT
    v_sp.name,
    v_cat_display,
    v_rate.shipment_mode::TEXT,
    v_rate.rate_basis::TEXT,
    v_rate.rate_per_cbm_usd,
    v_rate.rate_per_kg_usd,
    v_cbm_ch,
    v_kg_ch,
    v_vol_kg,
    v_base,
    v_sur,
    v_rate.min_charge_usd,
    v_total,
    v_basis;
END;
$$;

-- ─────────────────────────────────────────────────────
-- quote_all_providers()
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION quote_all_providers(
  p_category_id   BIGINT,
  p_shipment_mode shipment_mode,
  p_total_cbm     NUMERIC(12,6),
  p_total_kg      NUMERIC(12,4),
  p_company_id    INTEGER DEFAULT 1,
  p_date          DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  provider_id         BIGINT,
  provider_name       TEXT,
  total_freight_usd   NUMERIC(12,4),
  rate_basis          TEXT,
  applied_basis       TEXT,
  rate_per_cbm_usd    NUMERIC(10,4),
  rate_per_kg_usd     NUMERIC(10,4),
  min_charge_usd      NUMERIC(10,4),
  surcharge_pct       NUMERIC(5,2)
)
LANGUAGE plpgsql AS $$
DECLARE
  v_provider RECORD;
  v_cf        RECORD;
  v_sr        shipping_rates%ROWTYPE;
BEGIN
  FOR v_provider IN
    SELECT DISTINCT sr.provider_id
    FROM shipping_rates sr
    JOIN shipping_providers sp ON sp.id = sr.provider_id
    WHERE sp.company_id = p_company_id
      AND sp.is_active = TRUE
      AND sr.shipment_mode = p_shipment_mode
      AND sr.effective_from <= p_date
      AND (sr.effective_to IS NULL OR sr.effective_to >= p_date)
  LOOP
    BEGIN
      SELECT * INTO v_cf
      FROM calculate_freight(
        v_provider.provider_id,
        p_category_id,
        p_shipment_mode,
        p_total_cbm,
        p_total_kg,
        p_date
      );

      SELECT sr.* INTO v_sr
      FROM shipping_rates sr
      WHERE sr.provider_id = v_provider.provider_id
        AND sr.shipment_mode = p_shipment_mode
        AND (sr.category_id = p_category_id OR sr.category_id IS NULL)
        AND sr.effective_from <= p_date
        AND (sr.effective_to IS NULL OR sr.effective_to >= p_date)
      ORDER BY (sr.category_id IS NOT NULL) DESC, sr.effective_from DESC
      LIMIT 1;

      RETURN QUERY SELECT
        v_provider.provider_id,
        v_cf.provider_name,
        v_cf.total_freight_usd,
        v_cf.rate_basis,
        v_cf.applied_basis,
        v_cf.rate_per_cbm_usd,
        v_cf.rate_per_kg_usd,
        v_cf.min_charge_usd,
        COALESCE(v_sr.surcharge_pct, 0)::NUMERIC(5,2);
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
  END LOOP;
END;
$$;