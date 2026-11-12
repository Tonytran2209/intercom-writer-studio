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

Use Twenty's Inter family and weights. Choose component size through Twenty's API first. For app-specific markup, use the compact roles below. The rem sizes follow the browser's text-size preference. Use weight and spacing for hierarchy before increasing type size.

| Role | Utility | Size at default zoom | Where to use |
| --- | --- | --- | --- |
| Page or record title | ui-type-page | 16 px | Workspace, Settings or record title |
| Section title | ui-type-title | 14 px | Gate heading and settings sections |
| UI body and controls | ui-type-body | 13 px | Navigation, actions, forms and task titles |
| Metadata and small labels | ui-type-meta | 12 px | Dates, status, help and mobile navigation |
| Reading content | ui-type-reading | 14 px | Briefs and evidence excerpts with relaxed line height |
| Compact count | ui-type-count | Twenty xxs | Counters inside controls |

Use regular, medium and semibold weights. Give rows and sections room through spacing while maintaining readable line lengths, wrapping and visible focus. Keep authored document previews on their own content scale.

## Layout and interaction

- Workspace lists align titles, status, source, dates and actions by column. Stack fields below a 760 px board width and keep all actions reachable.
- Gate Grid keeps all four columns on one horizontally scrollable row. Give each column a 19 rem minimum when the board can fit it, and let each Gate scroll its own tasks vertically. Keep the Input Engine outside the scrolling region.
- Use AppDropdown for action panels and multi-filter menus, and AppSelect for single-value pickers. Both use the workspace Filter styling with Twenty UI primitives and portalled popups that reposition at viewport edges.
- Open task details as a modal side panel with a dismissible backdrop and a width that fits narrow screens. Group output, evidence and history in Twenty Tabs. Keep the current Gate's primary approval action in the inspector header.
- Use visible form labels or clearly associated accessible names, keyboard focus, and accessible icon-only actions. Preserve focus when dialogs and panels close.
- Give loading, empty, error, disabled and saving states the same layout and type scale as the ready state. Provide an actionable recovery message when there is one.

## Review before shipping

Check the actual app in light and dark themes, wide and narrow viewports, and with long Vietnamese labels and file names. Verify the table, inspector, menus and inputs with a keyboard. Inspect computed typography on equivalent controls across surfaces and check that headers, actions and metadata do not overlap. Verify the primary workflow as well as loading and empty states.
