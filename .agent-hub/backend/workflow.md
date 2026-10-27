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

## Threads at Review Gate 3

Initial adaptation, channel regeneration, and feedback refinement share a mandatory Threads delivery contract in both task and system prompts. Return exactly Variant A — Company account and Variant B — Employee-shareable. Each variant contains a Vietnamese post (`Tiếng Việt`) followed by its English translation (`English`); each language version is independently publish-ready and limited to 500 characters, excluding labels. Preserve supported facts in both languages.

This contract overrides conflicting configured language, variant-count, or length rules, including older single-language Channel Rules. Other Channel Rules retain their existing precedence. Facebook and LinkedIn contracts are unchanged. The provider is instructed to check the contract; this is not a deterministic language/length validator. Content remains in `content.text`, with existing channel isolation and per-variant human approval. Existing saved outputs are not rewritten or backfilled; the contract applies to newly generated revisions.

## Auth, retries, concurrency

The current app is a shared internal deployment: `/api` middleware assigns a shared admin identity in `backend/index.ts`; this is not end-user authentication. New Agent Library sync must still check `req.auth.role === 'admin'`; retrieval requires `req.auth` and must be revisited when real auth is introduced. GET retry policy lives in `src/lib/db.ts`; provider retry/failure handling remains backend-owned.

Do not create background jobs/queues unless an endpoint cannot complete within normal Railway request limits. There is no configured external job queue.

## Temporary evidence images

Evidence scanning holds one image in multer memory only; no binary is stored in database, storage, snapshots or logs. Optional GenerateRequest.images maps to Anthropic base64 image blocks, OpenAI Chat image_url / Responses input_image blocks, and Google inlineData. Text-only request shapes remain unchanged. Only OpenAI, Anthropic and Google adapters accept image requests; individual model capability is provider-validated and failures are returned without fallback. SDK clients use the runtime fetch implementation, enabling isolated network mocks.

The extraction prompt treats image content as untrusted data, asks only for visible facts/references and prohibits invented URLs or company connections. Existing canonical provider language rules still apply. Only user-confirmed text is subsequently persisted through existing workflow contracts; no schema or retention change is needed.
