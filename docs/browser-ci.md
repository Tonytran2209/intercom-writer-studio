# Browser CI connected to AI Agent Lab

Browser tests run in GitHub Actions using `mcr.microsoft.com/playwright:v1.64.1-noble`, matching the locked Playwright package. The image includes Chromium and its system libraries; no per-run APT install or browser download is needed. Update the image and package lock together when upgrading Playwright.

`writer-check` validates code. `browser-tests (desktop)` and `browser-tests (mobile)` execute the existing isolated fixture tests. `browser-check` validates and publishes both exact-commit `lab-test-v1` evidence packets for Lab. Missing, skipped, duplicate, failed or stale records do not pass. Reports/traces/screenshots are retained for 14 days. Artifacts use the run ID and device, preserving successful siblings when GitHub reruns only failed jobs.

`Retry browser infrastructure` uses only GitHub job metadata, never PR source/artifacts. It may rerun failed jobs once after a recognized environment failure before tests, with writer-check already successful. It does not retry assertions, unknown failures, fork runs or later attempts. Only this recovery job has Actions write permission; normal checks retain read-only permissions. Repository policy must allow the workflow token to rerun Actions; a denied dispatch leaves the original failure visible.

Lab still requires successful `writer-check` and `browser-check` on the current commit. Its observer shows each device and failed step, blocks source repair for infrastructure/unknown failures, and retains the existing scoped repair path for actual test/code failures. No app API, production data, deployment setting or Codex Mac connection is changed by this CI configuration.

Run `npm ci`, `npm ci --prefix backend`, and `npm run check` for code validation. Browser tests use the repo's Playwright configuration and mock APIs; no production provider credentials are required. Locally install Chromium with `npx --no-install playwright install chromium` if needed, then run `npx --no-install playwright test --config playwright.agent-lab.config.mjs`.

The `writer-ci-v1` contract in `.agent-hub/ci-contract.json` declares the workflow, pinned Playwright version and shared fixture paths for Lab's read-only preflight. `tests/agent-lab/bootstrap` owns CSS/provider mounting and the app's default light theme; `browser-fixture` owns offline routing, with each scenario supplying explicit API mocks. Contexts start with empty storage and service workers blocked. Use `setTheme` for alternate-theme checks; do not add theme classes ad hoc or clear storage on reload. Fresh contexts isolate tests while preserving intentional persistence within one test.

Scenario routes must call `route.fallback()` for unmatched requests so the shared offline guard still runs. Use `route.fulfill()` for synthetic responses; no test relies on production API access.
