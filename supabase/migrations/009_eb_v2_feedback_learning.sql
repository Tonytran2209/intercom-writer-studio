-- Durable, revision-safe feedback for the EB V2 article and channel workflow.
-- This is additive and intentionally does not touch legacy Writer Studio tables.

CREATE TABLE IF NOT EXISTS eb_v2_feedback_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES eb_v2_packages(id) ON DELETE CASCADE,
  article_id UUID REFERENCES eb_v2_articles(id) ON DELETE SET NULL,
  channel_output_id UUID REFERENCES eb_v2_channel_outputs(id) ON DELETE SET NULL,
  parent_feedback_id UUID REFERENCES eb_v2_feedback_threads(id) ON DELETE CASCADE,
  gate TEXT NOT NULL CHECK (gate IN ('article', 'review')),
  channel TEXT CHECK (channel IN ('threads', 'facebook', 'linkedin')),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  message_markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'accepted', 'discarded')),
  result_article_id UUID REFERENCES eb_v2_articles(id) ON DELETE SET NULL,
  result_channel_output_id UUID REFERENCES eb_v2_channel_outputs(id) ON DELETE SET NULL,
  prompt_snapshot JSONB NOT NULL DEFAULT '{}',
  rule_snapshot JSONB NOT NULL DEFAULT '{}',
  model_provider TEXT,
  model_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_feedback_threads_package_created_idx ON eb_v2_feedback_threads(package_id, created_at ASC);
CREATE INDEX IF NOT EXISTS eb_v2_feedback_threads_article_created_idx ON eb_v2_feedback_threads(article_id, created_at ASC);
CREATE INDEX IF NOT EXISTS eb_v2_feedback_threads_channel_created_idx ON eb_v2_feedback_threads(channel_output_id, created_at ASC);

-- A signal is created only when a person explicitly accepts a feedback revision.
CREATE TABLE IF NOT EXISTS eb_v2_learning_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID NOT NULL UNIQUE REFERENCES eb_v2_feedback_threads(id) ON DELETE CASCADE,
  package_id UUID REFERENCES eb_v2_packages(id) ON DELETE SET NULL,
  gate TEXT NOT NULL CHECK (gate IN ('article', 'review')),
  channel TEXT CHECK (channel IN ('threads', 'facebook', 'linkedin')),
  instruction TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eb_v2_learning_signals_lookup_idx ON eb_v2_learning_signals(active, gate, channel, created_at DESC);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS eb_v2_feedback_threads_updated_at ON eb_v2_feedback_threads;
  CREATE TRIGGER eb_v2_feedback_threads_updated_at BEFORE UPDATE ON eb_v2_feedback_threads FOR EACH ROW EXECUTE FUNCTION eb_v2_set_updated_at();
  DROP TRIGGER IF EXISTS eb_v2_learning_signals_updated_at ON eb_v2_learning_signals;
  CREATE TRIGGER eb_v2_learning_signals_updated_at BEFORE UPDATE ON eb_v2_learning_signals FOR EACH ROW EXECUTE FUNCTION eb_v2_set_updated_at();
END $$;

ALTER TABLE eb_v2_feedback_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE eb_v2_learning_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY eb_v2_service_role_all ON eb_v2_feedback_threads FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY eb_v2_service_role_all ON eb_v2_learning_signals FOR ALL TO service_role USING (true) WITH CHECK (true);
