-- S3 — merge_candidates + customer_merge_log (deduplicación CRM)
-- Requiere: pg_trgm (similarity), customers(id BIGINT)
-- UNIQUE en par (min,max) vía índice expresión (compatible Render).

CREATE TABLE IF NOT EXISTS merge_candidates (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  customer_id_a    BIGINT NOT NULL
                     REFERENCES customers(id)
                     ON DELETE CASCADE,
  customer_id_b    BIGINT NOT NULL
                     REFERENCES customers(id)
                     ON DELETE CASCADE,
  score            INTEGER NOT NULL,
  score_breakdown  JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN (
                       'pending',
                       'approved',
                       'rejected',
                       'auto_approved'
                     )),
  reviewed_by      INTEGER,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_merge_candidates_order CHECK (customer_id_a < customer_id_b)
);

DROP INDEX IF EXISTS uq_merge_candidates_pair;
CREATE UNIQUE INDEX uq_merge_candidates_pair
  ON merge_candidates (customer_id_a, customer_id_b);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_company_status
  ON merge_candidates (company_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_candidates_a ON merge_candidates (customer_id_a);
CREATE INDEX IF NOT EXISTS idx_merge_candidates_b ON merge_candidates (customer_id_b);

CREATE TABLE IF NOT EXISTS customer_merge_log (
  id               BIGSERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  kept_id          BIGINT NOT NULL,
  dropped_id       BIGINT NOT NULL,
  triggered_by     TEXT NOT NULL,
  score            INTEGER,
  score_breakdown  JSONB,
  snapshot_kept    JSONB NOT NULL,
  snapshot_dropped JSONB NOT NULL,
  rows_affected    JSONB NOT NULL DEFAULT '{}',
  merged_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_merge_log_company ON customer_merge_log (company_id);
CREATE INDEX IF NOT EXISTS idx_customer_merge_log_kept ON customer_merge_log (kept_id);
CREATE INDEX IF NOT EXISTS idx_customer_merge_log_dropped ON customer_merge_log (dropped_id);

CREATE OR REPLACE FUNCTION fn_merge_candidates_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_merge_candidates_updated_at ON merge_candidates;
CREATE TRIGGER trg_merge_candidates_updated_at
  BEFORE UPDATE ON merge_candidates
  FOR EACH ROW EXECUTE FUNCTION fn_merge_candidates_set_updated_at();
