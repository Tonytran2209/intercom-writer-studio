---
id: agent-hub-data-model
layer: database
status: canonical
source_paths: [supabase/migrations]
---
# Data model and migration ownership

Supabase PostgreSQL is server-persisted through `backend/supabase.ts`; browser code calls Railway, not Supabase directly. Migrations `001`–`009` are the schema history and must remain immutable.

## Existing domains

- Legacy: KV store, relational content plans/items/articles, three-stage sessions, article specs/quality, website inventory/crawl summaries.
- EB V2: settings, library documents, packages/input snapshots, discovery runs/sources/items, gate runs, articles, channel outputs/review actions, feedback threads, learning signals.

Most EB V2 records retain snapshots, status, timestamps, and foreign keys so content production is auditable. `eb_v2_*` schema changes must not alter legacy semantics.

## Agent Library index

Migration `010_agent_library_index.sql` adds cache/index tables only:

- `agent_library_versions`: Git commit/content-index run metadata.
- `agent_library_documents`: allow-listed canonical path, layer, content hash and size.
- `agent_library_chunks`: heading-based retrieval text with ordering and per-chunk hash.

`.agent-hub` in Git is canonical. These tables are a derived cache, never a source to edit documents. Re-indexing the same content hash must be idempotent.

All tables use RLS and service-role policies because Railway is the persistence boundary. Retention is Git-led: sync updates/deletes cache records for allow-listed files; it never stores secrets or raw external instructions.
