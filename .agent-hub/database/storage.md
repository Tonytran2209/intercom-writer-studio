---
id: agent-hub-storage
layer: database
status: canonical
source_paths: [backend/supabase.ts, supabase/migrations]
---
# Storage and retention

`backend/supabase.ts` owns the private Supabase bucket `writer-documents`. It creates the bucket on first upload if permitted, limits documents to 15 MiB, and only the server reads/writes binaries. Database rows store paths and metadata; binaries are not embedded in Agent Library.

Agent Library content lives in Git under `.agent-hub`. The database index stores heading chunks as text only, keyed by content hash. Its allow-list excludes `.env`, locks, source code, uploaded files, provider configuration, secrets, refresh tokens, keys, and external raw instructions.

Deletion/retention: existing document deletion is handled by the owning feature. Agent Library sync removes stale cache rows only for paths in its fixed allow-list; it never deletes Git documents or product data.
