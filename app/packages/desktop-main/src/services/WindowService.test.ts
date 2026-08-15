import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WindowService } from './WindowService.js';
import type { BrowserWindow } from 'electron';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a minimal BrowserWindow stub with the methods/events WindowService touches. */
function makeWin(): Partial<BrowserWindow> & { __fire: (event: string) => void } {
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
  } as Partial<BrowserWindow> & { __fire: (event: string) => void };
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
      const win = makeWin();
      service.attach(win as BrowserWindow);
      win.__fire('maximize');
      expect(win.webContents.send).toHaveBeenCalledWith('window.maximizedChange', true);
    });

    it('should push window.maximizedChange with false when the window fires its native unmaximize event', () => {
      const win = makeWin();
      service.attach(win as BrowserWindow);
      win.__fire('unmaximize');
      expect(win.webContents.send).toHaveBeenCalledWith('window.maximizedChange', false);
    });
  });
});
