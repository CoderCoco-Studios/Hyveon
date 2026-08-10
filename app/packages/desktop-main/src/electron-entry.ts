import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './main.js';
import { electronRendererUrl, isPulumiSpikeEnabled, isTestMode } from './env.js';
import { initUpdater } from './updater.js';
import { ElectronStoreService } from './services/ElectronStoreService.js';

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
 * Creates the main application window with the preload script wired in and
 * loads either the dev server URL or the production renderer bundle.
 */
function createWindow(): void {
  const icon = resolveWindowIcon();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(icon ? { icon } : {}),
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

  const rendererUrl = electronRendererUrl();
  const load = rendererUrl
    ? win.loadURL(rendererUrl)
    : win.loadFile(path.join(__dirname, '../renderer/index.html'));

  load.catch((err: unknown) => {
    console.error('[desktop-main] Renderer failed to load — quitting:', err);
    app.quit();
  });
}

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

      createWindow();

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
      // are no other windows open (standard macOS behaviour).
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
