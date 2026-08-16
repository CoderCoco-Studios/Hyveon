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
      const hyveon = await win.evaluate(() => typeof window.hyveon);
      expect(hyveon).toBe('object');
    } finally {
      await app.close();
    }
  });

  /**
   * Exercises the custom title bar (add-custom-title-bar) against the real
   * preload bridge — earlier coverage only asserted `window.hyveon` exists,
   * not that the header is actually a drag region.
   *
   * Every platform (macOS traffic lights, Windows and Linux native
   * `titleBarOverlay`) draws its window controls outside the DOM, so there
   * is no app-drawn control surface left to click through here — see
   * `platformWindowChromeOptions()` in `electron-entry.ts`.
   */
  test('should mark the header as a drag region', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const layout = new AppLayout(win);

      const appRegion = await layout.header().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
      expect(appRegion).toBe('drag');
    } finally {
      await app.close();
    }
  });
});
