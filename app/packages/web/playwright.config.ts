import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Absolute path to the repo root (three directories above this config). */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Absolute path to the electron-vite main output entry point. */
export const electronMain = join(repoRoot, 'out', 'main', 'index.js');

// Strip `ELECTRON_RENDERER_URL` from the inherited environment. electron-vite's
// dev server sets it, and when present the main process calls `win.loadURL()`
// instead of `win.loadFile()`. Removing it ensures packaged-renderer smoke
// tests always exercise the `loadFile()` path even when run from a shell that
// still has dev-server variables set.
//
// `HYVEON_PULUMI_SPIKE*` is stripped for a sharper reason: the whole inherited
// environment is spread into every `_electron.launch()` below, so a
// `HYVEON_PULUMI_SPIKE=1` exported in the shell running the suite would reach
// every launched app and make each spec provision a 344 MB Pulumi engine and run
// a real `up`. The main process refuses the spike under `HYVEON_TEST_MODE`
// anyway (see `electron-entry.ts`); this is the other half of that belt.
const {
  ELECTRON_RENDERER_URL: _rendererUrl,
  HYVEON_PULUMI_SPIKE: _pulumiSpike,
  HYVEON_PULUMI_SPIKE_OUT: _pulumiSpikeOut,
  HYVEON_PULUMI_SPIKE_QUIT: _pulumiSpikeQuit,
  ...inheritedEnv
} = process.env as Record<string, string>;

/**
 * Environment variables injected into every Electron launch during e2e tests.
 *
 * Inherits the current environment (minus `ELECTRON_RENDERER_URL` and the
 * `HYVEON_PULUMI_SPIKE*` trio, all stripped above) plus `HYVEON_TEST_MODE=1`,
 * which switches the main process into its test seam.
 */
export const electronEnv: Record<string, string> = {
  ...inheritedEnv,
  HYVEON_TEST_MODE: '1',
};

/**
 * Two e2e projects run side by side during the Electron pivot (Epic F #140):
 *
 *  - `chromium` runs the existing stub-based specs against `vite preview`. They
 *    stub `/api/*` over HTTP via `page.route()` and navigate to `baseURL`, so
 *    they cannot run under Electron until the IPC mock surface (F.7/#198) lands.
 *    Each existing spec migrates to Electron under its own issue (F.2–F.6).
 *  - `electron` runs the new `_electron.launch()` smoke spec and the IPC mock
 *    seam spec against the packaged main bundle. Each spec manages its own
 *    ElectronApplication.
 *
 * `electron-smoke.spec.ts`, `electron-clean-quit.spec.ts` (the permanent
 * clean-quit guard from the Pulumi migration's task 1.5 spike),
 * `electron-ipc-roundtrip.spec.ts`, `ipc-mock.spec.ts`,
 * `dashboard.spec.ts`, `costs.spec.ts` (migrated in #193), `logs.spec.ts`
 * (migrated in #191), `discord.spec.ts` (migrated in #194),
 * `iac.spec.ts` (new route, issue #110; renamed from `terraform.spec.ts` by
 * task 9.8), and
 * `streaming-handle-roundtrip.spec.ts` (regression guard for the streaming-IPC
 * contextBridge clone bug — see its own doc comment) are matched only by the
 * `electron` project and ignored by `chromium`; every other spec is the
 * reverse.
 */
const ELECTRON_SPECS = [
  '**/electron-smoke.spec.ts',
  '**/electron-clean-quit.spec.ts',
  '**/electron-ipc-roundtrip.spec.ts',
  '**/ipc-mock.spec.ts',
  '**/streaming-handle-roundtrip.spec.ts',
  '**/dashboard.spec.ts',
  '**/costs.spec.ts',
  '**/logs.spec.ts',
  '**/discord.spec.ts',
  // Renamed from `terraform.spec.ts` (task 9.8's IPC-channel-name fixup, see
  // `iac.spec.ts`'s own header comment) — this glob was left stale, which
  // silently routed the file to the `chromium` project instead. Harmless in
  // practice (`launchElectron()` calls `_electron.launch()` directly,
  // independent of which project's `use` config the test nominally runs
  // under, and `npm run app:test:e2e` always runs both projects together),
  // but wrong: this IS the Electron-tier `/iac` spec (task 11.3).
  '**/iac.spec.ts',
];

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    // Video requires ffmpeg which hangs on install in CI; traces are sufficient
    video: process.env.CI ? 'off' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ELECTRON_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:4173',
        // In CI use the pre-installed system Chrome to avoid downloading Chromium
        ...(process.env.CI ? { channel: 'chrome' } : {}),
      },
    },
    {
      name: 'electron',
      testMatch: ELECTRON_SPECS,
    },
  ],
  // Skip the Vite build+preview when only the electron project is being tested.
  // This guard fires only when PLAYWRIGHT_PROJECT=electron is set in the
  // environment before invoking Playwright — i.e.:
  //   PLAYWRIGHT_PROJECT=electron npx playwright test --project=electron
  // The --project CLI flag alone does NOT set this env var, so omitting it
  // will still start the Vite build+preview (harmless but wasteful).
  // The electron project launches the app via `_electron.launch()` and never
  // opens a browser tab against localhost:4173, so starting the dev server
  // would be pure overhead in that scenario.
  webServer:
    process.env.PLAYWRIGHT_PROJECT === 'electron'
      ? undefined
      : {
          command: 'npm run build && npm run preview',
          url: 'http://localhost:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
});
