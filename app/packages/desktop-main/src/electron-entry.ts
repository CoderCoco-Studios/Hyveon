import { app, BrowserWindow, Menu, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './main.js';
import { electronRendererUrl, isPulumiSpikeEnabled, isTestMode } from './env.js';
import { initUpdater } from './updater.js';
import { ElectronStoreService } from './services/ElectronStoreService.js';
import { WindowService } from './services/WindowService.js';

// electron-vite injects __dirname for main-process entries, but we also
// compute it explicitly via import.meta.url so the file is valid plain ESM.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the PNG shown in the window title bar, the Linux taskbar and the
 * dev-run dock entry.
 *
 * Windows and macOS take their packaged icon from the executable and the app
 * bundle, but Linux and every `npm run desktop:dev` session need an explicit
 * path. Packaged builds find it under `process.resourcesPath` (electron-builder
 * copies it there via `extraResources`); a dev run falls back to the repo's
 * `build/` directory, two levels up from `out/main`.
 *
 * Returns `undefined` when neither copy is present so the window still opens
 * with Electron's default icon rather than failing to start.
 */
export function resolveWindowIcon(): string | undefined {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.png') : undefined,
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
  ];

  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}

/**
 * Routes the renderer's `target="_blank"` links (e.g. the "Open AWS Cost
 * Explorer" link on the costs page) to the operator's default OS browser
 * instead of a new Electron `BrowserWindow`.
 *
 * @param win - The window whose outbound link clicks should be redirected.
 */
function setDefaultBrowserOpener(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((err: unknown) => {
      console.error('[desktop-main] Failed to open external URL:', err);
    });
    return { action: 'deny' };
  });
}

/**
 * Width, in CSS px, below which the sidebar becomes `display: none` — matches
 * `app-layout.component.tsx`'s `hidden md:flex` on the `<aside>` (Tailwind's
 * `md` breakpoint).
 */
const SIDEBAR_BREAKPOINT_PX = 768;

/** `trafficLightPosition` when the sidebar is visible — see `platformWindowChromeOptions()`'s doc comment for the 252/20 derivation. */
const SIDEBAR_TRAFFIC_LIGHT_POSITION = { x: 252, y: 20 };

/**
 * `trafficLightPosition` when the sidebar is hidden (window narrower than
 * `SIDEBAR_BREAKPOINT_PX`) — the header then starts at x: 0, so this matches
 * the header's own 12px left inset instead of the sidebar-offset 252px.
 */
const NO_SIDEBAR_TRAFFIC_LIGHT_POSITION = { x: 12, y: 20 };

/**
 * Builds the platform-conditional `BrowserWindow` chrome options for the
 * custom title bar. `titleBarStyle: 'hidden'` on every platform hides the OS
 * title bar row so the app's own header can act as the draggable title bar.
 * Per-platform additions preserve each OS's native window-control convention
 * rather than drawing app-side buttons everywhere:
 *
 * - macOS keeps native traffic-light buttons, repositioned via
 *   `trafficLightPosition` to align with the merged header. `x: 252` is not
 *   a fixed inset from the window edge the way `y: 20` is — the
 *   `BrowserWindow`'s top-left corner is the sidebar's top-left corner (the
 *   `<aside>` in `app-layout.component.tsx` is `w-60` / 240px wide, and it
 *   renders to the left of the header), so the traffic lights must be offset
 *   past the sidebar's full width before applying the header's own 12px
 *   inset (240 + 12 = 252) or they land on top of the sidebar's brand block
 *   instead of inside the header. `y: 20` vertically centers a ~16px-tall
 *   traffic-light cluster in the header's `h-14` (56px) row: (56 - 16) / 2.
 *   Reuses `SIDEBAR_TRAFFIC_LIGHT_POSITION` rather than repeating the
 *   literal, so this constructor-time default and
 *   `wireTrafficLightResizeHandling`'s runtime updates can never drift apart.
 * - Windows keeps the native `titleBarOverlay` (including the Windows 11
 *   snap-layout flyout), colored to match the header's background/text.
 * - Linux gets neither — the renderer draws its own buttons there.
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
    return { ...base, trafficLightPosition: SIDEBAR_TRAFFIC_LIGHT_POSITION };
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
 * Keeps macOS's traffic-light cluster aligned with the header as the window
 * is resized across the sidebar's responsive breakpoint. `trafficLightPosition`
 * is a `BrowserWindow` constructor-time constant, so a fixed sidebar-offset
 * value is correct only while the sidebar stays visible (width at least
 * 768px) — below that the sidebar is `display: none`
 * (`app-layout.component.tsx`'s `hidden md:flex`) and the header starts at
 * x: 0, leaving the constructor's offset floating in the middle of a
 * now-sidebar-less header. Electron's `win.setWindowButtonPosition()` (the
 * runtime setter for the `trafficLightPosition` constructor option —
 * renamed in Electron's API, the constructor option itself is unchanged)
 * can update the position at runtime, so this listens for the window's
 * native `resize` event and switches between the two positions based on the
 * window's current width.
 *
 * The comparison against `SIDEBAR_BREAKPOINT_PX` — a *CSS*-px value matching
 * the renderer's Tailwind `md` breakpoint — divides `getBounds().width` (a
 * *device*-independent but zoom-*un*aware window width) by the page's current
 * zoom factor first. Without that, pinch-zooming or Ctrl/Cmd-scroll-zooming
 * the renderer shifts the CSS viewport width (and so the sidebar's
 * `display: none` breakpoint) without changing `getBounds().width` at all,
 * desyncing the traffic lights from wherever the header actually starts. A
 * `zoom-changed` listener re-applies the position whenever that happens, not
 * just on `resize`.
 *
 * @param win - The macOS `BrowserWindow` to keep the traffic lights aligned on.
 */
