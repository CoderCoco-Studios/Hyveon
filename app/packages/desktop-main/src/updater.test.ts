import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ElectronStoreService } from './services/ElectronStoreService.js';

/**
 * Fake `autoUpdater` singleton mirroring the `electron-updater` surface
 * `updater.ts` touches: `logger` (assignable), `on` (event registration),
 * and `checkForUpdates` (the one call that must stay gated behind the flag).
 */
const { mockAutoUpdater, checkForUpdatesMock, onMock, onceMock, removeListenerMock } = vi.hoisted(() => {
  const checkForUpdatesMock = vi.fn().mockResolvedValue(null);
  const onMock = vi.fn();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const onceMock = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(event, handler);
  });
  const removeListenerMock = vi.fn((event: string) => {
    listeners.delete(event);
  });
  const mockAutoUpdater = {
    logger: null as unknown,
    on: onMock,
    once: onceMock,
    removeListener: removeListenerMock,
    checkForUpdates: checkForUpdatesMock,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    /** Test helper — invokes the handler registered via `once(event, ...)`, mirroring a real event emit. */
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
  return { mockAutoUpdater, checkForUpdatesMock, onMock, onceMock, removeListenerMock };
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

import { initUpdater, checkForUpdatesNow } from './updater.js';

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

  beforeEach(() => setElectron('36.0.0'));
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
});
