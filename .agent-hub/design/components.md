---
id: agent-hub-design-components
layer: design
status: canonical
source_paths: [src/components, src/components/workspace, src/components/config]
---
# Component inventory

| Area | Main components | Contract |
| --- | --- | --- |
| Shell | `App`, `Sidebar`, `StepNav`, `VerticalWorkflowRail` | Navigation and mode framing; preserve same-origin config behaviour. |
| EB workspace | `EbWorkingSpace`, `EbSidebar` | Board, Discovery archive, library, task detail, notifications. |
| Workflow panels | `Step2CoreIdea`, `Step3Outline`, `Step4Draft`, `ProcessTrace`, `StepUsage` | Gate-specific editing, evidence and progress. |
| Settings | `ConfigModal`, `TabStepSetup`, `TabModels`, `TabKnowledgeBase`, `WorkflowRulesPanel` | Persisted configuration; do not expose secret values. |
| Import/activity | `InputEngine` within workspace, `SourceImportPanel`, `ActivityLauncher`, `BatchActivity` | Input/upload/import progress and recoverable error feedback. |

## Settings knowledge sources

- EB Knowledge & Rules exposes three source tabs: EB Library, EB Workflow Rules, and Website Inventory.
- Legacy Action Plans archive, preview, and download controls are removed. Existing `action` / `action-plan` files and compatibility types remain preserved when Settings loads and saves; no data deletion or migration is performed.

## Shared interaction states

- **Loading:** disabled action with spinner and an explanatory status message.
- **Error:** red/amber bordered message containing a recoverable next action where possible.
- **Empty:** concise explanatory card; retain the primary action.
- **Success:** semantic confirmation, never replace detail that a user needs to audit.
- **Discovery:** tag every item `Verified trend`, `Emerging signal`, or `Source lead`; group archive by tag.

Use Lucide icons already imported by the target component. Existing icon-only actions require accessible labels and tooltips/titles.

## EB notification center

- Header connection status is a single dot: amber while synchronising, red on error, emerald when live. Its button retains refresh/retry, an accessible state description, tooltip, focus style and touch target. Explicit dot colors avoid the shell's amber utility override.
- The center has fixed “Thông báo” and “Trạng thái hệ thống” tabs. Each opening defaults to notifications; tab choice survives data updates within that opening. Arrow Left/Right and Home/End select and focus tabs, with one tab in the Tab sequence.
- Each row has an independent keyboard-accessible **Xoá** button; **Xoá tất cả** hides the currently visible list. A shared module-owned id/content-fingerprint dismissal set filters rows, badge and active/queued banners, including during unconfirmed reads. It survives polling, refresh and remount within the page session; reload resets it. Sorted detail content prevents API reordering from resurfacing a group; changed content and new events remain eligible. Deletion moves focus to an adjacent row or the notifications tab; clear all returns focus to that tab and shows the empty state. Source history, workspace data, workflow decisions, APIs and storage remain unchanged.
- Connection is excluded from notification rows and badge. The badge counts active workflow, Discovery and session notification entries; updates replace groups rather than appending duplicates. Existing notification details and history remain available.
- The system tab shows synchronising/error/live connection state, current error, Brief/Article/Adapt task counts, per-output Review pending/completed/rejected counts, and saved Discovery count across all board filters. Live describes workspace connectivity only, not provider health. Loading/error hides all counts as unconfirmed (failed refresh clears tasks but may retain older Discovery). Successful refresh restores confirmed counts. A persistent Refresh/Retry button uses the existing workspace refresh and is disabled during synchronisation.
- `notifyWorkspace(message, kind)` keeps its signature and appends distinct events to module-owned in-memory session history, including consecutive events in the same millisecond. History survives workspace remount and StrictMode subscription cycles, and resets on page reload; no server or browser-storage persistence is added.
- EB V2 operation failures (Discovery, approval, review, regeneration, move/delete) append one error event per failed attempt with operation/task/channel context when available and existing recovery details, including confirmed partial-review counts. They do not change connection error state. Successful refresh and polling preserve session error history and do not append duplicate events; workspace read failures remain system-only. Existing local validation and editor errors stay in context.
- General notifications share the center’s list with a sequential top-right banner queue. Initial confirmed groups, new session events (success/error/warning), and changed group content appear once; unchanged polling/refresh and reordered detail records do not replay banners. Pending groups use current content and disappear when confirmed data removes them; transient read failures do not reset presentation history. Each banner collapses toward the bell after six seconds of unpaused display, or via its labelled collapse button. Hover and keyboard focus pause the timer; reduced-motion disables movement. Collapse preserves history, badge and workflow decisions. The shell host remains empty to avoid duplicate banners. Field validation and audit content remain in context. The center supports keyboard focus containment, Escape and focus return.
- Connection updates retain focus inside the open center when a focused control is disabled or removed, so Tab and Escape continue to work after retry succeeds.
- The transient banner uses a neutral container with its own polite live status, separate from the task-detail aside and its approval/image-evidence statuses.

- Notification rows are native buttons with article titles, gate/channel/status previews and an in-panel detail view. Discovery details retain evidence labels, titles and saved summaries; session details retain the full message and recorded kind without inferred timestamps or objects. Retry is an independent action.
- Details resolve from current workspace data on every refresh. Removed groups show an unavailable message; surviving groups update their contents. Back returns focus to the original row, or the panel if it disappeared. Opening details never executes workflow decisions or changes the badge count.
