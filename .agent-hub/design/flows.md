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

Brief and draft article can be approved from either their board card or task detail popup. Brief approval uses the Gate 2 model; article approval uses the Adapt model (including its configured override), independently of the popup's editing model. Existing enabled-model fallback is preserved; without a model, no request is sent and the popup explains what to configure.

Approval is unavailable for running tasks and already approved articles. Card and popup share a request lock while approval is pending; the popup shows progress and recoverable errors. Successful approval synchronizes the board and detail. Once brief approval persists, the UI advances to Article even if the follow-up workspace read fails; refresh to recover the latest state. Adapt has no approval action. Review stays scoped to each channel, with A, B, or both required for Threads; there is no package-wide approval.

## Discovery flow

1. User starts scan, optionally adding links.
2. UI receives NDJSON progress events from `POST /api/eb-v2/discovery`.
3. Saved items render live and are grouped by evidence tag.
4. User opens details to audit sources or sends a selected item to Gate 1.

Never represent an emerging/source lead as a verified trend. Earlier archive suggestions remain unless the user deletes/clears them.
