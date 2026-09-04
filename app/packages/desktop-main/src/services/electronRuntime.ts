import { createRequire } from 'node:module';

/**
 * Returns the Electron `userData` directory when running inside an Electron
 * process, or `null` otherwise (plain Node/test contexts, or a lazy
 * `require('electron')` that fails). The `electron` module is required
 * lazily at call-time — guarded on `process.versions['electron']` being
 * truthy — so importing this module in a plain Node/test context never
 * triggers an unresolved-module error.
 *
 * Shared by `PulumiService`, `PulumiWorkspaceService`, and
 * `PulumiEngineService`, each of which keeps its own `resolveUserDataPath()`
 * as a one-line delegate to this function rather than depending on one
 * another directly — see each class's own doc comment on that method for
 * why it can't inject a shared service instead.
 */
export function resolveUserDataPath(): string | null {
  if (!process.versions['electron']) return null;
  try {
    const _require = createRequire(import.meta.url);
    const electron = _require('electron') as { app: { getPath(name: string): string } };
    return electron.app.getPath('userData');
  } catch {
    return null;
  }
}

/**
 * Whether the app is running as a packaged Electron build. Guarded on
 * `process.versions['electron']` being truthy, then a lazy
 * `require('electron')` read of `app.isPackaged`; returns `false` for any
 * plain Node/test context or a require that fails.
 *
 * Shared by `PulumiService`, `CloudHealthService`, and `GuidedIamService`,
 * each of which keeps its own `readIsPackaged()` as a one-line delegate to
 * this function — see each class's own doc comment on that method for why
 * it can't inject a shared service instead.
 */
export function readIsPackaged(): boolean {
  if (!process.versions['electron']) return false;
  try {
    const _require = createRequire(import.meta.url);
    const electron = _require('electron') as { app: { isPackaged: boolean } };
    return electron.app.isPackaged;
  } catch {
    return false;
  }
}

/**
 * `process.resourcesPath` when running inside a packaged Electron app, or
 * `undefined` otherwise.
 *
 * Shared by `PulumiService` and `ConfigService`, each of which keeps its own
 * `readResourcesPath()` as a one-line delegate to this function — see each
 * class's own doc comment on that method for why it can't inject a shared
 * service instead.
 */
export function readResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}
