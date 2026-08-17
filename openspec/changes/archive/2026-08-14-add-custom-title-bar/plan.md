# Custom Title Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Electron's OS-default title bar with the app's own top header acting as the draggable title bar — native traffic lights on macOS, native `titleBarOverlay` on Windows, app-drawn buttons on Linux — backed by a new `window.*` IPC surface.

**Architecture:** `electron-entry.ts` creates the `BrowserWindow` with `titleBarStyle: 'hidden'` and platform-conditional chrome options, then wires a new NestJS `WindowService` (holding the live `BrowserWindow` reference) to it post-bootstrap, the same way `initUpdater` already resolves `ElectronStoreService`. A new `WindowController` bridges `window.minimize` / `window.toggleMaximize` / `window.close` / `window.isMaximized` over the existing `@MessagePattern` → `registerIpcMainBridges` → `ipcMain.handle` pipeline; `WindowService.attach` additionally listens for the `BrowserWindow`'s native `maximize`/`unmaximize` events and pushes them straight to the renderer via `win.webContents.send('window.maximizedChange', …)`, bypassing the request/response bridge since this is a push, not an invoke. The preload script exposes all of this under a new `window.hyveon.window` namespace, and `AppLayout`'s existing `<header>` becomes the drag region, feature-detecting `window.hyveon?.window` so the renderer degrades safely outside Electron.

**Tech Stack:** Electron `BrowserWindow` (`titleBarStyle`, `trafficLightPosition`, `titleBarOverlay`), NestJS `@MessagePattern`/`@Controller`, `contextBridge`/`ipcRenderer`, React + `lucide-react` (`Minus`, `Square`, `X`), Vitest, Playwright.

**Spec:** openspec/changes/add-custom-title-bar/design.md

## Global Constraints

- Channel names follow `<namespace>.<action>`: `window.minimize`, `window.toggleMaximize`, `window.close`, `window.isMaximized`, `window.maximizedChange` (D5).
- `toggleMaximize` is a single request/response method — no separate `maximize`/`restore` channels (D5).
- macOS: `titleBarStyle: 'hidden'` + `trafficLightPosition: { x: 252, y: 20 }`; the app renders **no** custom window-control buttons — the OS draws the traffic lights (D2). The x-offset accounts for the sidebar's 240px width, since `trafficLightPosition` is relative to the whole `BrowserWindow` (whose top-left corner is the sidebar), not the header.
- Windows: `titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height: 56 }`; the app renders **no** custom window-control buttons — the OS draws the overlay (D3). `height: 56` matches the header's `h-14` Tailwind class (resolves design.md's first Open Question).
- Linux: `titleBarStyle: 'hidden'`, no overlay; the app renders its own minimize/maximize-or-restore/close buttons using `lucide-react`'s `Minus`, `Square`, `X` (resolves design.md's second Open Question — no strong objection was raised, so the default assumption stands) (D3).
- `window.hyveon.window.platform` is read from `process.platform` once at preload load time — never round-tripped through IPC (D6).
- The renderer feature-detects `window.hyveon?.window` before rendering any drag-region styling or window-control button — absent means render exactly as today (D7).
- Every `@MessagePattern` handler's first line is `logger.debug('<ControllerName>: <pattern> invoked', { ...safeIdentifiers })` (`.claude/rules/logging.md`).
- Every service method that can fail catches the error, normalizes via `err instanceof Error ? err.message : String(err)`, and `logger.warn`/`logger.error`s it — never let a raw error escape uncaught (`.claude/rules/logging.md`).
- New exported functions/classes get TSDoc in strict tag order — summary → `@remarks` → `@param` → `@returns` — using `@param name - description` (hyphen), never invented tags (`.claude/rules/tsdoc-tags.md`).
- No `as unknown as T` casts in tests; prefer `vi.mocked(fn)` / `Partial<T> as T` (root `CLAUDE.md`).
- Test names read as sentences starting with "should" (root `CLAUDE.md`).
- No new deployment-config fields, no infra/Lambda changes — this is desktop-app-only (design.md Migration Plan).

---

### Task 1: Window-control IPC surface — `WindowService` and `WindowController` (desktop-main)

**Files:**
- Create: `app/packages/desktop-main/src/services/WindowService.ts`
- Create: `app/packages/desktop-main/src/services/WindowService.test.ts`
- Create: `app/packages/desktop-main/src/controllers/window.controller.ts`
- Create: `app/packages/desktop-main/src/controllers/window.controller.test.ts`
- Modify: `app/packages/desktop-main/src/app.module.ts`

**Interfaces:**
- Consumes: none (first task).
- Produces:
  - `class WindowService { attach(win: BrowserWindow): void; minimize(): void; toggleMaximize(): void; close(): void; isMaximized(): boolean }` — `attach` also wires `win.on('maximize'|'unmaximize', …)` to push `window.maximizedChange` over `win.webContents.send`.
  - `class WindowController { constructor(window: WindowService); minimize(): void; toggleMaximize(): void; close(): void; isMaximized(): boolean }` with `@MessagePattern`s `window.minimize`, `window.toggleMaximize`, `window.close`, `window.isMaximized`.
  - `WindowController`/`WindowService` registered on `AppModule` (`controllers: [...]`, `providers: [...]`).

