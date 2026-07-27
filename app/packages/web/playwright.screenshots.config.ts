import { defineConfig } from '@playwright/test';

/**
 * Standalone Playwright config for the docs-screenshot harness
 * (`e2e/screenshots/capture.spec.ts`). Deliberately separate from
 * `playwright.config.ts`:
 *
 * - `testDir: './e2e/screenshots'` — scoped to just this one spec file, so
 *   running the main `app:test:e2e` suite (`testDir: './e2e/specs'`) never
 *   picks this up, and running this config never picks up the functional
 *   e2e specs. Verified with `npx playwright test --list` against both
 *   configs (see `docs:screenshots` in the root `package.json`).
 * - No `projects` / `webServer` — the spec manages its own
 *   `_electron.launch()` calls directly (same pattern the main config's
 *   `electron` project uses), and there's no Vite dev server or preview
 *   build involved at all, so there's nothing to start ahead of time.
 * - `workers: 1` / `fullyParallel: false` — screenshot capture launches a
 *   real Electron app per test; running more than one at a time on a CI
 *   runner (or a laptop) risks flaky renders and resource contention, and
 *   output file paths are fixed (`docs/static/img/app/*.png`), so
 *   concurrent writers could race on the same file.
 * - Generous timeouts — an Electron cold start plus several IPC
 *   round-trips and, for the wizard steps, a handful of UI interactions per
 *   test comfortably exceeds Playwright's 30s default.
 */
export default defineConfig({
  testDir: './e2e/screenshots',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
});
