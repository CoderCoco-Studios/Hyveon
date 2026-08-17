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
  makeWinInstance,
  mockGetAllWindows,
  mockExistsSync,
  mockOpenExternal,
  mockSetApplicationMenu,
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
  /** Spy for `win.webContents.setWindowOpenHandler`. */
  const mockSetWindowOpenHandler = vi.fn();
  /** Spy for `shell.openExternal`. */
  const mockOpenExternal = vi.fn().mockResolvedValue(undefined);
  /** Spy for `Menu.setApplicationMenu`. */
  const mockSetApplicationMenu = vi.fn();

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

  /**
   * Builds one mock `BrowserWindow` instance's method surface. Captures `on`/
   * `once` listeners per-instance (keyed by event name) so tests can fire a
   * specific window's `resize`/`closed` events via `__fireWin`, mirroring the
   * `__fire` escape hatch in `WindowService.test.ts`'s `makeWin()`.
   */
  function makeWinInstance() {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const capture = (event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    };
    return {
      loadURL: mockLoadURL,
      loadFile: mockLoadFile,
      webContents: {
        setWindowOpenHandler: mockSetWindowOpenHandler,
        send: vi.fn(),
        getZoomFactor: vi.fn().mockReturnValue(1),
        on: vi.fn(),
      },
      on: vi.fn(capture),
      once: vi.fn(capture),
      isMaximized: vi.fn().mockReturnValue(false),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
      getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1200, height: 800 }),
      setWindowButtonPosition: vi.fn(),
      // Test-only escape hatch to fire a registered listener by event name.
      __fireWin: (event: string, ...args: unknown[]) => listeners[event]?.forEach((cb) => cb(...args)),
    };
  }

  /**
   * Spy BrowserWindow constructor whose instances expose controlled load fns.
   *
   * The implementation must be a `function` expression rather than an arrow:
   * Vitest 4 forwards `new MockBrowserWindow()` to the implementation through
   * `Reflect.construct`, and arrow functions have no [[Construct]] slot, so an
   * arrow implementation throws "is not a constructor" at the `new` site.
   */
  const MockBrowserWindow = Object.assign(
    vi.fn().mockImplementation(function () {
      return makeWinInstance();
    }),
    {
      /** `BrowserWindow.getAllWindows()` static method used by the activate handler. */
      getAllWindows: mockGetAllWindows,
    },
  );

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
    makeWinInstance,
    mockGetAllWindows,
    mockExistsSync,
    mockSetWindowOpenHandler,
    mockOpenExternal,
    mockSetApplicationMenu,
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
  shell: {
    openExternal: mockOpenExternal,
  },
  Menu: {
    setApplicationMenu: mockSetApplicationMenu,
  },
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
    mockOpenExternal.mockResolvedValue(undefined);
    // Default `nestApp.get(...)` return so `WindowService.attach(win)` (called
    // unconditionally after createWindow()) doesn't throw in tests that don't
    // care which service token was requested. Tests that assert on a specific
    // token (e.g. ElectronStoreService, WindowService) override this via
    // fakeNestApp.get.mockReturnValue(...) / mockImplementation(...).
    fakeNestApp.get.mockReturnValue({ attach: vi.fn(), get: vi.fn() });
    mockSetApplicationMenu.mockImplementation(() => undefined);

    // Re-apply the BrowserWindow constructor implementation in case clearMocks
    // cleared it between tests (clearMocks resets call history and return value
    // queues; mockImplementation persists, but we re-set to be defensive).
    MockBrowserWindow.mockImplementation(function () {
      return makeWinInstance();
    });

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

  it('should clear the default application menu on import', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

    await import('./electron-entry.js');

    expect(mockSetApplicationMenu).toHaveBeenCalledExactlyOnceWith(null);
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

  it('should still open the window if initUpdater rejects, since it is void-called and must never block startup', async () => {
    vi.resetModules();
    vi.stubEnv('ELECTRON_RENDERER_URL', undefined);
    initUpdaterMock.mockRejectedValueOnce(new Error('boom'));

    await import('./electron-entry.js');
    await flushPromises();
    whenReadyCallbacks[0]!();
    await flushPromises();

    expect(MockBrowserWindow).toHaveBeenCalledOnce();
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

  describe('platform-conditional BrowserWindow options', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    async function createWindowOptionsForPlatform(platform: string): Promise<Record<string, unknown>> {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      vi.resetModules();
      vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

      await import('./electron-entry.js');
      await flushPromises();
      whenReadyCallbacks[0]!();
      await flushPromises();

      return MockBrowserWindow.mock.calls[0]?.[0] as Record<string, unknown>;
    }

    it('should always set titleBarStyle to hidden', async () => {
      const options = await createWindowOptionsForPlatform('linux');
      expect(options.titleBarStyle).toBe('hidden');
    });

    it('should set trafficLightPosition on macOS, offset into the header past the sidebar, and no titleBarOverlay', async () => {
      const options = await createWindowOptionsForPlatform('darwin');
      // The BrowserWindow's top-left corner is the sidebar (w-60 = 240px), not
      // the header, so the traffic lights must be offset by the sidebar's width
      // to land inside the header rather than on top of the sidebar brand block.
      expect(options.trafficLightPosition).toEqual({ x: 252, y: 20 });
      expect(options.titleBarOverlay).toBeUndefined();
    });

    it('should set titleBarOverlay on Windows and no trafficLightPosition', async () => {
      const options = await createWindowOptionsForPlatform('win32');
      expect(options.titleBarOverlay).toEqual({
        color: '#1a1d2e',
        symbolColor: '#e1e4ed',
        height: 56,
      });
      expect(options.trafficLightPosition).toBeUndefined();
    });

    it('should set neither trafficLightPosition nor titleBarOverlay on Linux', async () => {
      const options = await createWindowOptionsForPlatform('linux');
      expect(options.trafficLightPosition).toBeUndefined();
      expect(options.titleBarOverlay).toBeUndefined();
    });
  });

  describe('macOS traffic-light resize handling', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    /**
     * Imports the entry point on macOS, fires the ready callback, and returns
     * the created mock window instance (with `getBounds`/`setWindowButtonPosition`
     * spies and the `__fireWin` escape hatch for firing its `resize` event).
     */
    async function createDarwinWindow(): Promise<
      ReturnType<typeof makeWinInstance> & { __fireWin: (event: string, ...args: unknown[]) => void }
    > {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.resetModules();
      vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

      await import('./electron-entry.js');
      await flushPromises();
      whenReadyCallbacks[0]!();
      await flushPromises();

      return MockBrowserWindow.mock.results[0]?.value;
    }

    it('should set trafficLightPosition to the sidebar-offset position for the initial (>=768px) window width', async () => {
      const win = await createDarwinWindow();
      // Default mock width is 1200px (>= the 768px `md` breakpoint).
      expect(win.setWindowButtonPosition).toHaveBeenCalledWith({ x: 252, y: 20 });
    });

    it('should switch to the no-sidebar position when the window is resized narrower than 768px', async () => {
      const win = await createDarwinWindow();
      win.setWindowButtonPosition.mockClear();
      win.getBounds.mockReturnValue({ x: 0, y: 0, width: 600, height: 800 });

      win.__fireWin('resize');

      expect(win.setWindowButtonPosition).toHaveBeenCalledWith({ x: 12, y: 20 });
    });

    it('should switch back to the sidebar-offset position when the window is resized back to >=768px', async () => {
      const win = await createDarwinWindow();
      win.getBounds.mockReturnValue({ x: 0, y: 0, width: 600, height: 800 });
      win.__fireWin('resize');
      win.setWindowButtonPosition.mockClear();

      win.getBounds.mockReturnValue({ x: 0, y: 0, width: 1000, height: 800 });
      win.__fireWin('resize');

      expect(win.setWindowButtonPosition).toHaveBeenCalledWith({ x: 252, y: 20 });
    });

    it('should not wire resize-based traffic-light handling on win32 or linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      vi.resetModules();
      vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

      await import('./electron-entry.js');
      await flushPromises();
      whenReadyCallbacks[0]!();
      await flushPromises();

      const win = MockBrowserWindow.mock.results[0]?.value as ReturnType<typeof makeWinInstance>;
      expect(win.setWindowButtonPosition).not.toHaveBeenCalled();
    });
  });

  describe('WindowService wiring', () => {
    it('should resolve WindowService from the bootstrapped Nest app and attach the created window', async () => {
      vi.resetModules();
      vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

      const { WindowService } = await import('./services/WindowService.js');
      const fakeWindowService = { attach: vi.fn() };
      fakeNestApp.get.mockImplementation((token: unknown) => {
        if (token === WindowService) return fakeWindowService;
        return { get: vi.fn() };
      });

      await import('./electron-entry.js');
      await flushPromises();
      whenReadyCallbacks[0]!();
      await flushPromises();

      expect(fakeNestApp.get).toHaveBeenCalledWith(WindowService);
      expect(fakeWindowService.attach).toHaveBeenCalledOnce();
      expect(fakeWindowService.attach).toHaveBeenCalledWith(MockBrowserWindow.mock.results[0]?.value);
    });

    it('should re-attach WindowService to the newly created window when activate fires with zero open windows', async () => {
      vi.resetModules();
      vi.stubEnv('ELECTRON_RENDERER_URL', undefined);

      const { WindowService } = await import('./services/WindowService.js');
      const fakeWindowService = { attach: vi.fn() };
      fakeNestApp.get.mockImplementation((token: unknown) => {
        if (token === WindowService) return fakeWindowService;
        return { get: vi.fn() };
      });

      await import('./electron-entry.js');
      await flushPromises();
      whenReadyCallbacks[0]!();
      await flushPromises();

      // Initial attach from the whenReady().then() path.
      expect(fakeWindowService.attach).toHaveBeenCalledTimes(1);
      const firstWindow = MockBrowserWindow.mock.results[0]?.value;
      expect(fakeWindowService.attach).toHaveBeenCalledWith(firstWindow);

      // Simulate macOS re-opening the app from the dock after every window closed.
      mockGetAllWindows.mockReturnValue([]);
      const activateHandler = onCallbacks['activate'];
      expect(activateHandler).toBeDefined();
      activateHandler!();
      await flushPromises();

      expect(fakeWindowService.attach).toHaveBeenCalledTimes(2);
      const secondWindow = MockBrowserWindow.mock.results[1]?.value;
      expect(fakeWindowService.attach).toHaveBeenLastCalledWith(secondWindow);
    });
  });
});
