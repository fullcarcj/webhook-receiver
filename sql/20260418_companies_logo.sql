-- Empresa: logo y ubicación (config panel)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS city      TEXT,
  ADD COLUMN IF NOT EXISTS country   TEXT DEFAULT 'Venezuela';
