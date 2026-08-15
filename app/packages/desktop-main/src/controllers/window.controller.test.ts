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
