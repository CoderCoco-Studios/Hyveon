import { createRequire } from 'node:module';

/**
 * Returns the running app's version via Electron's `app.getVersion()`,
 * lazily requiring `electron` at call-time (mirrors
 * `CloudHealthService.readIsPackaged`'s pattern). Returns `'unknown'` outside
 * Electron (e.g. under Vitest or the plain-Node integration harness) or if
 * the lookup throws, rather than failing the caller over one display field.
 *
 * @returns the semver string from `app.getVersion()`, or `'unknown'`.
 */
export function readAppVersion(): string {
  if (!process.versions['electron']) return 'unknown';
  try {
    const _require = createRequire(import.meta.url);
    const electron = _require('electron') as { app: { getVersion(): string } };
    return electron.app.getVersion();
  } catch {
    return 'unknown';
  }
}
