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

## Change rule

Before changing visual treatment, inspect the active component plus global light/dark overrides. Do not infer a design token from a screenshot alone.
