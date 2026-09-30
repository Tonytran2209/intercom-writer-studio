-- EB Writer Studio V2
--
-- This migration is intentionally additive. It never reads, updates, renames,
-- or drops legacy Writer Studio tables (kv_store, content_plans,
-- writer_articles, etc.). Run it against the existing Supabase project only
-- after it has been reviewed in the Supabase SQL editor or migration runner.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The four uploaded EB reference collections and their parsed content.
CREATE TABLE IF NOT EXISTS eb_v2_library_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug IN ('pillar-library', 'persona-library', 'article-library', 'channel-rules')),
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source_path TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A single writing package travels through Brief, Website article, Adapt and Review.
CREATE TABLE IF NOT EXISTS eb_v2_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'brief' CHECK (state IN ('brief', 'article', 'adapt', 'review', 'completed', 'rejected', 'archived')),
  source_type TEXT NOT NULL CHECK (source_type IN ('input', 'upload', 'discovery')),
  pillar_slug TEXT,
  persona_slug TEXT,
  article_type TEXT,
  brief_approved_at TIMESTAMPTZ,
  article_approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_packages_state_updated_idx ON eb_v2_packages(state, updated_at DESC);

-- Immutable original input. The optional raw object stores upload metadata,
-- selected Discovery source, and source checks without requiring legacy storage.
CREATE TABLE IF NOT EXISTS eb_v2_package_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES eb_v2_packages(id) ON DELETE CASCADE,
  input_text TEXT,
  upload_name TEXT,
  upload_storage_path TEXT,
  raw_snapshot JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_package_inputs_package_idx ON eb_v2_package_inputs(package_id, created_at DESC);

-- Saved Discovery proposals become traceable training material. A proposal can
-- optionally become one package, but is never auto-approved by the database.
CREATE TABLE IF NOT EXISTS eb_v2_discovery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source_summary TEXT,
  pillar_candidate TEXT,
  persona_candidate TEXT,
  evidence JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'used', 'dismissed', 'archived')),
  package_id UUID REFERENCES eb_v2_packages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_discovery_items_status_updated_idx ON eb_v2_discovery_items(status, updated_at DESC);

-- A durable, append-only snapshot for every Gate and sub-stage. This supports
-- Brief validation, the three Gate-2 calls, per-channel adaptation and review.
CREATE TABLE IF NOT EXISTS eb_v2_gate_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES eb_v2_packages(id) ON DELETE CASCADE,
  gate TEXT NOT NULL CHECK (gate IN ('brief', 'article', 'adapt', 'review')),
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  rule_snapshot JSONB NOT NULL DEFAULT '{}',
  input_snapshot JSONB NOT NULL DEFAULT '{}',
  output_snapshot JSONB NOT NULL DEFAULT '{}',
  model_provider TEXT,
  model_id TEXT,
  prompt_version TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_gate_runs_package_gate_idx ON eb_v2_gate_runs(package_id, gate, created_at DESC);
CREATE INDEX IF NOT EXISTS eb_v2_gate_runs_status_idx ON eb_v2_gate_runs(status, created_at DESC);

-- The approved Gate-2 website article. Revisions make regeneration auditable.
CREATE TABLE IF NOT EXISTS eb_v2_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES eb_v2_packages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'rejected')),
  article_spec JSONB NOT NULL DEFAULT '{}',
  outline JSONB NOT NULL DEFAULT '[]',
  body_markdown TEXT NOT NULL DEFAULT '',
  quality_report JSONB NOT NULL DEFAULT '{}',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(package_id, revision)
);
CREATE INDEX IF NOT EXISTS eb_v2_articles_package_status_idx ON eb_v2_articles(package_id, status, revision DESC);

-- One independently reviewable output per channel/revision.
CREATE TABLE IF NOT EXISTS eb_v2_channel_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES eb_v2_packages(id) ON DELETE CASCADE,
  article_id UUID REFERENCES eb_v2_articles(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('threads', 'facebook', 'linkedin')),
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'ready_for_review', 'done', 'recheck', 'rejected')),
  content JSONB NOT NULL DEFAULT '{}',
  repetition_report JSONB NOT NULL DEFAULT '{}',
  model_provider TEXT,
  model_id TEXT,
  generated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(package_id, channel, revision)
);
CREATE INDEX IF NOT EXISTS eb_v2_channel_outputs_package_status_idx ON eb_v2_channel_outputs(package_id, status, updated_at DESC);

-- Human Gate-3 decisions are append-only, so an older decision is never lost.
CREATE TABLE IF NOT EXISTS eb_v2_review_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_output_id UUID NOT NULL REFERENCES eb_v2_channel_outputs(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('done', 'reject', 'recheck')),
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_review_actions_output_idx ON eb_v2_review_actions(channel_output_id, created_at DESC);

-- One namespaced document for runtime choices, avoiding writer:config / kv_store.
CREATE TABLE IF NOT EXISTS eb_v2_app_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  settings JSONB NOT NULL DEFAULT '{}',
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION eb_v2_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'eb_v2_library_documents', 'eb_v2_packages', 'eb_v2_discovery_items',
    'eb_v2_articles', 'eb_v2_channel_outputs', 'eb_v2_app_settings'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION eb_v2_set_updated_at()', table_name, table_name);
  END LOOP;
END $$;

-- Backend-only by default. No anon/authenticated policies are granted. The
-- Railway service key can access V2 through its existing server-side client.
ALTER TABLE eb_v2_library_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_package_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_discovery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_gate_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_channel_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_review_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_app_settings ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'eb_v2_library_documents', 'eb_v2_packages', 'eb_v2_package_inputs',
    'eb_v2_discovery_items', 'eb_v2_gate_runs', 'eb_v2_articles',
    'eb_v2_channel_outputs', 'eb_v2_review_actions', 'eb_v2_app_settings'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS eb_v2_service_role_all ON %I', table_name);
    EXECUTE format('CREATE POLICY eb_v2_service_role_all ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', table_name);
  END LOOP;
END $$;
