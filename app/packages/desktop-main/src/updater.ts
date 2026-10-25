import type { ManualUpdateCheckResult } from '@hyveon/shared';
import { logger } from './logger.js';
import type { ElectronStoreService } from './services/ElectronStoreService.js';
import { errMessage } from '@hyveon/shared';
import { resolveFallbackFeedUrl } from './updater-fallback.js';

/**
 * Loads `electron-updater`'s `autoUpdater` and applies the settings shared by every check.
 *
 * @remarks
 * `autoUpdater` is exported via a getter-defined CJS property that `cjs-module-lexer` can't detect, so a named
 * dynamic import resolves to `undefined`; going through `.default` reaches the getter at runtime. `autoDownload`
 * and `autoInstallOnAppQuit` default to `true` and are pinned off: a detected update must never download or
 * install itself.
 */
async function loadAutoUpdater() {
  const { autoUpdater } = (await import('electron-updater')).default;
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  return autoUpdater;
}

type AutoUpdater = Awaited<ReturnType<typeof loadAutoUpdater>>;

/**
 * Runs `checkForUpdates()`, retrying once against the newest release that has a feed file if the primary check
 * fails (e.g. the latest release shipped without `latest.yml`).
 *
 * @param autoUpdater - The configured `autoUpdater` singleton.
 * @returns Whatever `checkForUpdates()` resolved with (`null` when the updater is disabled).
 * @throws The ORIGINAL primary error when no fallback exists or the fallback check also fails.
 */
async function checkWithFallback(autoUpdater: AutoUpdater): ReturnType<AutoUpdater['checkForUpdates']> {
  try {
    return await autoUpdater.checkForUpdates();
  } catch (primaryErr) {
    const url = await resolveFallbackFeedUrl(process.platform);
    if (!url) throw primaryErr;
    logger.warn('[updater] primary update check failed — retrying against fallback release', {
      error: errMessage(primaryErr),
      feedUrl: url,
    });
    autoUpdater.setFeedURL({ provider: 'generic', url });
    try {
      return await autoUpdater.checkForUpdates();
    } catch (fallbackErr) {
      logger.warn('[updater] fallback update check failed', { error: errMessage(fallbackErr) });
      throw primaryErr;
    }
  }
}

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

  const autoUpdater = await loadAutoUpdater();

  autoUpdater.on('error', (err: unknown) => {
    logger.error('[updater] update check failed', {
      error: errMessage(err),
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
    await checkWithFallback(autoUpdater);
  } catch {
    // The 'error' listener above already logged it; don't leave an unhandled rejection in the main process.
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
 * return value — so this resolves from whichever of those events fires
 * first. Failures are decided by the rejection of the check-with-fallback
 * call, not the first `error` event, so a failed primary check can still be
 * rescued by the fallback retry. All listeners are removed afterward so they
 * don't leak into a later call or cross-fire with {@link initUpdater}'s
 * persistent listeners.
 */
export async function checkForUpdatesNow(): Promise<ManualUpdateCheckResult> {
  if (!process.versions['electron']) {
    return { ok: false, message: 'Update checks are only available in the packaged app.' };
  }

  const autoUpdater = await loadAutoUpdater();

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
    // Persistent (`on`, not `once`) so the retry's own 'error' event is also swallowed — an unhandled one throws.
    // The outcome comes from the check-with-fallback result so a failed primary can't resolve before the retry.
    const onError = () => {};

    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.on('error', onError);

    checkWithFallback(autoUpdater)
      .then((result) => {
        if (result === null) {
          // Updater disabled (e.g. dev-mode or unsupported platform) — no event fires.
          cleanup();
          logger.info('[updater] manual check: updater is disabled');
          resolve({ ok: false, message: 'Update checks are disabled for this build.' });
        }
      })
      .catch((err: unknown) => {
        cleanup();
        const message = errMessage(err);
        logger.error('[updater] manual check failed', { error: message });
        resolve({ ok: false, message });
      });
  });
}
