import type {
  ManualUpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateInstallResult,
} from '@hyveon/shared';
import { logger } from './logger.js';
import type { ElectronStoreService } from './services/ElectronStoreService.js';
import { errMessage } from '@hyveon/shared';
import { PRIMARY_FEED, resolveFallbackFeedUrl } from './updater-fallback.js';

// @spec APP-UPDATE-BOOT-006
/**
 * Loads `electron-updater`'s `autoUpdater` and applies the settings shared by every check.
 *
 * @remarks
 * `autoUpdater` is exported via a getter-defined CJS property that `cjs-module-lexer` can't detect, so a named
 * dynamic import resolves to `undefined`; going through `.default` reaches the getter at runtime. `autoDownload`
 * and `autoInstallOnAppQuit` default to `true` and are pinned off: a detected update must never download or
 * install itself. Only the explicit user actions {@link downloadUpdateNow} / {@link installDownloadedUpdate}
 * ever do.
 */
async function loadAutoUpdater() {
  const { autoUpdater } = (await import('electron-updater')).default;
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  return autoUpdater;
}

type AutoUpdater = Awaited<ReturnType<typeof loadAutoUpdater>>;

// @spec APP-UPDATE-FALL-001, APP-UPDATE-FALL-003, APP-UPDATE-FALL-004, APP-UPDATE-FALL-005
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
    } finally {
      // setFeedURL mutates the process-wide singleton; put the primary feed back so later checks start from it.
      autoUpdater.setFeedURL({ ...PRIMARY_FEED });
    }
  }
}

// @spec APP-UPDATE-BOOT-001, APP-UPDATE-BOOT-002, APP-UPDATE-BOOT-003, APP-UPDATE-BOOT-004, APP-UPDATE-BOOT-005
// @spec APP-UPDATE-FLAG-002, APP-UPDATE-DL-001
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

// @spec APP-UPDATE-CHECK-001, APP-UPDATE-CHECK-002, APP-UPDATE-CHECK-003, APP-UPDATE-CHECK-004
// @spec APP-UPDATE-CHECK-005, APP-UPDATE-CHECK-006, APP-UPDATE-CHECK-007, APP-UPDATE-FALL-006
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

/** Message `electron-updater` rejects `downloadUpdate()` with when no `checkForUpdates()` has populated its cache. */
const NO_PRIOR_CHECK_MESSAGE = 'Please check update first';

// @spec APP-UPDATE-DL-001, APP-UPDATE-DL-002, APP-UPDATE-DL-003, APP-UPDATE-DL-004, APP-UPDATE-DL-006
// @spec APP-UPDATE-DL-007
/**
 * Downloads the update found by the last check — an explicit, user-initiated action; nothing else in the app ever
 * downloads. `autoDownload`/`autoInstallOnAppQuit` stay `false`, so the downloaded installer is applied only when
 * {@link installDownloadedUpdate} is called.
 *
 * @remarks
 * `electron-updater` caches the check's `updateInfo` on the singleton. If `downloadUpdate()` rejects because that
 * cache is empty (e.g. the app restarted between the check and the click), the check is re-run once via
 * {@link checkWithFallback} and the download retried. The `error` listener is persistent for the duration so the
 * updater's own `error` event (dispatched before the rejection) is never unhandled; the outcome is decided by the
 * promise. All listeners are removed afterward.
 *
 * @param onProgress - Called for every `download-progress` event.
 * @returns `{ ok: true, version }` once the update is fully downloaded, otherwise `{ ok: false, message }`.
 */
export async function downloadUpdateNow(onProgress: (progress: UpdateDownloadProgress) => void): Promise<UpdateDownloadResult> {
  if (!process.versions['electron']) {
    return { ok: false, message: 'Update downloads are only available in the packaged app.' };
  }

  try {
    const autoUpdater = await loadAutoUpdater();
    let version = 'unknown';
    const onProgressEvent = (info: UpdateDownloadProgress) => {
      onProgress({
        percent: info.percent,
        transferred: info.transferred,
        total: info.total,
        bytesPerSecond: info.bytesPerSecond,
      });
    };
    const onDownloaded = (info: { version: string }) => {
      version = info.version;
    };
    const onError = () => {};
    autoUpdater.on('download-progress', onProgressEvent);
    autoUpdater.on('update-downloaded', onDownloaded);
    autoUpdater.on('error', onError);

    try {
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        if (errMessage(err) !== NO_PRIOR_CHECK_MESSAGE) throw err;
        logger.info('[updater] download requested before a check in this process — re-checking first');
        await checkWithFallback(autoUpdater);
        await autoUpdater.downloadUpdate();
      }
    } finally {
      autoUpdater.removeListener('download-progress', onProgressEvent);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      autoUpdater.removeListener('error', onError);
    }
    logger.info('[updater] user-initiated download complete', { version });
    return { ok: true, version };
  } catch (err) {
    const message = errMessage(err);
    logger.error('[updater] user-initiated download failed', { error: message });
    return { ok: false, message };
  }
}

// @spec APP-UPDATE-DL-001, APP-UPDATE-DL-007, APP-UPDATE-DL-008
/**
 * Quits the app and runs the installer for the update {@link downloadUpdateNow} fetched — an explicit,
 * user-initiated action. Passes `isForceRunAfter = true` so the app relaunches after installing.
 *
 * @returns `{ ok: true }` when the quit-and-install was kicked off, otherwise `{ ok: false, message }`.
 */
export async function installDownloadedUpdate(): Promise<UpdateInstallResult> {
  if (!process.versions['electron']) {
    return { ok: false, message: 'Update installs are only available in the packaged app.' };
  }
  try {
    const autoUpdater = await loadAutoUpdater();
    logger.info('[updater] user-initiated install: quitting to install the downloaded update');
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    const message = errMessage(err);
    logger.error('[updater] user-initiated install failed', { error: message });
    return { ok: false, message };
  }
}
