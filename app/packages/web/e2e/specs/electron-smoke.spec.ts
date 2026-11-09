import { test, expect, launchElectron } from '../fixtures/index.js';
import { AppLayout } from '../pages/index.js';

/**
 * Smoke spec for the native Electron shell.
 *
 * Asserts two things that prove the app launches correctly:
 *  1. A BrowserWindow is opened (firstWindow() resolves).
 *  2. `window.hyveon` is defined — confirming the preload script ran and
 *     exposed the IPC bridge to the renderer.
 *
 * Each test manages its own ElectronApplication lifecycle so the spec is
 * self-contained and runnable independently of the global setup.
 */
test.describe('electron smoke', () => {
  test('should open a BrowserWindow', async () => {
    const { app, win } = await launchElectron();

    try {
      expect(win).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  // @spec APP-IPC-NAME-001
  test('should expose window.hyveon from the preload script', async () => {
    const { app, win } = await launchElectron();

    try {
      const hyveon = await win.evaluate(() => typeof window.hyveon);
      expect(hyveon).toBe('object');
    } finally {
      await app.close();
    }
  });

  /**
   * Exercises the custom title bar (add-custom-title-bar) against the real
   * preload bridge — earlier coverage only asserted `window.hyveon` exists,
   * not that the header is actually a drag region or that the renderer draws
   * no window buttons of its own (native chrome on every platform, see
   * `platformWindowChromeOptions()` in `electron-entry.ts`).
   */
  test('should mark the header as a drag region and render no app-drawn window controls', async () => {
    const { app, win } = await launchElectron();

    try {
      const layout = new AppLayout(win);

      const appRegion = await layout.header().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
      expect(appRegion).toBe('drag');

      // `window.hyveon` is globally typed as `HyveonApi | undefined` (see
      // `@hyveon/desktop-preload`'s `declare global` in `index.ts`) and the
      // previous test already established it's defined in this renderer —
      // the `!` narrows that without an `as unknown as T` cast.
      const platform = await win.evaluate(() => window.hyveon!.window.platform);

      // The OS draws the window buttons (traffic lights, or `titleBarOverlay`
      // on Windows/Linux), so the renderer never renders its own.
      expect(['darwin', 'win32', 'linux']).toContain(platform);
      await expect(layout.windowControlButton('Minimize')).toHaveCount(0);
      await expect(layout.windowControlButton('Maximize')).toHaveCount(0);
      await expect(layout.windowControlButton('Close')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
