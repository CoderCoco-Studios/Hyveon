/**
 * Thin wrappers around `process.env` for environment variables consumed by
 * the Electron entry-point. Centralising access here lets tests stub individual
 * variables via `vi.spyOn(env, 'isTestMode')` instead of mutating
 * `process.env` directly, which leaks across tests.
 */

/**
 * Returns `true` when `HYVEON_TEST_MODE=1` is set — used by Playwright's
 * `_electron.launch()` harness to enable the forward-looking test seam.
 */
export function isTestMode(): boolean {
  return process.env.HYVEON_TEST_MODE === '1';
}

/**
 * Returns the Electron renderer dev-server URL injected by electron-vite,
 * or `undefined` when running in production (load from file instead).
 */
export function electronRendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL;
}

/**
 * SPIKE SCAFFOLDING — `migrate-iac-to-pulumi` tasks 1.3 / 1.5.
 *
 * Returns `true` when `HYVEON_PULUMI_SPIKE=1` is set, which makes the Electron
 * entry-point dynamically import and run `spike/pulumiSpike.ts`. The gate is
 * deliberately a cheap env read in this module rather than a static import of
 * the spike itself, so that neither the ~60 MB `@pulumi/pulumi` module graph
 * nor `@grpc/grpc-js` is loaded on a normal app start (or in unit tests).
 *
 * Delete this function, `spike/pulumiSpike.ts`, and the call site in
 * `electron-entry.ts` once `PulumiEngineService` (Phase 4) supersedes them —
 * see task 11.x cleanup.
 */
export function isPulumiSpikeEnabled(): boolean {
  return process.env.HYVEON_PULUMI_SPIKE === '1';
}
