# Flearning UI implementation

The supplied DESIGN.md defines the content-first desktop layout, 256px sidebar,
52px header, 4px spacing scale, restrained surfaces and visible keyboard focus.
Flearning identity takes precedence for logo, fonts and action colors:

- Orange `#FF9333` with ink `#202833` for primary actions (6.71:1 contrast).
- White content canvas and Neutral 50 `#FCF8F3` sidebar. This follows the source
  label; the brand document records a conflicting raster sample `#FBF6F0`.
- Rethink Sans headings, Inter body, with system fallbacks. Google Fonts uses
  `display=swap`; offline environments use the fallbacks.
- Original, unmodified SVG assets. The horizontal logo remains 160×35; collapsed
  navigation uses the original circular mark. No wordmark is reconstructed.
- Pastel colors distinguish workflow stages while their text labels remain.

`src/flearning-theme.css` is the final semantic brand layer after the existing
legacy component styles and settings styles. Production and browser fixtures
load it in the same order. Scope is the current light UI; the legacy dark
fixture is not a new user-facing dark-mode feature.

The app keeps its existing workflows, API contracts and persistence. Desktop
uses a flat sidebar/canvas split; mobile retains the functional bottom-free
navigation and package picker. Focus and reduced-motion styles cover both.

Source documents are design references, not authorization to change branding
master files, publish marketing claims, or change application data.
