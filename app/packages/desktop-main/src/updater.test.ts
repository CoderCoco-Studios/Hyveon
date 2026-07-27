import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ElectronStoreService } from './services/ElectronStoreService.js';

/**
 * Fake `autoUpdater` singleton mirroring the `electron-updater` surface
 * `updater.ts` touches: `logger` (assignable), `on` (event registration),
 * and `checkForUpdates` (the one call that must stay gated behind the flag).
 */
const { mockAutoUpdater, checkForUpdatesMock, onMock } = vi.hoisted(() => {
  const checkForUpdatesMock = vi.fn().mockResolvedValue(null);
  const onMock = vi.fn();
  const mockAutoUpdater = {
    logger: null as unknown,
    on: onMock,
    checkForUpdates: checkForUpdatesMock,
    autoDownload: true,
    autoInstallOnAppQuit: true,
  };
  return { mockAutoUpdater, checkForUpdatesMock, onMock };
});

vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { initUpdater } from './updater.js';

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
