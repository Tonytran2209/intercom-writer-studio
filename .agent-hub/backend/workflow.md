---
id: agent-hub-backend-workflow
layer: backend
status: canonical
source_paths: [backend/index.ts, backend/ebV2.ts, backend/providers.ts, backend/supabase.ts]
---
# Backend and workflow

## Service ownership

- `backend/index.ts`: Express process, legacy Writer Studio API, static frontend serving, CORS, health, uploads and orchestration queues.
- `backend/ebV2.ts`: isolated EB V2 packages, gates, channel adaptation/review, Discovery, feedback and learning signals.
- `backend/providers.ts`: server-only AI provider calls; no provider key is a client concern.
- `backend/supabase.ts`: service-role persistence helpers and `writer-documents` private Storage bucket.

## Execution and guards

AI workflow gates are explicit: brief, article (spec/outline/draft), adapt, review. Gate runs record snapshots and usage. Article mutation and AI budget queues in `backend/index.ts` serialize relevant legacy operations. EB V2 validates package/channel state before mutation; preserve these guards when extending endpoints.

Discovery uses source collection, freshness/evidence gates, save-before-display behaviour, NDJSON progress events, and duplicate detection. A stream failure must emit an error event and end the response.

## Auth, retries, concurrency

The current app is a shared internal deployment: `/api` middleware assigns a shared admin identity in `backend/index.ts`; this is not end-user authentication. New Agent Library sync must still check `req.auth.role === 'admin'`; retrieval requires `req.auth` and must be revisited when real auth is introduced. GET retry policy lives in `src/lib/db.ts`; provider retry/failure handling remains backend-owned.

Do not create background jobs/queues unless an endpoint cannot complete within normal Railway request limits. There is no configured external job queue.
