-- Durable research trace for EB Discovery Mode. These tables are isolated from
-- legacy Writer Studio data and from all existing EB V2 workflow records.
CREATE TABLE IF NOT EXISTS eb_v2_discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requested_sources JSONB NOT NULL DEFAULT '[]',
  coverage JSONB NOT NULL DEFAULT '[]',
  prompt TEXT,
  raw_output TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eb_v2_discovery_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES eb_v2_discovery_runs(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_name TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,
  language TEXT NOT NULL DEFAULT 'unknown',
  published_at TIMESTAMPTZ,
  engagement JSONB NOT NULL DEFAULT '{}',
  eligibility TEXT NOT NULL DEFAULT 'unreviewed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_discovery_sources_run_idx ON eb_v2_discovery_sources(run_id, created_at);

ALTER TABLE eb_v2_discovery_items
  ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES eb_v2_discovery_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS eb_v2_discovery_items_run_idx ON eb_v2_discovery_items(run_id, created_at DESC);

ALTER TABLE eb_v2_discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_discovery_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eb_v2_service_role_all ON eb_v2_discovery_runs;
CREATE POLICY eb_v2_service_role_all ON eb_v2_discovery_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS eb_v2_service_role_all ON eb_v2_discovery_sources;
CREATE POLICY eb_v2_service_role_all ON eb_v2_discovery_sources FOR ALL TO service_role USING (true) WITH CHECK (true);
