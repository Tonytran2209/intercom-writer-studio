---
id: agent-hub-ownership
layer: policy
status: canonical
source_paths: [src, backend, supabase/migrations]
---
# Ownership and cross-layer rules

| Owner | Allowed paths | Must coordinate when |
| --- | --- | --- |
| Design agent | `src/components/**`, `src/*.css`, `.agent-hub/design/**` | Props, API state, persisted settings, or accessibility contracts change. |
| Backend agent | `backend/**`, `.agent-hub/backend/**` | Route payload, persistence, auth, or frontend client changes. |
| Database agent | `supabase/migrations/**`, `.agent-hub/database/**` | A table/column/policy/index is consumed by backend or UI. |
| Agent Library agent | `.agent-hub/**`, `backend/agentLibrary.ts`, migration 010 | Any canonical document or retrieval contract changes. |

Cross-layer changes require: additive migration first, backend contract second, typed client/UI last, and `npm run check`. Never edit a migration that may have run remotely. Never overwrite unrelated dirty files; `.DS_Store` is not a project artifact and must not be committed.
