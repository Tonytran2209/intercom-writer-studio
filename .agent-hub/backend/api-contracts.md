---
id: agent-hub-api-contracts
layer: backend
status: canonical
source_paths: [backend/index.ts, backend/ebV2.ts, src/lib/db.ts]
---
# API contracts

## EB V2 (`/api/eb-v2`)

- Read: health, settings, library documents, workspace, activity, discovery details, learning signals.
- Mutate: settings, library import, packages/upload, Discovery, feedback, gate approvals/regeneration/moves, channel review/regeneration, deletions.
- `POST /discovery` returns NDJSON (`progress`, `item`, `complete`, `error`) rather than a single JSON response; client parsing is in `runEbV2DiscoveryLive`.

## Legacy domains (`/api`)

Providers/generation, SEO research, KV store, content plans/batches/articles, app config, website inventory, files/source import/document upload/download and Google Docs formatting are registered in `backend/index.ts`. Read its exact route before modifying a contract.

## Agent Library additions

- `POST /api/agent-library/sync`: admin-only; reads a fixed allow-list from `.agent-hub`, indexes Git canonical documents idempotently.
- `GET /api/agent-library/retrieve?query=&layer=&maxChars=`: authenticated request required; returns only ranked, size-bounded chunks and document metadata.

Neither endpoint accepts filesystem paths, raw external documents, provider credentials, nor storage object contents.
