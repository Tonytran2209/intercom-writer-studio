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

### Gate 1 regeneration

`POST /api/eb-v2/packages/:id/regenerate` retains `{ stage, model }` and accepts optional `fConnection` / `fEvidence` for `stage: "brief"`. Omitted fields use saved validation values; explicitly supplied empty/placeholder fields fail. Existing preflight validates the complete checklist before writes (422 for validation errors). A new input snapshot preserves original text and raw metadata and stores the fresh `briefValidation` plus a unique `briefRegenerationAt` marker. The brief prompt includes the validated connection and evidence. Brief generation completes before the workspace response; persistence/provider errors return 500. In-process concurrent brief regeneration returns 409 and approval is blocked while that operation runs.

Approval additionally requires the latest completed brief run's `rule_snapshot.briefRegenerationAt` to match the latest snapshot marker when present. This persisted guard survives failures/restarts between snapshot save and run creation. Legacy snapshots without the marker retain the existing validation/completed-output guard. Retry starts a fresh validated attempt; there is no transaction, response-loss idempotency guarantee, migration, or automatic rollback. Article regeneration and Gate 2/3 model contracts remain unchanged.

## Legacy domains (`/api`)

Providers/generation, SEO research, KV store, content plans/batches/articles, app config, website inventory, files/source import/document upload/download and Google Docs formatting are registered in `backend/index.ts`. Read its exact route before modifying a contract.

## Agent Library additions

- `POST /api/agent-library/sync`: admin-only; reads a fixed allow-list from `.agent-hub`, indexes Git canonical documents idempotently.
- `GET /api/agent-library/retrieve?query=&layer=&maxChars=`: authenticated request required; returns only ranked, size-bounded chunks and document metadata.

Neither endpoint accepts filesystem paths, raw external documents, provider credentials, nor storage object contents.
