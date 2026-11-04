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


## Read-only operational monitoring

`GET /internal/monitoring?days=1..30` is separate from user `/api` authentication and requires `Authorization: Bearer <LAB_MONITORING_TOKEN>` (at least 32 characters). An unset token disables the endpoint (503); invalid credentials return 401. Responses use `Cache-Control: no-store` and `protocol: app-monitoring-v1`. Configure the token as a service secret, never a frontend variable.

The endpoint returns aggregate inventory, database round-trip/pool state, current-process CPU/RSS/heap/uptime/commit, API route counts/4xx/5xx/aborts/latency histograms, and central generate-dispatcher AI calls/errors/latencies/tokens/pricing coverage. It excludes article contents, user identifiers, request parameters, prompts and provider credentials. It performs no provider health probe or paid AI call. PostgreSQL aggregate queries use a read-only transaction with a four-second statement timeout; unavailable tables are null. Inventory includes articles deduplicated by ID (per-article KV, legacy KV, relational precedence), relational plans and statuses of workflow/queue/QC tables when present.

New dispatcher/HTTP counters begin at installation. Hourly per-instance snapshots use existing KV keys `lab-monitor:v1:<UTC hour>:<instance UUID>`; a best-effort five-second flush never fails business operations. A crash can lose the last five seconds. Reports select up to 10,000 buckets from a maximum 30-day window and mark truncated reads incomplete. Stored snapshots are not business records; retention cleanup is not yet automated. Current-process resources do not represent all replicas or container limits. Histogram percentiles are bucket upper bounds, not exact sample quantiles. SDK internal retries are not separately counted.

AI cost uses configured model prices at call completion, is an estimate in USD, and remains null without a valid price. Token coverage and priced-call counts are explicit. Historical `writer_ai_usage` is a separate workflow ledger: cache hits are separated from provider calls and its totals must not be added to dispatcher totals. No schema migration, auth/provider change or existing workflow response change is required.
