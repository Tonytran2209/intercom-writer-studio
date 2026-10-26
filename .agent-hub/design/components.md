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

## Shared interaction states

- **Loading:** disabled action with spinner and an explanatory status message.
- **Error:** red/amber bordered message containing a recoverable next action where possible.
- **Empty:** concise explanatory card; retain the primary action.
- **Success:** semantic confirmation, never replace detail that a user needs to audit.
- **Discovery:** tag every item `Verified trend`, `Emerging signal`, or `Source lead`; group archive by tag.

Use Lucide icons already imported by the target component. Existing icon-only actions require accessible labels and tooltips/titles.

## EB notification center

- Header connection status is a single dot: amber while synchronising, red on error, emerald when live. Its button retains refresh/retry, an accessible state description, tooltip, focus style and touch target. Explicit dot colors avoid the shell's amber utility override.
- The bell contains current connection status (with retry on failure), running article/adaptation work, saved Discovery counts, and per-output pending/completed/rejected Review counts across all channels, independent of board filters. Badge count equals panel entries; polling updates these entries rather than appending duplicates.
- `notifyWorkspace(message, kind)` keeps its signature and appends distinct events to module-owned in-memory session history, including consecutive events in the same millisecond. History survives workspace remount and StrictMode subscription cycles, and resets on page reload; no server or browser-storage persistence is added.
- General notifications are presented in the center, without a duplicate toast or connection banner and without a four-second expiry. Field validation and audit content remain in context. The center supports keyboard focus containment, Escape and focus return.
- Connection updates retain focus inside the open center when the focused Retry control is disabled or removed, so Tab and Escape continue to work after retry succeeds.
