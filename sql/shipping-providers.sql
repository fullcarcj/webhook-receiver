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
  provider_id      BIGINT NOT NULL REFERENCES shipping_providers(id),
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
  CONSTRAINT uq_category_name  UNIQUE (company_id, provider_id, name),
  CONSTRAINT chk_rate_positive CHECK (rate_per_cbm > 0),
  CONSTRAINT chk_min_charge    CHECK (min_charge_cbm >= 0)
);

CREATE INDEX IF NOT EXISTS idx_shipping_cat_provider
  ON shipping_categories (provider_id);
CREATE INDEX IF NOT EXISTS idx_shipping_cat_company
  ON shipping_categories (company_id, is_active);

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

ALTER TABLE import_shipment_lines
  ADD COLUMN IF NOT EXISTS shipping_category_id BIGINT
    REFERENCES shipping_categories(id),
  ADD COLUMN IF NOT EXISTS volume_cbm_used    NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS freight_line_usd   NUMERIC(15,4),
  ADD COLUMN IF NOT EXISTS rate_snapshot_cbm  NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS freight_source     TEXT;

