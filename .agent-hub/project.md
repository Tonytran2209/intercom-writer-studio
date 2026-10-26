---
id: agent-hub-project
layer: project
status: canonical
source_paths: [package.json, backend/package.json, railway.toml, nixpacks.toml]
---
# Intercom Writer Studio

- **Repository:** `Tonytran2209/intercom-writer-studio`; default branch: `main`.
- **Project ID:** `intercom-writer-studio` (Railway service URL is same-origin in the frontend).
- **Runtime:** Node.js 22 on Railway; React 19 + Vite + Tailwind CSS v4 frontend; Express 4 TypeScript backend; Supabase PostgreSQL and Storage.
- **Commands:** `npm run dev`, `npm run typecheck`, `npm run build`, `npm run check` (frontend typecheck/build plus backend typecheck), `npm run format`. Backend: `npm --prefix backend run dev|start|typecheck`.

## Module map

| Area | Source of truth |
| --- | --- |
| App shell and routing | `src/App.tsx`, `src/components/` |
| EB V2 workspace | `src/components/EbWorkingSpace.tsx`, `backend/ebV2.ts` |
| Browser API client | `src/lib/db.ts` (same-origin for EB V2) |
| Legacy API/service | `backend/index.ts` |
| AI providers and workflow rules | `backend/providers.ts`, `backend/workflowRules.ts`, `src/lib/workflowGuards.ts` |
| Database | `supabase/migrations/` in numeric order |
| Persistent binaries | Supabase private `writer-documents` bucket via `backend/supabase.ts` |
| Railway database option | `backend/postgres.ts`; explicit `DATABASE_PROVIDER=postgres` switch, migration/import commands in `backend/package.json` |
| Deployment | `railway.toml`, `nixpacks.toml`, `start.sh` |

## Invariants

1. Preserve EB V2 isolation (`eb_v2_*`) from legacy Writer Studio data.
2. Do not put provider keys, Supabase secret keys, or document binaries in browser code, logs, or Agent Library records.
3. Database changes are additive migrations; do not rewrite applied migrations.
4. Same-origin is the only EB V2 backend origin. Do not restore configurable Railway URLs.
5. Discovery labels distinguish verified evidence, emerging signals, and source leads.

## Agent reading order

1. This file and `policies/ownership.md`.
2. The relevant layer document: `design/`, `backend/`, or `database/`.
3. Exact referenced source files and migrations before proposing a change.
4. `policies/automation.md` before executing mutations.
