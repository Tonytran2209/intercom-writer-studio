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

### Image evidence scan

POST /api/eb-v2/evidence/scan accepts multipart file (one PNG/JPEG/WebP, at most 15 MiB) and model (JSON string with provider and id). Server checks binary signatures, not filename/MIME alone. Returns { evidence: string } with nonempty text up to 16000 characters. Errors return { code, error }: 400 INVALID_UPLOAD/MODEL_REQUIRED, 415 INVALID_IMAGE, 422 UNSUPPORTED_MODEL/UNREADABLE_IMAGE/RESULT_TOO_LONG/SCAN_FAILED. Provider/model errors are sanitized and do not expose provider responses.

This request performs no database/storage writes, snapshot creation, gate transitions or model fallback. The client uses same-origin multipart with cancellation. Confirmed text flows through existing create/regenerate validation.