- [ ] **Step 1: Write the failing `WindowService` test**
```ts
// app/packages/desktop-main/src/services/WindowService.test.ts
import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WindowService } from './WindowService.js';
import type { BrowserWindow } from 'electron';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a minimal BrowserWindow stub with the methods/events WindowService touches. */
function makeWin(): BrowserWindow {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockReturnValue(false),
    on: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    webContents: { send: vi.fn() },
    // Test-only escape hatch to fire a registered listener by event name.
    __fire: (event: string) => listeners[event]?.forEach((cb) => cb()),
  } as unknown as BrowserWindow & { __fire: (event: string) => void };
}

describe('WindowService', () => {
  let service: WindowService;

  beforeEach(() => {
    service = new WindowService();
  });

  describe('before attach', () => {
    it('should report isMaximized as false when no window is attached', () => {
      expect(service.isMaximized()).toBe(false);
    });

    it('should not throw when minimize/toggleMaximize/close are called with no window attached', () => {
      expect(() => service.minimize()).not.toThrow();
      expect(() => service.toggleMaximize()).not.toThrow();
      expect(() => service.close()).not.toThrow();
    });
  });

  describe('after attach', () => {
    it('should delegate minimize() to win.minimize()', () => {
      const win = makeWin();
      service.attach(win);
      service.minimize();
      expect(win.minimize).toHaveBeenCalledOnce();
    });

    it('should call win.maximize() when toggleMaximize() is called on an unmaximized window', () => {
      const win = makeWin();
      vi.mocked(win.isMaximized).mockReturnValue(false);
      service.attach(win);
      service.toggleMaximize();
      expect(win.maximize).toHaveBeenCalledOnce();
      expect(win.unmaximize).not.toHaveBeenCalled();
    });

    it('should call win.unmaximize() when toggleMaximize() is called on a maximized window', () => {
      const win = makeWin();
      vi.mocked(win.isMaximized).mockReturnValue(true);
      service.attach(win);
      service.toggleMaximize();
      expect(win.unmaximize).toHaveBeenCalledOnce();
      expect(win.maximize).not.toHaveBeenCalled();
    });

    it('should delegate close() to win.close()', () => {
      const win = makeWin();
      service.attach(win);
      service.close();
      expect(win.close).toHaveBeenCalledOnce();
    });

    it('should return the attached window\'s isMaximized() result', () => {
      const win = makeWin();
      vi.mocked(win.isMaximized).mockReturnValue(true);
      service.attach(win);
      expect(service.isMaximized()).toBe(true);
    });

    it('should push window.maximizedChange with true when the window fires its native maximize event', () => {
      const win = makeWin() as BrowserWindow & { __fire: (event: string) => void };
      service.attach(win);
      win.__fire('maximize');
      expect(win.webContents.send).toHaveBeenCalledWith('window.maximizedChange', true);
    });

    it('should push window.maximizedChange with false when the window fires its native unmaximize event', () => {
      const win = makeWin() as BrowserWindow & { __fire: (event: string) => void };
      service.attach(win);
      win.__fire('unmaximize');
      expect(win.webContents.send).toHaveBeenCalledWith('window.maximizedChange', false);
    });
  });
});
```
- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- app/packages/desktop-main/src/services/WindowService.test.ts`
Expected: FAIL with `Cannot find module './WindowService.js'` (the file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**
```ts
// app/packages/desktop-main/src/services/WindowService.ts
import { Injectable } from '@nestjs/common';
import type { BrowserWindow } from 'electron';
import { logger } from '../logger.js';

/**
 * Drives the single main `BrowserWindow`'s minimize/maximize/close chrome and
 * forwards its native maximize/unmaximize state to the renderer.
 *
 * @remarks
 * Holds no `BrowserWindow` reference until {@link attach} is called — mirrors
 * `ElectronStoreService`'s "safe to construct before Electron is ready"
 * shape. `electron-entry.ts` calls `nestApp.get(WindowService).attach(win)`
 * immediately after `createWindow()` returns, the same post-bootstrap
 * resolution pattern already used for `initUpdater`/`ElectronStoreService`.
 * Before `attach` is called (or if it is never called, e.g. in a plain-Node
 * test harness), every method is a safe no-op.
 */
@Injectable()
export class WindowService {
  private win: BrowserWindow | null = null;

  /**
   * Wires this service to the live main window and starts forwarding its
   * native maximize-state changes to the renderer over `window.maximizedChange`.
   *
   * @param win - The `BrowserWindow` created by `electron-entry.ts`'s `createWindow()`.
   */
  attach(win: BrowserWindow): void {
    this.win = win;
    win.on('maximize', () => this.pushMaximizedChange(true));
    win.on('unmaximize', () => this.pushMaximizedChange(false));
  }

