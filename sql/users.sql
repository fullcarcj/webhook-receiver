-- Ferrari ERP — Users + Roles + Permissions
-- 100% idempotente (IF NOT EXISTS en todo).
-- Ejecutar: node scripts/run-users-migration.js
--           (o psql $DATABASE_URL -f sql/users.sql)

-- ─────────────────────────────────────────────────────
-- ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'SUPERUSER',
    'ADMIN',
    'OPERATOR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'LOCKED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL      PRIMARY KEY,
  company_id      INTEGER     NOT NULL DEFAULT 1,
  username        TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  password_hash   TEXT        NOT NULL,
  full_name       TEXT        NOT NULL,
  role            user_role   NOT NULL DEFAULT 'OPERATOR',
  status          user_status NOT NULL DEFAULT 'ACTIVE',
  failed_attempts INTEGER     NOT NULL DEFAULT 0,
  locked_at       TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  last_login_ip   TEXT,
  reset_token     TEXT,
  reset_token_exp TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_username UNIQUE (company_id, username),
  CONSTRAINT uq_email    UNIQUE (company_id, email),
  CONSTRAINT chk_username CHECK (username ~ '^[a-z0-9_]{3,30}$')
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id, status);
CREATE INDEX IF NOT EXISTS idx_users_email   ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users (role, company_id);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- user_sessions — log para revocación de tokens
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti         TEXT        NOT NULL UNIQUE,
  ip_address  TEXT,
  user_agent  TEXT,
  revoked     BOOLEAN     NOT NULL DEFAULT FALSE,
  revoked_at  TIMESTAMPTZ,
  revoked_by  INTEGER     REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_jti     ON user_sessions (jti);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON user_sessions (user_id, revoked);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions (expires_at) WHERE revoked = FALSE;

-- ─────────────────────────────────────────────────────
-- role_permissions — permisos fijos por rol
-- Módulos: wms | ventas | crm | catalog | settings | fiscal
-- Acciones: read | write | admin
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
  id      SERIAL    PRIMARY KEY,
  role    user_role NOT NULL,
  module  TEXT      NOT NULL,
  action  TEXT      NOT NULL,
  CONSTRAINT uq_role_perm  UNIQUE (role, module, action),
  CONSTRAINT chk_rp_module CHECK (module IN ('wms','ventas','crm','catalog','settings','fiscal')),
  CONSTRAINT chk_rp_action CHECK (action IN ('read','write','admin'))
);

-- SUPERUSER: 6 módulos × 3 acciones = 18 permisos
INSERT INTO role_permissions (role, module, action)
SELECT 'SUPERUSER'::user_role, m, a
FROM unnest(ARRAY['wms','ventas','crm','catalog','settings','fiscal']) m,
     unnest(ARRAY['read','write','admin']) a
ON CONFLICT DO NOTHING;

-- ADMIN: 5 módulos completos + settings:read = 16 permisos
INSERT INTO role_permissions (role, module, action)
SELECT 'ADMIN'::user_role, m, a
FROM unnest(ARRAY['wms','ventas','crm','catalog','fiscal']) m,
     unnest(ARRAY['read','write','admin']) a
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action)
VALUES ('ADMIN','settings','read')
ON CONFLICT DO NOTHING;

-- OPERATOR: wms+ventas+crm read+write + catalog:read + fiscal:read = 8 permisos
INSERT INTO role_permissions (role, module, action)
SELECT 'OPERATOR'::user_role, m, a
FROM unnest(ARRAY['wms','ventas','crm']) m,
     unnest(ARRAY['read','write']) a
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action)
VALUES
  ('OPERATOR','catalog','read'),
  ('OPERATOR','fiscal', 'read')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────
-- SUPERUSER inicial
-- password: Ferrari2026! → hash bcrypt rounds=12
-- ─────────────────────────────────────────────────────
INSERT INTO users (
  company_id, username, email,
  password_hash, full_name, role, status
) VALUES (
  1,
  'superuser',
  'admin@ferrari-erp.com',
  '$2b$12$.NDdDl4Rvc7egQcAqQ2mC.TKXoSyfUgzI8JqEqui0dLH4yZOWAQuy',
  'Super Usuario',
  'SUPERUSER',
  'ACTIVE'
) ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────
-- cleanup_expired_sessions() — limpiar sesiones viejas
-- Llamar desde el job diario (dailyRatesFetch.js)
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_deleted INTEGER;
BEGIN
  DELETE FROM user_sessions
  WHERE expires_at < now()
     OR (revoked = TRUE AND revoked_at < now() - INTERVAL '7 days');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ─────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('users','user_sessions','role_permissions')
ORDER BY table_name;
-- Esperado: 3 filas

SELECT role::text, COUNT(*) AS perms
FROM role_permissions GROUP BY role ORDER BY role;
-- Esperado: ADMIN→16, OPERATOR→8, SUPERUSER→18

SELECT username, role::text, status::text FROM users;
-- Esperado: superuser | SUPERUSER | ACTIVE
