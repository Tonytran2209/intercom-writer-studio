---
id: agent-hub-design
layer: design
status: canonical
source_paths: [src/index.css, src/codex-theme.css, src/settings-interactions.css]
---
# Design system

## Visual language

The product uses Inter (400/500/600/700), antialiased, with Tailwind utility classes. The default surface is light, compact, card-based, and uses subtle slate borders/shadows. `src/index.css` defines `--font-sans` and `--font-mono`; it is the token entrypoint. `src/codex-theme.css` is the dark-mode override layer.

- Surfaces: white or slate-50; borders generally slate-200; compact rounded-lg/xl/2xl controls.
- Status colors are semantic: blue (brief/input), amber (article), purple (adapt/research), emerald (review/success), red (error/destructive). Do not use a status color as decoration.
- EB workflow columns use `kanban-blue`, `kanban-amber`, `kanban-purple`, and `kanban-emerald` in `src/index.css`.
- Headings use tight negative tracking in light UI; supporting text is small slate text.

## Density, responsive, accessibility

- Desktop workspace has a collapsible side rail; mobile uses a compact navigation surface (`EbSidebar.tsx`).
- Preserve touch targets, visible focus styles supplied by component classes, icon `title`/`aria-label`, and semantic status text. Never convey a decision only by color.
- Keep long archive/workspace lists scrollable within their own flex containers. Avoid page-level overflow regressions.
- Loading, empty, error, and success states are product states, not optional polish; follow `EbWorkingSpace.tsx` patterns.

## Main Input Engine

`InputEngine` in `src/components/EbWorkingSpace.tsx` uses a white pill with a thin gray border and subtle shadow. Document upload is the accessible plus control on the left, topic input is in the middle, and image evidence and the neutral Analyze pill sit on the right. On narrow screens the actions wrap below the input. Long input remains vertically resizable and scrollable; attachment names wrap.

The existing gradient colors, blur, opacity and hover/focus-within transitions are preserved, with the glow radius following the pill. Topic input has no individual border, outline or focus shadow on hover, click, typing or keyboard focus in either theme. A subtle slate background in light mode and neutral background in dark mode indicate textarea focus, including `:focus-visible`. Document upload retains its gray keyboard-focus outline on its visible label only when the nested file input matches `:focus-visible`, suppressing the hidden input's own outline in both themes. Discovery preparation, validation and image scan/review panels expand outside the pill; their locks, callbacks and evidence workflow are unchanged. Styles are scoped to `.eb-input-engine` in `src/index.css`.

## Change rule

Before changing visual treatment, inspect the active component plus global light/dark overrides. Do not infer a design token from a screenshot alone.
