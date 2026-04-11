-- Ferrari ERP — Numeración fiscal venezolana (Providencia SNAT/2011/00071)
-- Documentos: FACTURA · NOTA_DEBITO · NOTA_CREDITO · COMPROBANTE_RETENCION
-- Formato control: 00-XXXXXXXX   Formato doc: FAC-XXXXXXXX etc.
-- Método de emisión: configurable en settings_tax.fiscal_emission_method
--   FORMA_LIBRE    → número definitivo inmediato
--   MAQUINA_FISCAL → número provisional, se confirma luego
--   PORTAL_SENIAT  → número provisional, se confirma luego
-- Regla de oro: números anulados NUNCA se reutilizan.
--
-- Prerrequisitos:
--   sql/exchange-rates.sql (set_updated_at, daily_exchange_rates, sales, purchases)
--   sql/igtf.sql            (nada se importa, pero retentions viene de fiscal-periods.sql)
--   sql/fiscal-periods.sql  (settings_tax, get_tax_setting*, fiscal_periods, tax_transactions, retentions)
-- Idempotente. Ejecutar:
--   psql $DATABASE_URL -f sql/fiscal-numbering.sql
--   npm run db:fiscal-numbering

-- ─────────────────────────────────────────────────────
-- ENUMs
-- ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE fiscal_doc_type AS ENUM (
    'FACTURA',
    'NOTA_DEBITO',
    'NOTA_CREDITO',
    'COMPROBANTE_RETENCION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fiscal_doc_status AS ENUM (
    'DRAFT',
    'ISSUED',
    'CANCELLED',
    'VOIDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────
-- Agregar fiscal_emission_method a settings_tax
-- settings_tax ya existe (sql/fiscal-periods.sql).
-- Solo agregar la fila nueva; NO recrear la tabla.
-- ─────────────────────────────────────────────────────
INSERT INTO settings_tax
  (company_id, key, value, value_type,
   description, allowed_values, effective_from)
VALUES
  (1, 'fiscal_emission_method', 'FORMA_LIBRE', 'enum',
   'Método de emisión fiscal: '
   'FORMA_LIBRE = número definitivo inmediato, '
   'MAQUINA_FISCAL = número provisional actualizable, '
   'PORTAL_SENIAT = número provisional actualizable',
   'FORMA_LIBRE,MAQUINA_FISCAL,PORTAL_SENIAT',
   DATE '2020-01-01')
ON CONFLICT (company_id, key, effective_from) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- fiscal_sequences — contadores por tipo de documento
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fiscal_sequences (
  id              SERIAL          PRIMARY KEY,
  company_id      INTEGER         NOT NULL DEFAULT 1,
  doc_type        fiscal_doc_type NOT NULL,

  control_prefix  TEXT            NOT NULL DEFAULT '00',
  control_current BIGINT          NOT NULL DEFAULT 0,
  control_max     BIGINT          NOT NULL DEFAULT 99999999,

  doc_prefix      TEXT            NOT NULL DEFAULT '',
  doc_current     BIGINT          NOT NULL DEFAULT 0,

  serie           TEXT            NOT NULL DEFAULT 'A',
  is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

  CONSTRAINT uq_seq_company_type_serie
    UNIQUE (company_id, doc_type, serie),
  CONSTRAINT chk_seq_range
    CHECK (control_current <= control_max),
  CONSTRAINT chk_seq_control_pos
    CHECK (control_current >= 0),
  CONSTRAINT chk_seq_doc_pos
    CHECK (doc_current >= 0)
);

CREATE INDEX IF NOT EXISTS idx_seq_company_type
  ON fiscal_sequences (company_id, doc_type, is_active);

DROP TRIGGER IF EXISTS trg_seq_updated_at ON fiscal_sequences;
CREATE TRIGGER trg_seq_updated_at
  BEFORE UPDATE ON fiscal_sequences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO fiscal_sequences
  (company_id, doc_type, control_prefix, doc_prefix, serie)
VALUES
  (1, 'FACTURA',               '00', 'FAC-', 'A'),
  (1, 'NOTA_DEBITO',           '00', 'ND-',  'A'),
  (1, 'NOTA_CREDITO',          '00', 'NC-',  'A'),
  (1, 'COMPROBANTE_RETENCION', '00', 'RET-', 'A')
ON CONFLICT (company_id, doc_type, serie) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- next_fiscal_number() — generación atómica de números
-- LLAMAR SIEMPRE dentro de una transacción (BEGIN…COMMIT).
-- La función issue_fiscal_document() ya maneja esto.
-- Desde Node.js NUNCA llamar directamente.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION next_fiscal_number(
  p_doc_type   fiscal_doc_type,
  p_company_id INTEGER DEFAULT 1
)
RETURNS TABLE (
  control_number TEXT,
  doc_number     TEXT,
  sequence_id    INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
  v_seq fiscal_sequences%ROWTYPE;
BEGIN
  SELECT * INTO v_seq
  FROM fiscal_sequences
  WHERE company_id = p_company_id
    AND doc_type   = p_doc_type
    AND is_active  = TRUE
  ORDER BY serie DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'No hay secuencia activa para tipo % empresa %',
      p_doc_type, p_company_id;
  END IF;

  IF v_seq.control_current >= v_seq.control_max THEN
    RAISE EXCEPTION
      'Talonario agotado para % (secuencia id=%). '
      'Usar PATCH /api/fiscal/sequences/% para abrir nueva serie.',
      p_doc_type, v_seq.id, v_seq.id;
  END IF;

  UPDATE fiscal_sequences SET
    control_current = control_current + 1,
    doc_current     = doc_current + 1,
    updated_at      = now()
  WHERE id = v_seq.id;

  RETURN QUERY SELECT
    v_seq.control_prefix
      || '-'
      || LPAD((v_seq.control_current + 1)::TEXT, 8, '0'),
    v_seq.doc_prefix
      || LPAD((v_seq.doc_current + 1)::TEXT, 8, '0'),
    v_seq.id;
END;
$$;

-- ─────────────────────────────────────────────────────
-- fiscal_documents — registro de cada documento emitido
-- control_number y doc_number son únicos (ley venezolana).
-- CANCELLED: número reservado permanentemente.
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fiscal_documents (
  id                  BIGSERIAL         PRIMARY KEY,
  company_id          INTEGER           NOT NULL DEFAULT 1,
  doc_type            fiscal_doc_type   NOT NULL,
  status              fiscal_doc_status NOT NULL DEFAULT 'DRAFT',
  emission_method     TEXT              NOT NULL DEFAULT 'FORMA_LIBRE',

  control_number      TEXT              NOT NULL,
  doc_number          TEXT              NOT NULL,
  external_number     TEXT,
  issue_date          DATE              NOT NULL DEFAULT CURRENT_DATE,

  receptor_rif        TEXT,
  receptor_name       TEXT,
  receptor_address    TEXT,

  sale_id             BIGINT REFERENCES sales(id),
  purchase_id         BIGINT REFERENCES purchases(id),
  retention_id        BIGINT REFERENCES retentions(id),

  related_doc_id      BIGINT REFERENCES fiscal_documents(id),
  related_doc_reason  TEXT,

  base_imponible_usd  NUMERIC(15,4)     NOT NULL DEFAULT 0,
  iva_rate_pct        NUMERIC(7,4),
  iva_usd             NUMERIC(15,4)     NOT NULL DEFAULT 0,
  igtf_usd            NUMERIC(15,4)     NOT NULL DEFAULT 0,
  total_usd           NUMERIC(15,4)     NOT NULL DEFAULT 0,

  rate_applied        NUMERIC(15,6),
  base_imponible_bs   NUMERIC(18,2),
  iva_bs              NUMERIC(18,2),
  total_bs            NUMERIC(18,2),

  cancelled_at        TIMESTAMPTZ,
  cancelled_by        INTEGER,
  cancellation_reason TEXT,

  fiscal_period_id    BIGINT REFERENCES fiscal_periods(id),
  sequence_id         INTEGER REFERENCES fiscal_sequences(id),

  notes               TEXT,
  created_at          TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ       NOT NULL DEFAULT now(),

  CONSTRAINT uq_control_number UNIQUE (company_id, control_number),
  CONSTRAINT uq_doc_number     UNIQUE (company_id, doc_number),
  CONSTRAINT chk_fd_total      CHECK (total_usd >= 0),
  CONSTRAINT chk_fd_base       CHECK (base_imponible_usd >= 0),
  CONSTRAINT chk_fd_iva        CHECK (iva_usd >= 0),
  CONSTRAINT chk_fd_igtf       CHECK (igtf_usd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_fd_company_type_date
  ON fiscal_documents (company_id, doc_type, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_fd_sale
  ON fiscal_documents (sale_id)
  WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fd_period
  ON fiscal_documents (fiscal_period_id)
  WHERE fiscal_period_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fd_receptor_rif
  ON fiscal_documents (receptor_rif)
  WHERE receptor_rif IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fd_status
  ON fiscal_documents (status, issue_date DESC);

DROP TRIGGER IF EXISTS trg_fd_updated_at ON fiscal_documents;
CREATE TRIGGER trg_fd_updated_at
  BEFORE UPDATE ON fiscal_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────
-- issue_fiscal_document() — emisión atómica
--
-- STATUS según método:
--   FORMA_LIBRE    → ISSUED (número definitivo inmediato)
--   MAQUINA_FISCAL → DRAFT  (provisional; confirmar con PATCH)
--   PORTAL_SENIAT  → DRAFT  (provisional; confirmar con PATCH)
--
-- NOTA_CREDITO en tax_transactions usa source_type='adjustment'
-- (monto negativo) para respetar el constraint chk_tt_base
-- de la tabla tax_transactions.
--
-- Si no hay período IVA activo: documento se crea sin
-- tax_transaction (fiscal_period_id=NULL). No es un error.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION issue_fiscal_document(
  p_company_id         INTEGER,
  p_doc_type           fiscal_doc_type,
  p_emission_method    TEXT,
  p_issue_date         DATE,
  p_receptor_rif       TEXT,
  p_receptor_name      TEXT,
  p_receptor_address   TEXT,
  p_base_imponible_usd NUMERIC(15,4),
  p_iva_rate_pct       NUMERIC(7,4),
  p_igtf_usd           NUMERIC(15,4) DEFAULT 0,
  p_sale_id            BIGINT        DEFAULT NULL,
  p_purchase_id        BIGINT        DEFAULT NULL,
  p_retention_id       BIGINT        DEFAULT NULL,
  p_related_doc_id     BIGINT        DEFAULT NULL,
  p_related_doc_reason TEXT          DEFAULT NULL,
  p_notes              TEXT          DEFAULT NULL
)
RETURNS fiscal_documents LANGUAGE plpgsql AS $$
DECLARE
  v_num        RECORD;
  v_doc        fiscal_documents%ROWTYPE;
  v_iva_usd    NUMERIC(15,4);
  v_total_usd  NUMERIC(15,4);
  v_rate       NUMERIC(15,6);
  v_period_id  BIGINT;
  v_status     fiscal_doc_status;
  v_base_sign  NUMERIC(15,4);
  v_iva_sign   NUMERIC(15,4);
  v_src_type   TEXT;
BEGIN
  v_iva_usd   := ROUND(
    p_base_imponible_usd * COALESCE(p_iva_rate_pct, 0) / 100, 4
  );
  v_total_usd := p_base_imponible_usd
                 + v_iva_usd
                 + COALESCE(p_igtf_usd, 0);

  v_status := CASE UPPER(TRIM(COALESCE(p_emission_method, 'FORMA_LIBRE')))
    WHEN 'FORMA_LIBRE' THEN 'ISSUED'::fiscal_doc_status
    ELSE                    'DRAFT'::fiscal_doc_status
  END;

  SELECT active_rate INTO v_rate
  FROM daily_exchange_rates
  WHERE company_id  = p_company_id
    AND rate_date  <= p_issue_date
    AND active_rate IS NOT NULL
  ORDER BY rate_date DESC LIMIT 1;

  SELECT id INTO v_period_id
  FROM fiscal_periods
  WHERE company_id     = p_company_id
    AND tax_type::TEXT = 'IVA'
    AND date_from     <= p_issue_date
    AND date_to       >= p_issue_date
    AND status         = 'OPEN'
  LIMIT 1;

  SELECT * INTO v_num
  FROM next_fiscal_number(p_doc_type, p_company_id);

  INSERT INTO fiscal_documents (
    company_id, doc_type, status, emission_method,
    control_number, doc_number, issue_date,
    receptor_rif, receptor_name, receptor_address,
    sale_id, purchase_id, retention_id,
    related_doc_id, related_doc_reason,
    base_imponible_usd, iva_rate_pct, iva_usd,
    igtf_usd, total_usd, rate_applied,
    base_imponible_bs, iva_bs, total_bs,
    fiscal_period_id, sequence_id, notes
  ) VALUES (
    p_company_id, p_doc_type, v_status,
    UPPER(TRIM(COALESCE(p_emission_method, 'FORMA_LIBRE'))),
    v_num.control_number, v_num.doc_number, p_issue_date,
    NULLIF(TRIM(COALESCE(p_receptor_rif,     '')), ''),
    NULLIF(TRIM(COALESCE(p_receptor_name,    '')), ''),
    NULLIF(TRIM(COALESCE(p_receptor_address, '')), ''),
    p_sale_id, p_purchase_id, p_retention_id,
    p_related_doc_id, p_related_doc_reason,
    p_base_imponible_usd, p_iva_rate_pct, v_iva_usd,
    COALESCE(p_igtf_usd, 0), v_total_usd, v_rate,
    ROUND(p_base_imponible_usd * COALESCE(v_rate, 0), 2),
    ROUND(v_iva_usd            * COALESCE(v_rate, 0), 2),
    ROUND(v_total_usd          * COALESCE(v_rate, 0), 2),
    v_period_id, v_num.sequence_id, p_notes
  )
  RETURNING * INTO v_doc;

  -- Registrar en tax_transactions si hay período IVA activo
  -- y la tasa es > 0 y la base imponible es > 0.
  -- NOTA_CREDITO usa source_type='adjustment' con montos negativos
  -- para respetar el constraint chk_tt_base (base <> 0 para adjustments).
  IF v_period_id IS NOT NULL
     AND p_base_imponible_usd > 0
     AND COALESCE(p_iva_rate_pct, 0) > 0 THEN

    -- Para NC: montos negativos (reduce el débito fiscal del período)
    v_base_sign := CASE WHEN p_doc_type = 'NOTA_CREDITO'
                    THEN -p_base_imponible_usd
                    ELSE  p_base_imponible_usd END;
    v_iva_sign  := CASE WHEN p_doc_type = 'NOTA_CREDITO'
                    THEN -v_iva_usd
                    ELSE  v_iva_usd END;

    -- NC usa 'adjustment' para permitir base negativa;
    -- FACTURA y ND usan 'sale'
    v_src_type  := CASE p_doc_type
                    WHEN 'NOTA_CREDITO' THEN 'adjustment'
                    ELSE 'sale'
                   END;

    INSERT INTO tax_transactions (
      company_id, fiscal_period_id, tax_type,
      source_type, source_id, transaction_date,
      base_amount_usd, tax_rate_pct, tax_amount_usd,
      rate_applied, base_amount_bs, tax_amount_bs, notes
    ) VALUES (
      p_company_id, v_period_id, 'IVA',
      v_src_type,
      COALESCE(p_sale_id, v_doc.id),
      p_issue_date,
      v_base_sign,
      p_iva_rate_pct,
      v_iva_sign,
      v_rate,
      ROUND(v_base_sign * COALESCE(v_rate, 0), 2),
      ROUND(v_iva_sign  * COALESCE(v_rate, 0), 2),
      v_num.doc_number
    );
  END IF;

  RETURN v_doc;
END;
$$;

-- ─────────────────────────────────────────────────────
-- cancel_fiscal_document() — anular documento
-- Número queda reservado permanentemente (ley venezolana).
-- Inserta tax_transaction negativo (source_type='adjustment')
-- para compensar el IVA del período.
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_fiscal_document(
  p_doc_id  BIGINT,
  p_user_id INTEGER,
  p_reason  TEXT
)
RETURNS fiscal_documents LANGUAGE plpgsql AS $$
DECLARE
  v_doc fiscal_documents%ROWTYPE;
BEGIN
  SELECT * INTO v_doc
  FROM fiscal_documents WHERE id = p_doc_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Documento % no encontrado', p_doc_id;
  END IF;
  IF v_doc.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Documento % ya está anulado', p_doc_id;
  END IF;
  IF v_doc.status = 'DRAFT' THEN
    RAISE EXCEPTION
      'Documento DRAFT: eliminar directamente (DELETE), '
      'no anular. Los borradores no ocupan número fiscal definitivo.';
  END IF;

  UPDATE fiscal_documents SET
    status              = 'CANCELLED',
    cancelled_at        = now(),
    cancelled_by        = p_user_id,
    cancellation_reason = NULLIF(TRIM(COALESCE(p_reason, '')), ''),
    updated_at          = now()
  WHERE id = p_doc_id
  RETURNING * INTO v_doc;

  -- Revertir IVA en tax_transactions usando 'adjustment'
  -- (montos negativos están permitidos para ese source_type)
  IF v_doc.fiscal_period_id IS NOT NULL
     AND v_doc.base_imponible_usd > 0
     AND COALESCE(v_doc.iva_rate_pct, 0) > 0 THEN
    INSERT INTO tax_transactions (
      company_id, fiscal_period_id, tax_type,
      source_type, source_id, transaction_date,
      base_amount_usd, tax_rate_pct, tax_amount_usd,
      notes
    ) VALUES (
      v_doc.company_id, v_doc.fiscal_period_id, 'IVA',
      'adjustment', v_doc.id, CURRENT_DATE,
      -v_doc.base_imponible_usd,
      v_doc.iva_rate_pct,
      -v_doc.iva_usd,
      'Ajuste por anulación de '
        || v_doc.doc_number || ': '
        || COALESCE(p_reason, 'sin motivo')
    );
  END IF;

  RETURN v_doc;
END;
$$;

-- ─────────────────────────────────────────────────────
-- Vista: Libro de Ventas
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_libro_ventas AS
SELECT
  fd.id,
  fd.issue_date,
  fd.doc_number,
  fd.control_number,
  fd.external_number,
  fd.emission_method,
  fd.receptor_rif,
  fd.receptor_name,
  fd.doc_type,
  fd.status,
  fd.base_imponible_usd,
  fd.iva_rate_pct,
  fd.iva_usd,
  fd.igtf_usd,
  fd.total_usd,
  fd.rate_applied,
  fd.base_imponible_bs,
  fd.iva_bs,
  fd.total_bs,
  DATE_TRUNC('month', fd.issue_date)::DATE AS period_month,
  fd.fiscal_period_id,
  fd.company_id,
  fd.sale_id,
  fd.notes
FROM fiscal_documents fd
WHERE fd.doc_type IN ('FACTURA','NOTA_DEBITO','NOTA_CREDITO')
ORDER BY fd.issue_date, fd.control_number;

-- ─────────────────────────────────────────────────────
-- Vista: Totales del Libro de Ventas por período
-- ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_libro_ventas_totales AS
SELECT
  DATE_TRUNC('month', fd.issue_date)::DATE AS period_month,
  fd.company_id,
  COUNT(*) FILTER (WHERE fd.status = 'ISSUED')    AS docs_issued,
  COUNT(*) FILTER (WHERE fd.status = 'CANCELLED') AS docs_cancelled,
  COUNT(*) FILTER (WHERE fd.status = 'DRAFT')     AS docs_pending,
  SUM(fd.base_imponible_usd) FILTER (WHERE fd.status = 'ISSUED') AS total_base_usd,
  SUM(fd.iva_usd)            FILTER (WHERE fd.status = 'ISSUED') AS total_iva_usd,
  SUM(fd.igtf_usd)           FILTER (WHERE fd.status = 'ISSUED') AS total_igtf_usd,
  SUM(fd.total_usd)          FILTER (WHERE fd.status = 'ISSUED') AS total_usd,
  SUM(fd.base_imponible_bs)  FILTER (WHERE fd.status = 'ISSUED') AS total_base_bs,
  SUM(fd.iva_bs)             FILTER (WHERE fd.status = 'ISSUED') AS total_iva_bs,
  SUM(fd.total_bs)           FILTER (WHERE fd.status = 'ISSUED') AS total_bs
FROM fiscal_documents fd
WHERE fd.doc_type IN ('FACTURA','NOTA_DEBITO','NOTA_CREDITO')
GROUP BY DATE_TRUNC('month', fd.issue_date), fd.company_id
ORDER BY period_month DESC;

-- ─────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('fiscal_sequences','fiscal_documents')
ORDER BY table_name;
-- Esperado: 2 filas

SELECT doc_type, control_prefix, doc_prefix,
       serie, control_current, control_max
FROM fiscal_sequences WHERE company_id = 1 ORDER BY doc_type;
-- Esperado: 4 filas, control_current = 0

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'next_fiscal_number',
    'issue_fiscal_document',
    'cancel_fiscal_document')
ORDER BY routine_name;
-- Esperado: 3 filas

SELECT key, value FROM settings_tax
WHERE key = 'fiscal_emission_method';
-- Esperado: value = 'FORMA_LIBRE'
