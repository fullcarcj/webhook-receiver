-- SOLOMOTOR3K CRM — migración adaptada a webhook-receiver
-- Prerrequisito: `customers` de sql/customer-wallet.sql (BIGINT id, full_name, …)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Búsqueda difusa por nombre
CREATE INDEX IF NOT EXISTS idx_customers_full_name_trgm
  ON customers USING GIN (full_name gin_trgm_ops);

-- Estado CRM (draft / active / blocked)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS crm_status VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_crm_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_crm_status_check CHECK (
  crm_status IN ('draft', 'active', 'blocked')
);

DO $$ BEGIN
  CREATE TYPE crm_identity_source AS ENUM ('whatsapp', 'mercadolibre', 'mostrador');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS crm_customer_identities (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source crm_identity_source NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_identities_customer_id ON crm_customer_identities(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_identities_lookup ON crm_customer_identities(source, external_id);

CREATE TABLE IF NOT EXISTS crm_vehicle_brands (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS crm_vehicle_models (
  id BIGSERIAL PRIMARY KEY,
  brand_id BIGINT NOT NULL REFERENCES crm_vehicle_brands(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  UNIQUE (brand_id, name)
);

CREATE TABLE IF NOT EXISTS crm_vehicle_generations (
  id BIGSERIAL PRIMARY KEY,
  model_id BIGINT NOT NULL REFERENCES crm_vehicle_models(id) ON DELETE CASCADE,
  year_start SMALLINT NOT NULL,
  year_end SMALLINT,
  engine_info VARCHAR(100),
  body_type VARCHAR(50),
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_generations_model_id ON crm_vehicle_generations(model_id);

CREATE TABLE IF NOT EXISTS crm_customer_vehicles (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  generation_id BIGINT NOT NULL REFERENCES crm_vehicle_generations(id),
  plate VARCHAR(20),
  color VARCHAR(50),
  notes TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, generation_id, plate)
);

CREATE INDEX IF NOT EXISTS idx_crm_cust_vehicles_customer ON crm_customer_vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_cust_vehicles_gen ON crm_customer_vehicles(generation_id);

CREATE TABLE IF NOT EXISTS crm_whatsapp_logs (
  id BIGSERIAL PRIMARY KEY,
  message_id VARCHAR(255) NOT NULL UNIQUE,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_wa_logs_message_id ON crm_whatsapp_logs(message_id);
CREATE INDEX IF NOT EXISTS idx_crm_wa_logs_received_at ON crm_whatsapp_logs(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_wa_logs_customer_id ON crm_whatsapp_logs(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_wa_logs_payload_gin ON crm_whatsapp_logs USING GIN (payload);
