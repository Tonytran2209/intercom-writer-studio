---
id: agent-hub-data-model
layer: database
status: canonical
source_paths: [supabase/migrations]
---
# Data model and migration ownership

Supabase PostgreSQL is server-persisted through `backend/supabase.ts`; browser code calls Railway, not Supabase directly. Migrations `001`–`009` are the schema history and must remain immutable.

Railway PostgreSQL is supported through `backend/postgres.ts` when `DATABASE_PROVIDER=postgres`. `DATABASE_URL` configures the pool; setting it alone does not change the active provider. The explicit `db:migrate` command applies the repository's existing migrations with a hash ledger. `db:import` inventories/copies the source database into an empty target; it never runs on application startup. Production cutover and import verification are operator steps.

## Existing domains

- Legacy: KV store, relational content plans/items/articles, three-stage sessions, article specs/quality, website inventory/crawl summaries.
- EB V2: settings, library documents, packages/input snapshots, discovery runs/sources/items, gate runs, articles, channel outputs/review actions, feedback threads, learning signals.

Most EB V2 records retain snapshots, status, timestamps, and foreign keys so content production is auditable. `eb_v2_*` schema changes must not alter legacy semantics.

## Agent Library index

Migration `010_agent_library_index.sql` adds cache/index tables only:

- `intercom_writer_agent_library_versions`: Git commit/content-index run metadata.
- `intercom_writer_agent_library_documents`: allow-listed canonical path, layer, content hash and size.
- `intercom_writer_agent_library_chunks`: heading-based retrieval text with ordering and per-chunk hash.

`.agent-hub` in Git is canonical. These tables are a derived cache, never a source to edit documents. Re-indexing the same content hash must be idempotent.

All tables use RLS and service-role policies because Railway is the persistence boundary. Retention is Git-led: sync updates/deletes cache records for allow-listed files; it never stores secrets or raw external instructions.
