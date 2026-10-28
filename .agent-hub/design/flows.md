---
id: agent-hub-design-flows
layer: design
status: canonical
source_paths: [src/App.tsx, src/components/EbWorkingSpace.tsx, backend/ebV2.ts]
---
# User flows

## Soft onboarding

After the shell settings loading screen, a native modal dialog introduces three steps: input/documents and checked evidence; Brief → Website article → Adapt/Review; Discovery, Library and Settings. The workspace remains mounted. Opening, stepping and closing the guide never trigger New activity, AI, workflow decisions or server writes.

Without browser/origin marker `writer:onboarding:v1=seen`, it opens automatically. Skip, close button, Escape and Get started save the marker; merely opening or stepping does not. Guide reopens at step one without changing input. Storage failures fall back to mount-local dismissal; a reload may show it again. This is not account-level tracking. The scrollable native modal contains keyboard focus and returns focus to Guide on dismissal, including automatic first opening.

## EB V2 authoring flow

1. User submits input or an upload; backend creates a package and input snapshot.
2. Gate 1 produces/reviews a brief.
3. Gate 2 produces article specification, outline, and draft.
4. Adaptation creates LinkedIn, Facebook, and Threads outputs.
5. Review is per channel: done, reject, recheck, or regeneration are scoped to that channel.

Brief and draft article can be approved from either their board card or task detail popup. Brief approval uses the Gate 2 model; article approval uses the Adapt model (including its configured override), independently of the popup's editing model. Existing enabled-model fallback is preserved; without a model, no request is sent and the popup explains what to configure.

Approval is unavailable for running tasks and already approved articles. Card and popup share a request lock while approval is pending; the popup shows progress and recoverable errors. Successful approval synchronizes the board and detail. Once brief approval persists, the UI advances to Article even if the follow-up workspace read fails; refresh to recover the latest state. Adapt has no approval action. Review decisions remain stored per output, with A, B, or both required for Threads; there is no package-wide approval record. Gate 3 cards in board/list show Done only for a nonempty set of entirely done outputs, Rejected if any output is rejected, and Chờ review otherwise (including recheck), plus counts for each state. Labels and counts use all current review outputs regardless of channel filters. The card menu offers Done tất cả and Reject tất cả as sequential shortcuts using the existing output review API, skipping outputs already at the target decision. Done requires an explicit Threads variant choice when Threads still needs approval; existing done selections are preserved. Card and detail review share a request lock. Each successful server response updates the workspace; a partial failure retains confirmed results, attempts a workspace refresh, explains that review remains, and allows retry of unfinished decisions. No bulk transaction, schema change, or migration is introduced.

Gate 1 detail includes “Mối liên hệ với F” and “Dẫn chứng / nguồn xác nhận tại F”, loaded from the latest input snapshot for that task. “Lưu và chạy lại brief” uses the Gate 1 model, validates before persistence or workflow changes, saves a new snapshot preserving original input/metadata, and supplies the validated fields to generation. Validation, save and AI errors retain the editor values; changing tasks resets and loads that task's saved values. Card and popup share the regeneration/approval lock. Brief regeneration waits for generation before returning; a lost response can be reconciled by refreshing the workspace, and a retry validates and creates a new attempt.

Each saved regeneration snapshot carries a unique marker. Approval requires the latest completed brief to carry the same marker, so old output cannot approve after snapshot persistence, during generation, or after a failed run. Failed persistence leaves earlier data intact; failures after snapshot persistence keep approval blocked until a successful new run. No migration or backfill is required.

## Threads refinement approval

Refine with AI retains the mandatory Vietnamese/English pair inside each Threads Variant A/B, with 500 characters per language. Completed Threads chat revisions offer Approve A and Approve B alongside Use this version. Approval activates that revision first, then saves the selected variant through the existing per-output review API using the revision result ID. The chat stays open and follows the active revision; Use this version still activates without approving. Article refinement is unchanged.

Chat activation and approval share the card/detail review lock. Each attempt reads persisted feedback and workspace state, rejects stale or unavailable revisions, and preserves each confirmed workspace response. If activation succeeds but review fails, the accepted revision remains active; retry skips activation and only finishes review. An already done revision is preserved. Lost responses require reconciliation before retry; no atomic transaction or automatic data rollback is implied. API, storage, schema and prompt contracts are unchanged.

## Discovery flow

1. User starts scan, optionally adding links.
2. UI receives NDJSON progress events from `POST /api/eb-v2/discovery`.
3. Saved items render live and are grouped by evidence tag.
4. User opens details to audit sources or sends a selected item to Gate 1.

Never represent an emerging/source lead as a verified trend. Earlier archive suggestions remain unless the user deletes/clears them.

## Image evidence at Gate 1

InputEngine (including Discovery preparation) and Gate 1 Source & evidence accept one PNG/JPEG/WebP image up to 15 MiB. In InputEngine, use the accessible image icon beside document upload or drop one image directly into the input area. The scan/review panel appears after selection or a validation error; file drops never navigate away, and text drags retain native behavior. Picker and drop share validation, reject multiple files, and are locked while synchronising; replacing an image cancels obsolete scans. Gate 1 task detail retains its native image picker. Select an image, explicitly scan with the selected Gate 1 model, then review/edit and use the extracted text. Normal input appends confirmed evidence to the unified topic; Discovery preparation and task detail append it to fEvidence. Scanning never runs or approves a brief. Existing validation, snapshot metadata, shared operation locks and regeneration markers still apply.

Errors preserve destination text and permit retry. Changing image, model, task or leaving the editor cancels/ignores obsolete responses. Results stay in a separate editable draft until applied, so a delayed scan cannot overwrite source edits. Extraction is not independent verification; the user must check source references.

## Hướng dẫn thao tác cho người dùng

Xem [Hướng dẫn sử dụng Intercom Writer Studio](user-guide.md) cho các bước New activity, ảnh dẫn chứng, chuẩn bị Gate 1 từ Discovery, review/refine Threads A/B và Notification center. Cập nhật hướng dẫn khi thay đổi hành vi trong flow này; tài liệu không tự cấp quyền thực thi cho agent.
