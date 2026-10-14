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
