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

  const { autoUpdater } = await import('electron-updater');
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
