import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const {
  mockLoadURL,
  mockLoadFile,
  mockQuit,
  mockOn,
  mockWhenReady,
  MockBrowserWindow,
  mockGetAllWindows,
  mockExistsSync,
  bootstrapMock,
  initUpdaterMock,
  fakeNestApp,
  whenReadyCallbacks,
  onCallbacks,
} = vi.hoisted(() => {
  /** Spy for `existsSync`, driving which icon candidate path "exists". */
  const mockExistsSync = vi.fn().mockReturnValue(false);
  const mockLoadURL = vi.fn().mockResolvedValue(undefined);
  const mockLoadFile = vi.fn().mockResolvedValue(undefined);
  const mockQuit = vi.fn();
  const mockGetAllWindows = vi.fn().mockReturnValue([]);

  /**
   * Collects every callback passed to `app.whenReady().then(cb)`.
   * Tests can fire them on demand by calling `whenReadyCallbacks[n]()`.
   */
  const whenReadyCallbacks: Array<() => void> = [];

  /**
   * Collects every callback registered via `app.on(event, cb)` keyed by
   * event name, so tests can trigger lifecycle events synchronously.
   */
  const onCallbacks: Record<string, () => void> = {};

  const mockOn = vi.fn((event: string, cb: () => void) => {
    onCallbacks[event] = cb;
  });

  /**
   * Returns a thenable that stores the `.then()` callback instead of
   * resolving it, giving tests full control over when the ready handler fires.
   */
  const mockWhenReady = vi.fn(() => ({
    then: (cb: () => void) => {
      whenReadyCallbacks.push(cb);
      return { then: vi.fn() };
    },
  }));

  /** Spy BrowserWindow constructor whose instances expose controlled load fns. */
  const MockBrowserWindow = vi.fn().mockImplementation(() => ({
    loadURL: mockLoadURL,
    loadFile: mockLoadFile,
  }));

  /** `BrowserWindow.getAllWindows()` static method used by the activate handler. */
  MockBrowserWindow.getAllWindows = mockGetAllWindows;

  /** Fake Nest microservice app returned by `bootstrap()`, standing in for the real DI container. */
  const fakeNestApp = { get: vi.fn() };
  /** Spy for `bootstrap` imported from `./main.js`. */
  const bootstrapMock = vi.fn().mockResolvedValue(fakeNestApp);
  /** Spy for `initUpdater` imported from `./updater.js`. */
  const initUpdaterMock = vi.fn().mockResolvedValue(undefined);

  return {
    mockLoadURL,
    mockLoadFile,
    mockQuit,
    mockOn,
    mockWhenReady,
    MockBrowserWindow,
    mockGetAllWindows,
    mockExistsSync,
    bootstrapMock,
    initUpdaterMock,
    fakeNestApp,
    whenReadyCallbacks,
    onCallbacks,
  };
});

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mockExistsSync,
}));

vi.mock('electron', () => ({
  app: {
    whenReady: mockWhenReady,
    on: mockOn,
    quit: mockQuit,
  },
  BrowserWindow: MockBrowserWindow,
}));

vi.mock('./main.js', () => ({
  bootstrap: bootstrapMock,
}));

vi.mock('./updater.js', () => ({
  initUpdater: initUpdaterMock,
}));

