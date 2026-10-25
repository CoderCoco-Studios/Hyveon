import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ElectronStoreService } from './services/ElectronStoreService.js';

/**
 * Fake `autoUpdater` singleton mirroring the `electron-updater` surface
 * `updater.ts` touches: `logger` (assignable), `on` (event registration),
 * and `checkForUpdates` (the one call that must stay gated behind the flag).
 */
const { mockAutoUpdater, checkForUpdatesMock, downloadUpdateMock, quitAndInstallMock, onMock, onceMock, removeListenerMock, setFeedURLMock, resolveFallbackMock } = vi.hoisted(() => {
  const checkForUpdatesMock = vi.fn().mockResolvedValue(null);
  const downloadUpdateMock = vi.fn().mockResolvedValue([]);
  const quitAndInstallMock = vi.fn();
  const onMock = vi.fn();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const onceMock = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(event, handler);
  });
  const removeListenerMock = vi.fn((event: string) => {
    listeners.delete(event);
  });
  const setFeedURLMock = vi.fn();
  const resolveFallbackMock = vi.fn().mockResolvedValue(null);
  const mockAutoUpdater = {
    setFeedURL: setFeedURLMock,
    logger: null as unknown,
    on: onMock,
    once: onceMock,
    removeListener: removeListenerMock,
    checkForUpdates: checkForUpdatesMock,
    downloadUpdate: downloadUpdateMock,
    quitAndInstall: quitAndInstallMock,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    /** Test helper — invokes the handler registered via `once(event, ...)`, mirroring a real event emit. */
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
  return { mockAutoUpdater, checkForUpdatesMock, downloadUpdateMock, quitAndInstallMock, onMock, onceMock, removeListenerMock, setFeedURLMock, resolveFallbackMock };
});

/**
 * `electron-updater` exports `autoUpdater` via a getter-defined CJS property,
 * which surfaces at runtime only through the module's `default` (the whole
 * `module.exports` object) — see `updater.ts`'s comment on the same import.
 * Mocking only a top-level named `autoUpdater` here would pass even if
 * `updater.ts` regressed back to destructuring the named export directly.
 */
vi.mock('electron-updater', () => ({ default: { autoUpdater: mockAutoUpdater } }));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./updater-fallback.js', () => ({
  resolveFallbackFeedUrl: resolveFallbackMock,
  PRIMARY_FEED: { provider: 'github', owner: 'CoderCoco-Studios', repo: 'Hyveon' },
}));

import { logger } from './logger.js';
import { initUpdater, checkForUpdatesNow, downloadUpdateNow, installDownloadedUpdate } from './updater.js';

/** Builds a minimal `ElectronStoreService`-shaped stub for `initUpdater`'s single `get` call. */
function makeStore(enableAutoUpdate: boolean | undefined): ElectronStoreService {
  return { get: vi.fn().mockReturnValue(enableAutoUpdate) } as unknown as ElectronStoreService;
}