function wireTrafficLightResizeHandling(win: BrowserWindow): void {
  const applyPositionForWidth = (width: number): void => {
    const cssWidth = width / win.webContents.getZoomFactor();
    win.setWindowButtonPosition(
      cssWidth >= SIDEBAR_BREAKPOINT_PX ? SIDEBAR_TRAFFIC_LIGHT_POSITION : NO_SIDEBAR_TRAFFIC_LIGHT_POSITION,
    );
  };
  const applyPositionForCurrentBounds = (): void => applyPositionForWidth(win.getBounds().width);

  applyPositionForCurrentBounds();
  win.on('resize', applyPositionForCurrentBounds);
  win.webContents.on('zoom-changed', applyPositionForCurrentBounds);
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
      // electron-vite names the preload bundle after the input file, and
      // electron.vite.config.ts forces a .cjs extension so Node parses it
      // as CommonJS even though the root package.json is "type": "module" —
      // so the output lands at out/preload/preload.cjs. __dirname here
      // resolves to out/main, so we go one level up.
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  setDefaultBrowserOpener(win);

  if (process.platform === 'darwin') {
    wireTrafficLightResizeHandling(win);
  }

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

// This is a single-purpose operator console, not a document editor — the
// default File/Edit/View/Window menu bar exposes no actions the app uses.
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  bootstrap()
    .then((nestApp) => {
      if (isTestMode()) {
        console.log('[desktop-main] HYVEON_TEST_MODE active — test seam enabled');
      }

      // initUpdater is designed to never reject (see updater.ts), but this
      // catch is a second, independent guarantee that a startup-blocking
      // unhandled rejection can never reach the Electron main process from
      // here, even if that contract is ever violated.
      initUpdater(nestApp.get(ElectronStoreService)).catch((err: unknown) => {
        console.error('[desktop-main] updater init failed:', err);
      });

      const windowService = nestApp.get(WindowService);
      windowService.attach(createWindow());

      // SPIKE SCAFFOLDING — a leftover early prototype for validating the
      // Pulumi Automation API, now superseded by `PulumiEngineService`. Gated
      // behind HYVEON_PULUMI_SPIKE=1 and imported dynamically so that a normal
      // app start never loads `@pulumi/pulumi` or `@grpc/grpc-js`. Remove this
      // block together with `spike/pulumiSpike.ts` and `isPulumiSpikeEnabled()`.
      //
      // `!isTestMode()` is load-bearing, not defensive: Playwright's
      // `electronEnv` spreads the whole inherited environment into every
      // `_electron.launch()`, so a `HYVEON_PULUMI_SPIKE=1` exported in the shell
      // that runs the e2e suite would otherwise reach every launched app and
      // make each spec download a 344 MB engine and run a real `up`. The e2e
      // config also strips the variable (see `electronEnv`); this guard is the
      // half that cannot be bypassed by launching the app some other way.
      if (isPulumiSpikeEnabled() && !isTestMode()) {
        void import('./spike/pulumiSpike.js')
          .then((spike) => spike.runPulumiSpike())
          .catch((err: unknown) => {
            console.error('[desktop-main] pulumi spike failed to load:', err);
          });
      }

      // On macOS re-create the window when the dock icon is clicked and there
      // are no other windows open (standard macOS behaviour). Re-attaching
      // WindowService here (not just on the initial launch path above) matters:
      // without it, WindowService would keep holding a reference to the
      // destroyed original BrowserWindow, silently no-oping every subsequent
      // IPC call from the renderer.
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          windowService.attach(createWindow());
        }
      });
    })
    .catch((err: unknown) => {
      console.error('[desktop-main] NestJS IPC bootstrap failed — quitting:', err);
      app.quit();
    });
});

// Quit the app when all windows are closed, except on macOS where the app and
// its menu bar conventionally stay active until the user explicitly quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
