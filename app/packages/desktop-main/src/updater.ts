import type { ManualUpdateCheckResult } from '@hyveon/shared';
import { logger } from './logger.js';
import type { ElectronStoreService } from './services/ElectronStoreService.js';

/**
 * Initializes the `electron-updater` integration for the main process.
 *
 * Gated off by default: a no-op outside a real Electron main process
 * (`process.versions.electron` guard, per the same pattern `ElectronStoreService`
 * uses for `electron-store`) and a no-op whenever `enableAutoUpdate` is falsy in
 * the store. `electron-updater` is only imported once both conditions hold, so
 * a first launch with default settings produces zero outbound traffic to any
 * update feed and the plain-Node integration harness / vitest never evaluate
 * the module.
 */
export async function initUpdater(store: ElectronStoreService): Promise<void> {
  if (!process.versions['electron']) return;

  if (!store.get('enableAutoUpdate')) {
    logger.info('[updater] enableAutoUpdate is off — update checks disabled');
    return;
  }

  // `electron-updater` exports `autoUpdater` via `Object.defineProperty(exports, ...,
  // { get })` — cjs-module-lexer can't statically detect getter-defined exports, so
  // Node's synthetic named export for a dynamic `import('electron-updater')` is
  // missing and `const { autoUpdater } = await import(...)` resolves to `undefined`.
  // Going through `.default` (always the real CJS `module.exports` object) sidesteps
  // the static analysis and reaches the getter at runtime instead.
  const { autoUpdater } = (await import('electron-updater')).default;
  autoUpdater.logger = logger;

  // v1 scaffold: a detected update must not download or install itself, even
  // though the Settings page can now flip `enableAutoUpdate` on. Both default
  // to `true` in electron-updater, so they're pinned off explicitly here.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err: unknown) => {
    logger.error('[updater] update check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  autoUpdater.on('update-available', (info: { version: string }) => {
    logger.info('[updater] update available', { version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    logger.info('[updater] no update available');
  });
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    logger.info('[updater] update downloaded', { version: info.version });
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // electron-updater rethrows after emitting 'error' (see the listener
    // above, which already logged it) — swallow it here so a failed check
    // (offline, 404, malformed feed) surfaces as a log line, not an
    // unhandled rejection in the main process.
  }
}

/**
 * Runs a single update check on demand, independent of the `enableAutoUpdate`
 * flag — the flag gates only {@link initUpdater}'s automatic boot-time check.
 * Never downloads or installs (`autoDownload`/`autoInstallOnAppQuit` stay
 * `false`, same restriction as {@link initUpdater}).
 *
 * `electron-updater`'s `checkForUpdates()` promise resolves with feed
 * metadata regardless of whether a newer version exists — availability is
 * signaled via the `update-available`/`update-not-available` events, not the
 * return value — so this races one-shot listeners for those events (plus
 * `error`) against the call and resolves from whichever fires first,
 * removing all three afterward so they don't leak into a later call or
 * cross-fire with {@link initUpdater}'s persistent listeners.
 */
export async function checkForUpdatesNow(): Promise<ManualUpdateCheckResult> {
  if (!process.versions['electron']) {
    return { ok: false, message: 'Update checks are only available in the packaged app.' };
  }

  // See the comment on the equivalent line in `initUpdater` above — `.default`
  // sidesteps `cjs-module-lexer`'s inability to detect `electron-updater`'s
  // getter-defined `autoUpdater` export.
  const { autoUpdater } = (await import('electron-updater')).default;
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  return new Promise<ManualUpdateCheckResult>((resolve) => {
    const cleanup = () => {
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onAvailable = (info: { version: string }) => {
      cleanup();
      logger.info('[updater] manual check: update available', { version: info.version });
      resolve({ ok: true, updateAvailable: true, version: info.version });
    };
    const onNotAvailable = () => {
      cleanup();
      logger.info('[updater] manual check: no update available');
      resolve({ ok: true, updateAvailable: false });
    };
    const onError = (err: unknown) => {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[updater] manual check failed', { error: message });
      resolve({ ok: false, message });
    };

    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);

    autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (result === null) {
          // Updater disabled (e.g. dev-mode or unsupported platform) — no
          // event fires in this case, so the promise would otherwise never
          // settle.
          cleanup();
          logger.info('[updater] manual check: updater is disabled');
          resolve({ ok: false, message: 'Update checks are disabled for this build.' });
        }
      })
      .catch(() => {
        // electron-updater rethrows after emitting 'error' — the listener
        // above already resolved the promise, so this is just avoiding an
        // unhandled rejection.
      });
  });
}
