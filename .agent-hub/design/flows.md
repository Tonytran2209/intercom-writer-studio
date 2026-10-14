---
id: agent-hub-design-flows
layer: design
status: canonical
source_paths: [src/components/EbWorkingSpace.tsx, backend/ebV2.ts]
---
# User flows

## EB V2 authoring flow

1. User submits input or an upload; backend creates a package and input snapshot.
2. Gate 1 produces/reviews a brief.
3. Gate 2 produces article specification, outline, and draft.
4. Adaptation creates LinkedIn, Facebook, and Threads outputs.
5. Review is per channel: done, reject, recheck, or regeneration are scoped to that channel.

## Discovery flow

1. User starts scan, optionally adding links.
2. UI receives NDJSON progress events from `POST /api/eb-v2/discovery`.
3. Saved items render live and are grouped by evidence tag.
4. User opens details to audit sources or sends a selected item to Gate 1.

Never represent an emerging/source lead as a verified trend. Earlier archive suggestions remain unless the user deletes/clears them.