/** Flush the micro-task / timer queue so async chains fully settle. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('electron-entry', () => {
  beforeEach(() => {
    mockLoadURL.mockResolvedValue(undefined);
    mockLoadFile.mockResolvedValue(undefined);
    mockQuit.mockImplementation(() => undefined);
    bootstrapMock.mockResolvedValue(fakeNestApp);
    initUpdaterMock.mockResolvedValue(undefined);
    mockGetAllWindows.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);

    // Re-apply the BrowserWindow constructor implementation in case clearMocks
    // cleared it between tests (clearMocks resets call history and return value
    // queues; mockImplementation persists, but we re-set to be defensive).
    MockBrowserWindow.mockImplementation(() => ({
      loadURL: mockLoadURL,
      loadFile: mockLoadFile,
    }));

    // Re-apply mockOn and mockWhenReady implementations so callback capturing
    // works correctly after clearMocks resets the call history.
    mockOn.mockImplementation((event: string, cb: () => void) => {
      onCallbacks[event] = cb;
    });
    mockWhenReady.mockImplementation(() => ({
      then: (cb: () => void) => {
        whenReadyCallbacks.push(cb);
        return { then: vi.fn() };
      },
    }));

    // Reset the callback queues so each test starts clean.
    whenReadyCallbacks.length = 0;
    for (const key of Object.keys(onCallbacks)) {
      delete onCallbacks[key];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should call bootstrap() inside the app.whenReady() callback', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    await import('./electron-entry.js');
    await flushPromises();

    // Fire the whenReady callback that the module registered at import time.
    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(bootstrapMock).toHaveBeenCalledOnce();
  });

  it('should resolve ElectronStoreService from the bootstrapped Nest app and pass it to initUpdater', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    const { ElectronStoreService } = await import('./services/ElectronStoreService.js');
    const fakeStore = { get: vi.fn() };
    fakeNestApp.get.mockReturnValue(fakeStore);

    await import('./electron-entry.js');
    await flushPromises();
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(fakeNestApp.get).toHaveBeenCalledWith(ElectronStoreService);
    expect(initUpdaterMock).toHaveBeenCalledOnce();
    expect(initUpdaterMock).toHaveBeenCalledWith(fakeStore);
  });

  it('should call win.loadURL() with the dev server URL when ELECTRON_RENDERER_URL is set', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(mockLoadURL).toHaveBeenCalledOnce();
    expect(mockLoadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(mockLoadFile).not.toHaveBeenCalled();
  });

  it('should call win.loadFile() with the production renderer path when ELECTRON_RENDERER_URL is not set', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(mockLoadFile).toHaveBeenCalledOnce();
    expect(mockLoadURL).not.toHaveBeenCalled();

    // The path must end with the standard electron-vite renderer bundle location.
    const calledPath = mockLoadFile.mock.calls[0]?.[0] as string;
    expect(calledPath).toMatch(/renderer[/\\]index\.html$/);
  });

  it('should call app.quit() on window-all-closed for non-macOS platforms', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    await import('./electron-entry.js');
    await flushPromises();

    const handler = onCallbacks['window-all-closed'];
    expect(handler).toBeDefined();

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    handler!();

    expect(mockQuit).toHaveBeenCalledOnce();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('should NOT call app.quit() on window-all-closed on macOS', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    await import('./electron-entry.js');
    await flushPromises();

    const handler = onCallbacks['window-all-closed'];
    expect(handler).toBeDefined();

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    handler!();

    expect(mockQuit).not.toHaveBeenCalled();

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('should call app.quit() when the renderer fails to load', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    mockLoadFile.mockRejectedValueOnce(new Error('renderer bundle missing'));

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(mockQuit).toHaveBeenCalledOnce();
  });

  it('should call app.quit() and not open a window when bootstrap() rejects', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    bootstrapMock.mockRejectedValueOnce(new Error('IPC init failure'));

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(mockQuit).toHaveBeenCalledOnce();
    expect(MockBrowserWindow).not.toHaveBeenCalled();
  });

  it('should still create the window and log the test seam when HYVEON_TEST_MODE=1', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    vi.stubEnv('HYVEON_TEST_MODE', '1');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    // Test mode is a forward-looking seam, not a behaviour switch: the window
    // must still open so Playwright's _electron.launch() can drive it.
    expect(MockBrowserWindow).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(
      '[desktop-main] HYVEON_TEST_MODE active — test seam enabled',
    );

    logSpy.mockRestore();
  });

  it('should not log the test seam when HYVEON_TEST_MODE is unset', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    vi.stubEnv('HYVEON_TEST_MODE', '');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('./electron-entry.js');
    await flushPromises();

    expect(whenReadyCallbacks).toHaveLength(1);
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(MockBrowserWindow).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalledWith(
      '[desktop-main] HYVEON_TEST_MODE active — test seam enabled',
    );

    logSpy.mockRestore();
  });

  describe('window icon', () => {
    /**
     * Imports the entry point, fires the ready callback and returns the options
     * object the module handed to `new BrowserWindow(...)`.
     */
    async function createWindowOptions(): Promise<Record<string, unknown>> {
      vi.resetModules();
      vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

      await import('./electron-entry.js');
      await flushPromises();
      whenReadyCallbacks[0]!();
      await flushPromises();

      return MockBrowserWindow.mock.calls[0]?.[0] as Record<string, unknown>;
    }

    /** Sets `process.resourcesPath`, which only Electron defines at runtime. */
    function stubResourcesPath(value: string | undefined): void {
      Object.defineProperty(process, 'resourcesPath', { value, configurable: true });
    }

    afterEach(() => {
      stubResourcesPath(undefined);
    });

    it('should use the packaged icon under resourcesPath when it exists', async () => {
      stubResourcesPath(path.join('/opt', 'Hyveon', 'resources'));
      mockExistsSync.mockImplementation((candidate: string) =>
        candidate === path.join('/opt', 'Hyveon', 'resources', 'icon.png'),
      );

      const options = await createWindowOptions();

      expect(options.icon).toBe(path.join('/opt', 'Hyveon', 'resources', 'icon.png'));
    });

    it('should fall back to the repo build/icon.png when running unpackaged', async () => {
      stubResourcesPath(path.join('/opt', 'Hyveon', 'resources'));
      mockExistsSync.mockImplementation((candidate: string) => candidate.endsWith('icon.png') &&
        !candidate.includes('resources'));

      const options = await createWindowOptions();

      expect(options.icon).toMatch(/build[/\\]icon\.png$/);
    });

    it('should omit the icon option when no icon file is present', async () => {
      mockExistsSync.mockReturnValue(false);

      const options = await createWindowOptions();

      expect(options).not.toHaveProperty('icon');
    });
  });
});