  /** Minimizes the attached window. No-op if no window is attached. */
  minimize(): void {
    if (!this.win) return;
    try {
      this.win.minimize();
    } catch (err) {
      logger.warn(`WindowService: minimize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Maximizes the attached window if it is not currently maximized, or
   * restores it if it is — a single toggle so callers never have to track
   * maximize state themselves. No-op if no window is attached.
   */
  toggleMaximize(): void {
    if (!this.win) return;
    try {
      if (this.win.isMaximized()) {
        this.win.unmaximize();
      } else {
        this.win.maximize();
      }
    } catch (err) {
      logger.warn(`WindowService: toggleMaximize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Closes the attached window. No-op if no window is attached. */
  close(): void {
    if (!this.win) return;
    try {
      this.win.close();
    } catch (err) {
      logger.warn(`WindowService: close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * @returns The attached window's current maximized state, or `false` if no
   *   window is attached.
   */
  isMaximized(): boolean {
    if (!this.win) return false;
    return this.win.isMaximized();
  }

  /**
   * Pushes the window's current maximized state to the renderer over the
   * `window.maximizedChange` channel. This is a push (main → renderer), not a
   * `@MessagePattern` request/response — it goes straight over
   * `webContents.send`, since `registerIpcMainBridges` only bridges
   * request/response `@MessagePattern` handlers.
   *
   * @param isMaximized - The new maximized state to report.
   */
  private pushMaximizedChange(isMaximized: boolean): void {
    if (!this.win) return;
    try {
      this.win.webContents.send('window.maximizedChange', isMaximized);
    } catch (err) {
      logger.warn(`WindowService: failed to push maximizedChange: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```
- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- app/packages/desktop-main/src/services/WindowService.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Write the failing `WindowController` test**
```ts
// app/packages/desktop-main/src/controllers/window.controller.test.ts
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WindowController } from './window.controller.js';
import type { WindowService } from '../services/WindowService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a WindowService stub with all methods wired to succeed. */
function makeWindowService(): WindowService {
  return {
    attach: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockReturnValue(false),
  } as unknown as WindowService;
}

describe('WindowController', () => {
  describe('minimize', () => {
    it('should delegate to WindowService.minimize', () => {
      const window = makeWindowService();
      new WindowController(window).minimize();
      expect(window.minimize).toHaveBeenCalledOnce();
    });
  });

  describe('toggleMaximize', () => {
    it('should delegate to WindowService.toggleMaximize', () => {
      const window = makeWindowService();
      new WindowController(window).toggleMaximize();
      expect(window.toggleMaximize).toHaveBeenCalledOnce();
    });
  });

  describe('close', () => {
    it('should delegate to WindowService.close', () => {
      const window = makeWindowService();
      new WindowController(window).close();
      expect(window.close).toHaveBeenCalledOnce();
    });
  });

  describe('isMaximized', () => {
    it('should return the result of WindowService.isMaximized', () => {
      const window = makeWindowService();
      vi.mocked(window.isMaximized).mockReturnValue(true);
      const result = new WindowController(window).isMaximized();
      expect(result).toBe(true);
    });
  });
});
```
- [ ] **Step 6: Run test to verify it fails**

Run: `npm run app:test -- app/packages/desktop-main/src/controllers/window.controller.test.ts`
Expected: FAIL with `Cannot find module './window.controller.js'` (the file doesn't exist yet).

- [ ] **Step 7: Write minimal implementation and register in `AppModule`**
```ts
// app/packages/desktop-main/src/controllers/window.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { WindowService } from '../services/WindowService.js';
import { logger } from '../logger.js';

/**
 * IPC-only controller for the main window's chrome controls. Every handler is
 * bound to an IPC channel via `@MessagePattern` — no HTTP routes are
 * registered here.
 */
@Controller()
export class WindowController {
  constructor(private readonly window: WindowService) {}

  /** Minimizes the main window. */
  @MessagePattern('window.minimize')
  minimize(): void {
    logger.debug('WindowController: window.minimize invoked');
    this.window.minimize();
  }

  /** Toggles the main window between maximized and restored. */
  @MessagePattern('window.toggleMaximize')
  toggleMaximize(): void {
    logger.debug('WindowController: window.toggleMaximize invoked');
    this.window.toggleMaximize();
  }

  /** Closes the main window. */
  @MessagePattern('window.close')
  close(): void {
    logger.debug('WindowController: window.close invoked');
    this.window.close();
  }

  /** Queries the main window's current maximized state. */
  @MessagePattern('window.isMaximized')
  isMaximized(): boolean {
    logger.debug('WindowController: window.isMaximized invoked');
    return this.window.isMaximized();
  }
}
```

Edit `app/packages/desktop-main/src/app.module.ts`:
```ts
import { WindowController } from './controllers/window.controller.js';
// ...existing imports...
import { WindowService } from './services/WindowService.js';
```
Add `WindowController` to the `controllers` array (alongside `CloudHealthController`), and `WindowService` to the `providers` array (alongside `AuditService`).

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run app:test -- app/packages/desktop-main/src/controllers/window.controller.test.ts app/packages/desktop-main/src/services/WindowService.test.ts`
Expected: PASS (15 tests total)

- [ ] **Step 9: Commit**
```bash
git add app/packages/desktop-main/src/services/WindowService.ts \
        app/packages/desktop-main/src/services/WindowService.test.ts \
        app/packages/desktop-main/src/controllers/window.controller.ts \
        app/packages/desktop-main/src/controllers/window.controller.test.ts \
        app/packages/desktop-main/src/app.module.ts
git commit -m "feat(desktop-main): add window-control IPC surface (WindowService/WindowController)"
```

---

### Task 2: Preload bridge — `window.hyveon.window` namespace

**Files:**
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts`
- Modify: `app/packages/desktop-preload/src/preload.ts`
- Modify: `app/packages/desktop-preload/src/preload.test.ts`

**Interfaces:**
- Consumes: the IPC channel names from Task 1 — `window.minimize`, `window.toggleMaximize`, `window.close`, `window.isMaximized`, `window.maximizedChange`.
- Produces: `interface HyveonWindowApi { platform: NodeJS.Platform; minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; isMaximized(): Promise<boolean>; onMaximizedChange(cb: (isMaximized: boolean) => void): () => void }`, exposed on `window.hyveon.window` — later tasks (Task 4) call `window.hyveon.window.minimize()`, `.toggleMaximize()`, `.close()`, `.isMaximized()`, `.onMaximizedChange(cb)`, and read `.platform`.

- [ ] **Step 1: Write the failing preload test**
```ts
// Add to app/packages/desktop-preload/src/preload.test.ts, inside the existing
// 'real-IPC fallthrough' describe block (reuses that block's `bridge` from
// loadPreloadBridge('0')).

describe('window namespace', () => {
  let bridge: Record<string, unknown>;

  beforeEach(async () => {
    bridge = await loadPreloadBridge('0');
  });

  it('should expose the current process platform without an IPC round-trip', () => {
    const windowApi = bridge['window'] as { platform: NodeJS.Platform };
    expect(windowApi.platform).toBe(process.platform);
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  it('should forward minimize() to ipcRenderer.invoke("window.minimize")', async () => {
    ipcInvoke.mockResolvedValue(undefined);
    const windowApi = bridge['window'] as { minimize: () => Promise<void> };
    await windowApi.minimize();
    expect(ipcInvoke).toHaveBeenCalledWith('window.minimize');
  });

  it('should forward toggleMaximize() to ipcRenderer.invoke("window.toggleMaximize")', async () => {
    ipcInvoke.mockResolvedValue(undefined);
    const windowApi = bridge['window'] as { toggleMaximize: () => Promise<void> };
    await windowApi.toggleMaximize();
    expect(ipcInvoke).toHaveBeenCalledWith('window.toggleMaximize');
  });

  it('should forward close() to ipcRenderer.invoke("window.close")', async () => {
    ipcInvoke.mockResolvedValue(undefined);
    const windowApi = bridge['window'] as { close: () => Promise<void> };
    await windowApi.close();
    expect(ipcInvoke).toHaveBeenCalledWith('window.close');
  });

  it('should resolve isMaximized() with the value ipcRenderer.invoke("window.isMaximized") resolves', async () => {
    ipcInvoke.mockResolvedValue(true);
    const windowApi = bridge['window'] as { isMaximized: () => Promise<boolean> };
    await expect(windowApi.isMaximized()).resolves.toBe(true);
    expect(ipcInvoke).toHaveBeenCalledWith('window.isMaximized');
  });

  it('should invoke the onMaximizedChange callback when window.maximizedChange fires', () => {
    const windowApi = bridge['window'] as {
      onMaximizedChange: (cb: (isMaximized: boolean) => void) => () => void;
    };
    const cb = vi.fn();
    windowApi.onMaximizedChange(cb);

    expect(ipcOn).toHaveBeenCalledWith('window.maximizedChange', expect.any(Function));
    const listener = ipcOn.mock.calls.find(([channel]) => channel === 'window.maximizedChange')?.[1] as (
      event: unknown,
      isMaximized: boolean,
    ) => void;
    listener({}, true);
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('should remove the listener when the onMaximizedChange unsubscribe function is called', () => {
    const windowApi = bridge['window'] as {
      onMaximizedChange: (cb: (isMaximized: boolean) => void) => () => void;
    };
    const unsubscribe = windowApi.onMaximizedChange(vi.fn());
    unsubscribe();
    expect(ipcRemoveListener).toHaveBeenCalledWith('window.maximizedChange', expect.any(Function));
  });
});
```
- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- app/packages/desktop-preload/src/preload.test.ts`
Expected: FAIL with `bridge['window']` being `undefined` — `Cannot read properties of undefined (reading 'platform')` (the namespace doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `app/packages/desktop-preload/src/hyveon-api.ts`, add near the other namespace interfaces (e.g. after `HyveonIacSettingsApi`):
```ts
/**
 * Window-chrome API backing the custom title bar: the current OS platform
 * (read once at preload load time, no IPC round-trip) and typed access to
 * the main window's minimize/maximize/close IPC channels.
 */
export interface HyveonWindowApi {
  /** Current OS platform, read from `process.platform` inside the preload script. Never changes during a session. */
  platform: NodeJS.Platform;
  /** Invokes the `window.minimize` IPC channel. */
  minimize: () => Promise<void>;
  /** Invokes the `window.toggleMaximize` IPC channel. */
  toggleMaximize: () => Promise<void>;
  /** Invokes the `window.close` IPC channel. */
  close: () => Promise<void>;
  /** Invokes the `window.isMaximized` IPC channel and resolves with the current maximized state. */
  isMaximized: () => Promise<boolean>;
  /**
   * Subscribes to `window.maximizedChange` push events from the main process.
   *
   * @param cb - Called with the window's new maximized state whenever it changes.
   * @returns An unsubscribe function that removes the underlying IPC listener.
   */
  onMaximizedChange: (cb: (isMaximized: boolean) => void) => () => void;
}
```
Then add `window: HyveonWindowApi;` to the `HyveonApi` interface (alongside the other namespace fields, e.g. after `diagnostics: HyveonDiagnosticsApi;`).

In `app/packages/desktop-preload/src/preload.ts`, add to the `api` object (after the `iac: { ... }` block):
```ts
  window: {
    platform: process.platform,
    minimize: () => invoke<void>('window.minimize'),
    toggleMaximize: () => invoke<void>('window.toggleMaximize'),
    close: () => invoke<void>('window.close'),
    isMaximized: () => invoke<boolean>('window.isMaximized'),
    onMaximizedChange: (cb: (isMaximized: boolean) => void) => {
      const listener = (_event: IpcRendererEvent, isMaximized: boolean) => cb(isMaximized);
      ipcRenderer.on('window.maximizedChange', listener);
      return () => ipcRenderer.removeListener('window.maximizedChange', listener);
    },
  },
```
- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- app/packages/desktop-preload/src/preload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add app/packages/desktop-preload/src/hyveon-api.ts \
        app/packages/desktop-preload/src/preload.ts \
        app/packages/desktop-preload/src/preload.test.ts
git commit -m "feat(desktop-preload): add window.hyveon.window namespace"
```

---

### Task 3: BrowserWindow chrome — platform-conditional options in `electron-entry.ts`

**Files:**
- Modify: `app/packages/desktop-main/src/electron-entry.ts`
- Modify: `app/packages/desktop-main/src/electron-entry.test.ts`

**Interfaces:**
- Consumes: `WindowService.attach(win: BrowserWindow): void` (Task 1).
- Produces: `createWindow(): BrowserWindow` (changed from `void` — returns the created window so `app.whenReady()`'s `.then()` chain can pass it to `WindowService.attach`).

- [ ] **Step 1: Write the failing tests**
```ts
// Add to app/packages/desktop-main/src/electron-entry.test.ts

// Extend the vi.hoisted() block's MockBrowserWindow factory (Step 3 below
// updates the shared mock to include `on`, `isMaximized`, `minimize`,
// `maximize`, `unmaximize`, `close`) — these new tests assume that shape.

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

  it('should set trafficLightPosition on macOS and no titleBarOverlay', async () => {
    const options = await createWindowOptionsForPlatform('darwin');
    expect(options.trafficLightPosition).toEqual({ x: 12, y: 12 });
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
});
```
- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- app/packages/desktop-main/src/electron-entry.test.ts`
Expected: FAIL — `options.titleBarStyle` is `undefined` (not yet set), and `fakeNestApp.get` is never called with `WindowService` (not yet wired).

- [ ] **Step 3: Write minimal implementation**

Update the shared `MockBrowserWindow` mock factory (both in `vi.hoisted()` and the `beforeEach` re-apply block) to include the methods `WindowService.attach` would call, so Task 1's wiring doesn't throw during these tests:
```ts
const MockBrowserWindow = Object.assign(
  vi.fn().mockImplementation(function () {
    return {
      loadURL: mockLoadURL,
      loadFile: mockLoadFile,
      webContents: { setWindowOpenHandler: mockSetWindowOpenHandler, send: vi.fn() },
      on: vi.fn(),
      isMaximized: vi.fn().mockReturnValue(false),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
    };
  }),
  {
    getAllWindows: mockGetAllWindows,
  },
);
```
(Apply the identical change to the `beforeEach` re-apply block.)

Update `app/packages/desktop-main/src/electron-entry.ts`:
```ts
import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './main.js';
import { electronRendererUrl, isPulumiSpikeEnabled, isTestMode } from './env.js';
import { initUpdater } from './updater.js';
import { ElectronStoreService } from './services/ElectronStoreService.js';
import { WindowService } from './services/WindowService.js';

// ...resolveWindowIcon(), setDefaultBrowserOpener() unchanged...

/**
 * Builds the platform-conditional `BrowserWindow` chrome options for the
 * custom title bar. `titleBarStyle: 'hidden'` on every platform hides the OS
 * title bar row so the app's own header can act as the draggable title bar
 * (D1). Per-platform additions preserve each OS's native window-control
 * convention rather than drawing app-side buttons everywhere (D2/D3):
 *
 * - macOS keeps native traffic-light buttons, repositioned via
 *   `trafficLightPosition` to align with the merged header.
 * - Windows keeps the native `titleBarOverlay` (including the Windows 11
 *   snap-layout flyout), colored to match the header's background/text.
 * - Linux gets neither — the renderer draws its own buttons there (Task 4),
 *   since no native overlay/traffic-light equivalent exists on Linux.
 *
 * The overlay's `height: 56` matches the header's `h-14` Tailwind class; its
 * `color`/`symbolColor` match `--color-surface` (#1a1d2e) and
 * `--color-foreground` (#e1e4ed) from `app/packages/web/src/index.css`, the
 * header's actual background/text colors — the app has no runtime theme
 * switching yet, so these are hard-coded rather than resolved dynamically.
 *
 * @returns The platform-specific subset of `BrowserWindowConstructorOptions` to spread into `createWindow()`'s options.
 */
function platformWindowChromeOptions(): Partial<Electron.BrowserWindowConstructorOptions> {
  const base: Partial<Electron.BrowserWindowConstructorOptions> = { titleBarStyle: 'hidden' };

  if (process.platform === 'darwin') {
    return { ...base, trafficLightPosition: { x: 12, y: 12 } };
  }
  if (process.platform === 'win32') {
    return {
      ...base,
      titleBarOverlay: { color: '#1a1d2e', symbolColor: '#e1e4ed', height: 56 },
    };
  }
  return base;
}

/**
 * Creates the main application window with the preload script wired in and
 * loads either the dev server URL or the production renderer bundle.
 *
 * @returns The created `BrowserWindow`, so callers (`app.whenReady()`'s chain)
 *   can attach it to `WindowService` once the Nest app is available.
 */
function createWindow(): BrowserWindow {
  const icon = resolveWindowIcon();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(icon ? { icon } : {}),
    ...platformWindowChromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  setDefaultBrowserOpener(win);

  const rendererUrl = electronRendererUrl();
  const load = rendererUrl
    ? win.loadURL(rendererUrl)
    : win.loadFile(path.join(__dirname, '../renderer/index.html'));

  load.catch((err: unknown) => {
    console.error('[desktop-main] Renderer failed to load — quitting:', err);
    app.quit();
  });

  return win;
}

app.whenReady().then(() => {
  bootstrap()
    .then((nestApp) => {
      if (isTestMode()) {
        console.log('[desktop-main] HYVEON_TEST_MODE active — test seam enabled');
      }

      initUpdater(nestApp.get(ElectronStoreService)).catch((err: unknown) => {
        console.error('[desktop-main] updater init failed:', err);
      });

      const win = createWindow();
      nestApp.get(WindowService).attach(win);

      if (isPulumiSpikeEnabled() && !isTestMode()) {
        void import('./spike/pulumiSpike.js')
          .then((spike) => spike.runPulumiSpike())
          .catch((err: unknown) => {
            console.error('[desktop-main] pulumi spike failed to load:', err);
          });
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((err: unknown) => {
      console.error('[desktop-main] NestJS IPC bootstrap failed — quitting:', err);
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```
- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- app/packages/desktop-main/src/electron-entry.test.ts`
Expected: PASS (all existing tests plus the new ones)

- [ ] **Step 5: Commit**
```bash
git add app/packages/desktop-main/src/electron-entry.ts \
        app/packages/desktop-main/src/electron-entry.test.ts
git commit -m "feat(desktop-main): hide OS title bar with platform-conditional chrome, wire WindowService"
```

---

### Task 4: Renderer — draggable header and platform-conditional controls

**Files:**
- Modify: `app/packages/web/src/components/app-layout.component.tsx`
- Modify: `app/packages/web/src/components/app-layout.component.test.tsx`

**Interfaces:**
- Consumes: `window.hyveon.window.platform: NodeJS.Platform`, `window.hyveon.window.minimize(): Promise<void>`, `window.hyveon.window.toggleMaximize(): Promise<void>`, `window.hyveon.window.close(): Promise<void>`, `window.hyveon.window.isMaximized(): Promise<boolean>`, `window.hyveon.window.onMaximizedChange(cb): () => void` (Task 2).
- Produces: `function WindowControls(): JSX.Element | null`, rendered inside `AppLayout`'s `<header>`; no new exports consumed by a later task.

- [ ] **Step 1: Write the failing tests**
```ts
// Add to app/packages/web/src/components/app-layout.component.test.tsx

describe('AppLayout — window chrome (custom title bar)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should not add drag-region styling or render window controls when window.hyveon is absent', () => {
    vi.unstubAllGlobals();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    expect(header.style.getPropertyValue('-webkit-app-region')).not.toBe('drag');
    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
  });

  it('should mark the header as a drag region when window.hyveon.window is present', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    expect(header.style.getPropertyValue('-webkit-app-region')).toBe('drag');
  });

  it('should mark every interactive header child as no-drag', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const refreshButton = screen.getByRole('button', { name: 'Refresh all' });
    expect(refreshButton.style.getPropertyValue('-webkit-app-region')).toBe('no-drag');
  });

  it('should render Linux minimize/maximize/close buttons when platform is linux', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('should not render any window-control buttons when platform is darwin', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('should not render any window-control buttons when platform is win32', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'win32',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('should call window.hyveon.window.minimize() when the Minimize button is clicked', async () => {
    const minimize = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize,
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });
    const user = userEvent.setup();

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(minimize).toHaveBeenCalledOnce();
  });

  it('should call window.hyveon.window.close() when the Close button is clicked', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close,
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });
    const user = userEvent.setup();

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('should swap the maximize button to a restore icon when onMaximizedChange reports true', async () => {
    let fireMaximizedChange: (isMaximized: boolean) => void = () => undefined;
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn((cb: (isMaximized: boolean) => void) => {
          fireMaximizedChange = cb;
          return vi.fn();
        }),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();

    await act(async () => {
      fireMaximizedChange(true);
    });

    expect(screen.queryByRole('button', { name: 'Maximize' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });
});
```
- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- app/packages/web/src/components/app-layout.component.test.tsx`
Expected: FAIL — `screen.getByRole('button', { name: 'Minimize' })` throws "Unable to find an accessible element" (no window controls exist yet), and the header has no `-webkit-app-region` style.

- [ ] **Step 3: Write minimal implementation**

Edit `app/packages/web/src/components/app-layout.component.tsx`:

Add imports:
```ts
import { useEffect, useState, type CSSProperties } from 'react';
// ...existing lucide-react import, extend with:
import {
  LayoutDashboard,
  Server,
  ScrollText,
  DollarSign,
  MessageSquare,
  Settings,
  Gamepad2,
  RefreshCw,
  Menu,
  X,
  History,
  Cloud,
  Minus,
  Square,
} from 'lucide-react';
```

Add a `WindowControls` component (place it near `RefreshAllButton`/`LiveIndicator`):
```tsx
/**
 * App-drawn minimize/maximize-or-restore/close buttons for the custom title
 * bar. Renders `null` unless `window.hyveon?.window` is present AND the
 * platform is Linux — macOS keeps native traffic lights and Windows keeps
 * the native `titleBarOverlay`, so this component draws nothing there (the
 * `BrowserWindow` chrome itself, not this component, reserves layout space
 * for those OS-drawn controls).
 */
function WindowControls() {
  const windowApi = window.hyveon?.window;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!windowApi) return;
    windowApi.isMaximized().then(setIsMaximized).catch(() => undefined);
    const unsubscribe = windowApi.onMaximizedChange(setIsMaximized);
    return unsubscribe;
  }, [windowApi]);

  if (!windowApi || windowApi.platform !== 'linux') return null;

  return (
    <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
      <button
        type="button"
        onClick={() => void windowApi.minimize()}
        aria-label="Minimize"
        className="min-h-8 min-w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Minus className="w-4 h-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void windowApi.toggleMaximize()}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        className="min-h-8 min-w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Square className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void windowApi.close()}
        aria-label="Close"
        className="min-h-8 min-w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
```

Update the `<header>` and its interactive children in `AppLayout`:
```tsx
        <header
          className="h-14 border-b border-border bg-card flex items-center justify-between px-4 md:px-6"
          style={window.hyveon?.window ? ({ WebkitAppRegion: 'drag' } as CSSProperties) : undefined}
        >
          <div className="flex items-center gap-4">
            {/* Hamburger button — only visible on mobile */}
            <button
              type="button"
              onClick={openMobileMenu}
              aria-label="Open navigation"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav"
              style={window.hyveon?.window ? ({ WebkitAppRegion: 'no-drag' } as CSSProperties) : undefined}
              className="shrink-0 md:hidden min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>

            <h1 className="hidden sm:block text-lg font-semibold text-foreground shrink-0">Hyveon</h1>
            <span className="inline-flex shrink-0 items-center px-2.5 py-0.5 rounded text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
              {envLabel}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <RefreshAllButton />
            <LiveIndicator />

            {/* Avatar placeholder — decorative */}
            <div
              className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center"
              aria-hidden="true"
              style={window.hyveon?.window ? ({ WebkitAppRegion: 'no-drag' } as CSSProperties) : undefined}
            >
              <span className="text-xs font-medium text-white">OP</span>
            </div>

            <WindowControls />
          </div>
        </header>
```

Update `RefreshAllButton` and `LiveIndicator` to mark themselves `no-drag` (only meaningful inside the header, harmless elsewhere since the inline style is a no-op without a surrounding drag region):
```tsx
export function RefreshAllButton() {
  const { refreshAll } = usePollingActions();
  const { pollers } = usePollingState();
  const anyLoading = Object.values(pollers).some((p) => p.loading);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void refreshAll()}
      aria-label="Refresh all"
      aria-busy={anyLoading}
      disabled={Object.keys(pollers).length === 0}
      style={window.hyveon?.window ? ({ WebkitAppRegion: 'no-drag' } as CSSProperties) : undefined}
    >
      <RefreshCw className={cn('size-3.5', anyLoading && 'motion-safe:animate-spin')} aria-hidden="true" />
      <span className="hidden sm:inline">Refresh</span>
    </Button>
  );
}

export function LiveIndicator() {
  const { pollers, now } = usePollingState();
  const entries = Object.values(pollers);
  const anyFresh = entries.some((p) => p.lastSuccessAt !== null && !isStale(p, now));
  const allStale = entries.length > 0 && entries.every((p) => isStale(p, now));
  const dotClass = anyFresh
    ? 'bg-[var(--color-cyan)] motion-safe:animate-pulse'
    : allStale
      ? 'bg-[var(--color-muted-foreground)]/60'
      : 'bg-[var(--color-muted-foreground)]/40';
  const labelClass = allStale
    ? 'text-[var(--color-muted-foreground)]/60'
    : 'text-muted-foreground';
  const statusLabel = anyFresh ? 'Live — data is current' : allStale ? 'Stale — data may be out of date' : 'Connecting';
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded border border-border"
      role="status"
      aria-label={statusLabel}
      style={window.hyveon?.window ? ({ WebkitAppRegion: 'no-drag' } as CSSProperties) : undefined}
    >
      <div className={cn('w-2 h-2 rounded-full', dotClass)} aria-hidden="true" />
      <span className={cn('hidden sm:inline text-xs font-medium', labelClass)} aria-hidden="true">LIVE</span>
    </div>
  );
}
```
- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- app/packages/web/src/components/app-layout.component.test.tsx`
Expected: PASS (all existing tests plus the new ones)

- [ ] **Step 5: Commit**
```bash
git add app/packages/web/src/components/app-layout.component.tsx \
        app/packages/web/src/components/app-layout.component.test.tsx
git commit -m "feat(web): make the top header a drag region with platform-conditional window controls"
```

---

### Task 5: Docs

**Files:**
- Modify: `docs/docs/components/management-app.md`
- Modify: any `docs/docs/app/*` page describing the top bar / title bar (identified during Step 1 research below)

**Interfaces:**
- Consumes: nothing code-facing — this task documents the channels/behavior Tasks 1-4 already implemented.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Research — locate every doc page needing an update**

This step has no test (documentation task). Use the `write-docs` skill (per root `CLAUDE.md`'s "Before opening a PR" section) to map this change's diff to the pages that own it:
```bash
grep -rn "title bar\|titleBarStyle\|IPC channel" docs/docs/components/management-app.md docs/docs/app/*.md
```
Confirm which `docs/docs/app/*` page (if any) describes the top bar's screenshot or written behavior — update it to mention the merged title bar and platform-specific controls if found.

- [ ] **Step 2: N/A (no test to run for documentation)**

- [ ] **Step 3: Write the docs**

In `docs/docs/components/management-app.md`, add five rows to the existing IPC channel table (matching its existing column format — channel, direction, purpose):

| Channel | Purpose |
|---|---|
| `window.minimize` | Minimizes the main window. |
| `window.toggleMaximize` | Maximizes the main window if unmaximized, restores it if maximized. |
| `window.close` | Closes the main window. |
| `window.isMaximized` | Returns the main window's current maximized state. |
| `window.maximizedChange` (push, main → renderer) | Fired whenever the main window's maximized state changes, for any reason (button click, header double-click, OS-level snap/restore). |

Update any `docs/docs/app/*` page found in Step 1 to describe the merged title bar (app header now includes window controls; native traffic lights on macOS, native overlay on Windows, app-drawn buttons on Linux) and, if it embeds a screenshot, note that the screenshot should be refreshed in a follow-up (screenshots are not regenerated by this plan).

- [ ] **Step 4: N/A (no test to run for documentation)**

- [ ] **Step 5: Commit**
```bash
git add docs/docs/components/management-app.md docs/docs/app/
git commit -m "docs: document the window-control IPC channels and merged title bar"
```

---

### Task 6: Verification

**Files:**
- None (no code changes — this task runs the repo's pre-PR gate and the manual check).

**Interfaces:**
- Consumes: the complete change from Tasks 1-5.
- Produces: nothing — this is the final gate before opening a PR.

- [ ] **Step 1: Lint**

Run: `npm run app:lint`
Expected: clean, zero errors.

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: clean, zero errors — this is the step that catches any drift between `WindowService`/`WindowController`'s signatures (Task 1), the `HyveonWindowApi` interface (Task 2), and `WindowControls`'s usage (Task 4).

- [ ] **Step 3: Unit tests**

Run: `npm run app:test`
Expected: full suite green, including every new test file from Tasks 1, 2, and 4.

- [ ] **Step 4: E2E**

Run: `npm run app:test:e2e`
Expected: the `chromium` project passes unmodified (no `window.hyveon`, header renders exactly as before — Requirement "Renderer degrades safely outside Electron" in `specs/custom-title-bar/spec.md`); the `electron` project reflects the new chrome where applicable and stays green.

- [ ] **Step 5: Manual per-platform check**

Run: `npm run desktop:dev`

On whichever platform is actually available in dev:
- Drag an empty area of the top header — the OS window moves.
- Click the mobile nav toggle (resize below `md` breakpoint), Refresh button, LIVE indicator, and avatar placeholder — each responds normally and does not trigger a window-drag gesture.
- Click minimize/maximize/restore/close (Linux: the app-drawn buttons; macOS: the native traffic lights; Windows: the native overlay) — window behaves correctly and the button icon (Linux only) reflects the current maximized state after a double-click-to-maximize or OS-level snap.
- Confirm no separate OS-drawn title bar row appears above the app's own header.

- [ ] **Step 6: Commit** (only if Step 5 surfaces a fix — otherwise this task produces no commit)
```bash
# Only if a fix was needed during manual verification:
git add <fixed files>
git commit -m "fix(desktop): <describe the manual-verification fix>"
```
