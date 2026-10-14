-- Derived cache for the Git-canonical .agent-hub Markdown library.
CREATE TABLE IF NOT EXISTS agent_library_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_sha TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  synced_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_library_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL UNIQUE,
  layer TEXT NOT NULL CHECK (layer IN ('project', 'design', 'backend', 'database', 'policy')),
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_count INTEGER NOT NULL CHECK (char_count >= 0),
  version_commit_sha TEXT NOT NULL REFERENCES agent_library_versions(commit_sha) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_library_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES agent_library_documents(id) ON DELETE CASCADE,
  layer TEXT NOT NULL CHECK (layer IN ('project', 'design', 'backend', 'database', 'policy')),
  heading TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, position)
);
CREATE INDEX IF NOT EXISTS agent_library_chunks_layer_idx ON agent_library_chunks(layer, position);
CREATE INDEX IF NOT EXISTS agent_library_chunks_document_idx ON agent_library_chunks(document_id, position);

ALTER TABLE agent_library_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_library_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_library_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_library_versions_service_role_all ON agent_library_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_library_documents_service_role_all ON agent_library_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_library_chunks_service_role_all ON agent_library_chunks FOR ALL TO service_role USING (true) WITH CHECK (true);
