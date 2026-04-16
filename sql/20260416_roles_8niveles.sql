-- Roles 8 niveles + permisos — referencia legible (misma lógica que scripts/run-roles-8niveles-migration.js)
--
-- IMPORTANTE: no ejecutar este archivo con run-sql-file-pg en una sola query.
-- PostgreSQL: "unsafe use of new value ... New enum values must be committed before they can be used."
-- Usar siempre: npm run db:roles-8niveles
--
-- Requiere users.sql previo (tabla role_permissions, tipo user_role).

-- ── 1) Extender enum user_role (una sentencia por valor; idempotente vía pg_enum)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'SUPERVISOR'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'SUPERVISOR';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'VENDEDOR_MOSTRADOR'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'VENDEDOR_MOSTRADOR';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'VENDEDOR_EXTERNO'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'VENDEDOR_EXTERNO';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'OPERADOR_DIGITAL'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'OPERADOR_DIGITAL';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'ALMACENISTA'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'ALMACENISTA';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'CONTADOR'
  ) THEN
    ALTER TYPE user_role ADD VALUE 'CONTADOR';
  END IF;
END $$;

-- ── 2) Ampliar CHECK de módulos (nombre real en users.sql: chk_rp_module)
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS chk_rp_module;

ALTER TABLE role_permissions
  ADD CONSTRAINT chk_rp_module CHECK (module IN (
    'wms','ventas','crm','catalog','settings','fiscal',
    'compras','integraciones','reportes'
  ));

-- ── 3) Permisos por rol (INSERT idempotente)
-- SUPERUSER: todos los módulos × todas las acciones
INSERT INTO role_permissions (role, module, action)
SELECT 'SUPERUSER'::user_role, m, a
FROM unnest(ARRAY[
  'wms','ventas','crm','catalog','settings','fiscal','compras','integraciones','reportes'
]) AS m,
     unnest(ARRAY['read','write','admin']) AS a
ON CONFLICT DO NOTHING;

-- ADMIN: todos read+write+admin excepto catalog sin admin
INSERT INTO role_permissions (role, module, action)
SELECT 'ADMIN'::user_role, m, a
FROM unnest(ARRAY['wms','ventas','crm','settings','fiscal','compras','integraciones','reportes']) AS m,
     unnest(ARRAY['read','write','admin']) AS a
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, module, action)
SELECT 'ADMIN'::user_role, m, a
FROM unnest(ARRAY['catalog']) AS m,
     unnest(ARRAY['read','write']) AS a
ON CONFLICT DO NOTHING;

-- Política v4: ADMIN sin admin sobre catálogo
DELETE FROM role_permissions
WHERE role = 'ADMIN'::user_role AND module = 'catalog' AND action = 'admin';

-- SUPERVISOR
INSERT INTO role_permissions (role, module, action) VALUES
  ('SUPERVISOR','ventas','read'),
  ('SUPERVISOR','ventas','write'),
  ('SUPERVISOR','crm','read'),
  ('SUPERVISOR','wms','read'),
  ('SUPERVISOR','fiscal','read'),
  ('SUPERVISOR','reportes','read')
ON CONFLICT DO NOTHING;

-- VENDEDOR_MOSTRADOR / VENDEDOR_EXTERNO
INSERT INTO role_permissions (role, module, action) VALUES
  ('VENDEDOR_MOSTRADOR','ventas','read'),
  ('VENDEDOR_MOSTRADOR','ventas','write'),
  ('VENDEDOR_EXTERNO','ventas','read'),
  ('VENDEDOR_EXTERNO','ventas','write'),
  ('VENDEDOR_MOSTRADOR','crm','read'),
  ('VENDEDOR_EXTERNO','crm','read')
ON CONFLICT DO NOTHING;

-- OPERADOR_DIGITAL
INSERT INTO role_permissions (role, module, action) VALUES
  ('OPERADOR_DIGITAL','crm','read'),
  ('OPERADOR_DIGITAL','crm','write'),
  ('OPERADOR_DIGITAL','integraciones','read')
ON CONFLICT DO NOTHING;

-- ALMACENISTA
INSERT INTO role_permissions (role, module, action) VALUES
  ('ALMACENISTA','wms','read'),
  ('ALMACENISTA','wms','write'),
  ('ALMACENISTA','compras','read')
ON CONFLICT DO NOTHING;

-- CONTADOR
INSERT INTO role_permissions (role, module, action) VALUES
  ('CONTADOR','fiscal','read'),
  ('CONTADOR','settings','read')
ON CONFLICT DO NOTHING;

-- ROLLBACK (manual; no ejecutar en prod a ciegas):
-- DELETE FROM role_permissions WHERE role::text IN (
--   'SUPERVISOR','VENDEDOR_MOSTRADOR','VENDEDOR_EXTERNO','OPERADOR_DIGITAL','ALMACENISTA','CONTADOR'
-- );
-- No se puede revertir ADD VALUE del enum sin recrear el tipo; en desarrollo:
-- DROP TYPE user_role CASCADE y volver a ejecutar users.sql + esta migración.
