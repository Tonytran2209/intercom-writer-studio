-- Derived cache for the Git-canonical .agent-hub Markdown library.
CREATE TABLE IF NOT EXISTS intercom_writer_agent_library_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_sha TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  synced_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intercom_writer_agent_library_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL UNIQUE,
  layer TEXT NOT NULL CHECK (layer IN ('project', 'design', 'backend', 'database', 'policy')),
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_count INTEGER NOT NULL CHECK (char_count >= 0),
  version_commit_sha TEXT NOT NULL REFERENCES intercom_writer_agent_library_versions(commit_sha) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS intercom_writer_agent_library_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES intercom_writer_agent_library_documents(id) ON DELETE CASCADE,
  layer TEXT NOT NULL CHECK (layer IN ('project', 'design', 'backend', 'database', 'policy')),
  heading TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- `IF NOT EXISTS` does not alter a table created by an earlier partial run.
-- Reconcile that case before referencing the index column below.
ALTER TABLE intercom_writer_agent_library_chunks ADD COLUMN IF NOT EXISTS position INTEGER;
WITH numbered_chunks AS (
  SELECT id, row_number() OVER (PARTITION BY document_id ORDER BY created_at, id) - 1 AS next_position
  FROM intercom_writer_agent_library_chunks
  WHERE position IS NULL
)
UPDATE intercom_writer_agent_library_chunks AS chunk
SET position = numbered_chunks.next_position
FROM numbered_chunks
WHERE chunk.id = numbered_chunks.id;
ALTER TABLE intercom_writer_agent_library_chunks ALTER COLUMN position SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS intercom_writer_agent_library_chunks_document_position_idx ON intercom_writer_agent_library_chunks(document_id, position);
CREATE INDEX IF NOT EXISTS intercom_writer_agent_library_chunks_layer_idx ON intercom_writer_agent_library_chunks(layer, position);
CREATE INDEX IF NOT EXISTS intercom_writer_agent_library_chunks_document_idx ON intercom_writer_agent_library_chunks(document_id, position);

ALTER TABLE intercom_writer_agent_library_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercom_writer_agent_library_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercom_writer_agent_library_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intercom_writer_agent_library_versions_service_role_all ON intercom_writer_agent_library_versions;
DROP POLICY IF EXISTS intercom_writer_agent_library_documents_service_role_all ON intercom_writer_agent_library_documents;
DROP POLICY IF EXISTS intercom_writer_agent_library_chunks_service_role_all ON intercom_writer_agent_library_chunks;
CREATE POLICY intercom_writer_agent_library_versions_service_role_all ON intercom_writer_agent_library_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY intercom_writer_agent_library_documents_service_role_all ON intercom_writer_agent_library_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY intercom_writer_agent_library_chunks_service_role_all ON intercom_writer_agent_library_chunks FOR ALL TO service_role USING (true) WITH CHECK (true);
