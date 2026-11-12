---
id: agent-hub-design
layer: design
status: canonical
source_paths: [src/main.tsx, src/index.css, src/codex-theme.css, src/settings-interactions.css]
---

# Twenty UI standard for Intercom Writer Studio

Use the Twenty develop-app skill's front-component UI guide for every UI change, from layout to small visual fixes. Intercom runs as a standalone React app and loads the published Twenty UI library and theme styles through its existing Vite entry point.

- [Twenty develop-app UI guide](https://github.com/twentyhq/twenty/blob/agent-skills/skills/develop-app/references/design/front-component-ui.md)
- [Standalone React integration](https://docs.twenty.com/ui/getting-started)
- [Design tokens](https://docs.twenty.com/ui/tokens) and [typography primitives](https://docs.twenty.com/ui/primitives/typography/text)

## Components and tokens

Use the public Twenty UI family entry points. Prefer MainButton for primary actions, LightButton for secondary actions, Tabs for related panels, Dropdown for menus and pickers, Field for form composition, and individual Twenty icons for visible controls. Use Twenty typography, feedback and data-display primitives where they fit. Use native HTML for application-specific structure such as the package board and Markdown content.

Use semantic theme tokens for surfaces, text, borders, accent, spacing and radius. Component variants handle emphasis and state. Use semantic status colors with a text label. Retain the app's CSS only for layout, existing product interactions and scoped integration with the host theme.

## Typography

Use Twenty's Inter family and the scale below on all product screens. The role utilities in src/index.css make the same scale available to both native and Twenty components. Set size by role and use spacing or weight to establish hierarchy.

| Role | Utility | Twenty token | Where to use |
| --- | --- | --- | --- |
| Page title | ui-type-page | font.size.lg | Workspace, Settings or guide title |
| Section title | ui-type-title | font.size.md | Gate heading, inspector title, settings section |
| Body and control label | ui-type-body | font.size.sm | Navigation, actions, forms, task titles and content |
| Metadata and help | ui-type-meta | font.size.xs | Dates, column headings, status, hints and descriptions |
| Compact count | ui-type-count | font.size.xxs | Numeric counters in small badges only |

Use regular, medium and semibold weights from Twenty's scale. Use the compact count only where a counter sits inside another control. For long output, use body text and a relaxed line height. Readable line lengths, wrapping and visible focus take priority over density. Font-size literals and Tailwind text-size utilities are reserved for content outside the product UI, such as authored document previews.

## Layout and interaction

- Workspace lists align titles, status, source, dates and actions by column. At narrow widths, stack fields and keep all actions reachable.
- Gate grids retain independent scrolling when four columns fit. The same board becomes a shared scroll region at narrower widths. Keep the Input Engine visible and preserve the workspace's scroll boundaries.
- The task inspector sits beside the board when space permits and uses a full-width panel on narrow screens. Group output, evidence and history in Twenty Tabs. Keep the current Gate's primary approval action in the inspector header.
- Use visible form labels or clearly associated accessible names, keyboard focus, and accessible icon-only actions. Preserve focus when dialogs and panels close.
- Give loading, empty, error, disabled and saving states the same layout and type scale as the ready state. Provide an actionable recovery message when there is one.

## Review before shipping

Check the actual app in light and dark themes, wide and narrow viewports, and with long Vietnamese labels and file names. Verify the table, inspector, menus and inputs with a keyboard. Inspect computed typography on equivalent controls across surfaces and check that headers, actions and metadata do not overlap. Verify the primary workflow as well as loading and empty states.