describe('initUpdater', () => {
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      Object.defineProperty(process.versions, 'electron', { value, configurable: true });
    }
  };

  beforeEach(() => {
    setElectron('36.0.0');
    setFeedURLMock.mockClear();
    resolveFallbackMock.mockReset().mockResolvedValue(null);
    checkForUpdatesMock.mockReset().mockResolvedValue(null);
  });
  afterEach(() => setElectron(realElectronVersion));

  it('should be a no-op outside a real Electron main process, regardless of the flag', async () => {
    setElectron(undefined);

    await initUpdater(makeStore(true));

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(onMock).not.toHaveBeenCalled();
  });

  it('should never call checkForUpdates when enableAutoUpdate is false', async () => {
    await initUpdater(makeStore(false));

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('should never call checkForUpdates when enableAutoUpdate is unset (absent defaults to disabled)', async () => {
    await initUpdater(makeStore(undefined));

    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('should call checkForUpdates exactly once when enableAutoUpdate is true inside Electron', async () => {
    await initUpdater(makeStore(true));

    expect(checkForUpdatesMock).toHaveBeenCalledOnce();
  });

  it('should wire update-event listeners onto autoUpdater when enableAutoUpdate is true', async () => {
    await initUpdater(makeStore(true));

    const registeredEvents = onMock.mock.calls.map((call) => call[0]);
    expect(registeredEvents).toEqual(
      expect.arrayContaining(['error', 'update-available', 'update-not-available', 'update-downloaded']),
    );
  });

  it('should disable autoDownload and autoInstallOnAppQuit so a detected update never installs itself', async () => {
    await initUpdater(makeStore(true));

    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('should not reject when checkForUpdates rejects (electron-updater rethrows after emitting "error")', async () => {
    checkForUpdatesMock.mockRejectedValueOnce(new Error('network unreachable'));

    await expect(initUpdater(makeStore(true))).resolves.toBeUndefined();
  });

  it('should retry against the fallback feed when the primary check rejects, and not throw', async () => {
    checkForUpdatesMock.mockRejectedValueOnce(new Error('404 latest.yml')).mockResolvedValueOnce(null);
    resolveFallbackMock.mockResolvedValue('https://example.test/download/v0.6.0');

    await expect(initUpdater(makeStore(true))).resolves.toBeUndefined();

    expect(setFeedURLMock).toHaveBeenCalledWith({ provider: 'generic', url: 'https://example.test/download/v0.6.0' });
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fallback'), expect.any(Object));
  });

  it('should restore the primary feed after the fallback retry succeeds', async () => {
    checkForUpdatesMock.mockRejectedValueOnce(new Error('404 latest.yml')).mockResolvedValueOnce(null);
    resolveFallbackMock.mockResolvedValue('https://example.test/download/v0.6.0');

    await initUpdater(makeStore(true));

    expect(setFeedURLMock).toHaveBeenCalledTimes(2);
    expect(setFeedURLMock).toHaveBeenLastCalledWith({ provider: 'github', owner: 'CoderCoco-Studios', repo: 'Hyveon' });
  });

  it('should restore the primary feed after the fallback retry fails', async () => {
    checkForUpdatesMock.mockRejectedValueOnce(new Error('404 latest.yml')).mockRejectedValueOnce(new Error('boom'));
    resolveFallbackMock.mockResolvedValue('https://example.test/download/v0.6.0');

    await initUpdater(makeStore(true));

    expect(setFeedURLMock).toHaveBeenCalledTimes(2);
    expect(setFeedURLMock).toHaveBeenLastCalledWith({ provider: 'github', owner: 'CoderCoco-Studios', repo: 'Hyveon' });
  });

  it('should not set a feed or retry when no fallback release exists', async () => {
    checkForUpdatesMock.mockRejectedValueOnce(new Error('404 latest.yml'));

    await initUpdater(makeStore(true));

    expect(setFeedURLMock).not.toHaveBeenCalled();
    expect(checkForUpdatesMock).toHaveBeenCalledOnce();
  });
});

describe('checkForUpdatesNow', () => {
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      Object.defineProperty(process.versions, 'electron', { value, configurable: true });
    }
  };

  beforeEach(() => {
    setElectron('36.0.0');
    onceMock.mockClear();
    removeListenerMock.mockClear();
    checkForUpdatesMock.mockReset().mockResolvedValue(null);
    setFeedURLMock.mockClear();
    resolveFallbackMock.mockReset().mockResolvedValue(null);
  });
  afterEach(() => setElectron(realElectronVersion));

  it('should report unavailable outside a real Electron main process without calling checkForUpdates', async () => {
    setElectron(undefined);

    const result = await checkForUpdatesNow();

    expect(result).toEqual({ ok: false, message: 'Update checks are only available in the packaged app.' });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('should resolve updateAvailable: true when the update-available event fires', async () => {
    checkForUpdatesMock.mockImplementationOnce(() => {
      mockAutoUpdater.emit('update-available', { version: '1.2.3' });
      return Promise.resolve(null);
    });

    const result = await checkForUpdatesNow();

    expect(result).toEqual({ ok: true, updateAvailable: true, version: '1.2.3' });
  });

  it('should resolve updateAvailable: false when the update-not-available event fires', async () => {
    checkForUpdatesMock.mockImplementationOnce(() => {
      mockAutoUpdater.emit('update-not-available');
      return Promise.resolve(null);
    });

    const result = await checkForUpdatesNow();

    expect(result).toEqual({ ok: true, updateAvailable: false });
  });

  it('should resolve ok: false when the error event fires', async () => {
    checkForUpdatesMock.mockImplementationOnce(() => {
      mockAutoUpdater.emit('error', new Error('feed unreachable'));
      return Promise.reject(new Error('feed unreachable'));
    });

    const result = await checkForUpdatesNow();

    expect(result).toEqual({ ok: false, message: 'feed unreachable' });
  });

  it('should disable autoDownload and autoInstallOnAppQuit, same restriction as initUpdater', async () => {
    checkForUpdatesMock.mockImplementationOnce(() => {
      mockAutoUpdater.emit('update-not-available');
      return Promise.resolve(null);
    });

    await checkForUpdatesNow();

    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('should resolve ok: false when checkForUpdates resolves null without firing an event (updater disabled)', async () => {
    checkForUpdatesMock.mockResolvedValueOnce(null);

    const result = await checkForUpdatesNow();

    expect(result).toEqual({ ok: false, message: 'Update checks are disabled for this build.' });
  });

  it('should remove all three listeners after resolving', async () => {
    checkForUpdatesMock.mockImplementationOnce(() => {
      mockAutoUpdater.emit('update-not-available');
      return Promise.resolve(null);
    });

    await checkForUpdatesNow();

    expect(removeListenerMock).toHaveBeenCalledWith('update-available', expect.any(Function));
    expect(removeListenerMock).toHaveBeenCalledWith('update-not-available', expect.any(Function));
    expect(removeListenerMock).toHaveBeenCalledWith('error', expect.any(Function));
  });

  describe('fallback feed', () => {
    const FALLBACK_URL = 'https://example.test/download/v0.6.0';

    it('should not resolve on the primary error event and should report the fallback result (available)', async () => {
      resolveFallbackMock.mockResolvedValue(FALLBACK_URL);
      checkForUpdatesMock
        .mockImplementationOnce(() => {
          mockAutoUpdater.emit('error', new Error('404 latest.yml'));
          return Promise.reject(new Error('404 latest.yml'));
        })
        .mockImplementationOnce(() => {
          mockAutoUpdater.emit('update-available', { version: '0.6.0' });
          return Promise.resolve(null);
        });

      const result = await checkForUpdatesNow();

      expect(setFeedURLMock).toHaveBeenCalledWith({ provider: 'generic', url: FALLBACK_URL });
      expect(result).toEqual({ ok: true, updateAvailable: true, version: '0.6.0' });
    });

    it('should report up to date when the fallback feed has no newer version', async () => {
      resolveFallbackMock.mockResolvedValue(FALLBACK_URL);
      checkForUpdatesMock
        .mockRejectedValueOnce(new Error('404 latest.yml'))
        .mockImplementationOnce(() => {
          mockAutoUpdater.emit('update-not-available');
          return Promise.resolve(null);
        });

      const result = await checkForUpdatesNow();

      expect(result).toEqual({ ok: true, updateAvailable: false });
      expect(checkForUpdatesMock).toHaveBeenCalledTimes(2);
    });

    it('should surface the original error when no fallback release exists', async () => {
      checkForUpdatesMock.mockRejectedValueOnce(new Error('404 latest.yml'));

      const result = await checkForUpdatesNow();

      expect(result).toEqual({ ok: false, message: '404 latest.yml' });
      expect(setFeedURLMock).not.toHaveBeenCalled();
    });

    it('should surface the original error, not the retry error, when the fallback check also fails', async () => {
      resolveFallbackMock.mockResolvedValue(FALLBACK_URL);
      checkForUpdatesMock
        .mockRejectedValueOnce(new Error('404 latest.yml'))
        .mockRejectedValueOnce(new Error('fallback boom'));

      const result = await checkForUpdatesNow();

      expect(result).toEqual({ ok: false, message: '404 latest.yml' });
    });
  });
});

describe('downloadUpdateNow / installDownloadedUpdate', () => {
  const realElectronVersion = process.versions.electron;
  const setElectron = (value: string | undefined): void => {
    if (value === undefined) {
      delete (process.versions as { electron?: string }).electron;
    } else {
      Object.defineProperty(process.versions, 'electron', { value, configurable: true });
    }
  };

  beforeEach(() => {
    setElectron('36.0.0');
    onMock.mockClear();
    removeListenerMock.mockClear();
    checkForUpdatesMock.mockReset().mockResolvedValue(null);
    downloadUpdateMock.mockReset().mockResolvedValue([]);
    quitAndInstallMock.mockReset();
    resolveFallbackMock.mockReset().mockResolvedValue(null);
  });
  afterEach(() => setElectron(realElectronVersion));

  /** Returns the handler registered via `autoUpdater.on(event, ...)`. */
  function handlerFor(event: string): (...args: unknown[]) => void {
    const call = onMock.mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`no ${event} listener registered`);
    return call[1] as (...args: unknown[]) => void;
  }

  it('should report unavailable outside Electron without touching electron-updater', async () => {
    setElectron(undefined);

    expect(await downloadUpdateNow(vi.fn())).toEqual({
      ok: false,
      message: 'Update downloads are only available in the packaged app.',
    });
    expect(downloadUpdateMock).not.toHaveBeenCalled();
  });

  it('should forward download-progress events and resolve with the downloaded version', async () => {
    const onProgress = vi.fn();
    downloadUpdateMock.mockImplementationOnce(async () => {
      handlerFor('download-progress')({ percent: 50, transferred: 5, total: 10, bytesPerSecond: 3, delta: 1 });
      handlerFor('update-downloaded')({ version: '1.2.3' });
      return [];
    });

    const result = await downloadUpdateNow(onProgress);

    expect(result).toEqual({ ok: true, version: '1.2.3' });
    expect(onProgress).toHaveBeenCalledWith({ percent: 50, transferred: 5, total: 10, bytesPerSecond: 3 });
  });

  it('should keep autoDownload and autoInstallOnAppQuit off', async () => {
    await downloadUpdateNow(vi.fn());

    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('should remove every listener it added after settling', async () => {
    await downloadUpdateNow(vi.fn());

    for (const event of ['download-progress', 'update-downloaded', 'error']) {
      expect(removeListenerMock).toHaveBeenCalledWith(event, expect.any(Function));
    }
  });

  it('should re-run the check once and retry when no check has populated electron-updater yet', async () => {
    downloadUpdateMock
      .mockRejectedValueOnce(new Error('Please check update first'))
      .mockResolvedValueOnce([]);

    const result = await downloadUpdateNow(vi.fn());

    expect(checkForUpdatesMock).toHaveBeenCalledOnce();
    expect(downloadUpdateMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('should resolve ok: false with the message when the download rejects, and remove listeners', async () => {
    downloadUpdateMock.mockRejectedValueOnce(new Error('code signature invalid'));

    const result = await downloadUpdateNow(vi.fn());

    expect(result).toEqual({ ok: false, message: 'code signature invalid' });
    expect(checkForUpdatesMock).not.toHaveBeenCalled();
    expect(removeListenerMock).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('should quit and install with relaunch on installDownloadedUpdate', async () => {
    expect(await installDownloadedUpdate()).toEqual({ ok: true });
    expect(quitAndInstallMock).toHaveBeenCalledWith(false, true);
  });

  it('should report ok: false when quitAndInstall throws', async () => {
    quitAndInstallMock.mockImplementationOnce(() => {
      throw new Error('no update downloaded');
    });

    expect(await installDownloadedUpdate()).toEqual({ ok: false, message: 'no update downloaded' });
  });

  it('should report unavailable outside Electron on installDownloadedUpdate', async () => {
    setElectron(undefined);

    expect(await installDownloadedUpdate()).toEqual({
      ok: false,
      message: 'Update installs are only available in the packaged app.',
    });
    expect(quitAndInstallMock).not.toHaveBeenCalled();
  });
});
