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
    // macOS re-creates the window on 'activate' when the dock icon is clicked
    // with zero windows open (electron-entry.ts); without this listener, this
    // service would keep holding a reference to the destroyed window until the
    // next attach() call overwrites it, silently no-oping every IPC call in the
    // meantime (see every method's `if (!this.win) return` guard above).
    //
    // The `this.win === win` identity check guards against a (currently
    // unreachable, since Electron fires 'closed' before 'activate') ordering
    // where attach(B) runs before window A's 'closed' listener fires — without
    // it, A's stale listener would null out the reference to the already-live
    // window B.
    win.once('closed', () => {
      if (this.win === win) this.win = null;
    });
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
   * Queries the attached window's current maximized state.
   *
   * @returns The attached window's current maximized state, or `false` if no
   *   window is attached or if querying the window state fails.
   */
  isMaximized(): boolean {
    if (!this.win) return false;
    try {
      return this.win.isMaximized();
    } catch (err) {
      logger.warn(`WindowService: isMaximized failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
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
