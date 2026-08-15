import { test, expect, _electron } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';
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
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      expect(win).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test('should expose window.hyveon from the preload script', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const hyveon = await win.evaluate(() => typeof (window as unknown as Record<string, unknown>)['hyveon']);
      expect(hyveon).toBe('object');
    } finally {
      await app.close();
    }
  });

  /**
   * Exercises the custom title bar (add-custom-title-bar) against the real
   * preload bridge — earlier coverage only asserted `window.hyveon` exists,
   * not that the header is actually a drag region or that Linux's app-drawn
   * window-control buttons render and are clickable.
   *
   * The drag-region assertion is platform-independent (a CSS property check),
   * but the Minimize/Maximize/Close button assertions only hold where the app
   * draws its own buttons — Linux only (macOS/Windows use native OS chrome
   * instead, see `platformWindowChromeOptions()` in `electron-entry.ts`). CI
   * runs this project on `ubuntu-latest` (`.github/workflows/e2e.yml`), so
   * `process.platform` is reliably `linux` there; this test gates the button
   * assertions on that so it still passes (skipping just the button checks)
   * if ever run locally on macOS/Windows.
   */
  test('should mark the header as a drag region and, on Linux, render clickable window controls', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const layout = new AppLayout(win);

      const appRegion = await layout.header().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
      expect(appRegion).toBe('drag');

      const platform = await win.evaluate(
        () => (window as unknown as { hyveon: { window: { platform: NodeJS.Platform } } }).hyveon.window.platform,
      );

      if (platform === 'linux') {
        const minimizeButton = layout.windowControlButton('Minimize');
        const closeButton = layout.windowControlButton('Close');
        await expect(minimizeButton).toBeVisible();
        await expect(closeButton).toBeVisible();
        await expect(minimizeButton).toBeEnabled();
        await expect(closeButton).toBeEnabled();
      }
    } finally {
      await app.close();
    }
  });
});
