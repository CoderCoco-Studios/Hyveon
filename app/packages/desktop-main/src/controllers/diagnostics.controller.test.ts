import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { DiagnosticsController } from './diagnostics.controller.js';
import type { DiagnosticsService } from '../services/DiagnosticsService.js';
import type { DiagnosticsBundleService } from '../services/DiagnosticsBundleService.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a DiagnosticsService stub. */
function makeDiagnostics(): DiagnosticsService {
  return {
    readTail: vi.fn().mockResolvedValue(['line1', 'line2', 'line3']),
    getTodayLogPath: vi.fn().mockReturnValue('/var/log/app/main-2026-05-23.log'),
    logRendererError: vi.fn(),
    logRendererConsoleBatch: vi.fn(),
  } as unknown as DiagnosticsService;
}

/** Build a DiagnosticsBundleService stub. */
function makeBundle(): DiagnosticsBundleService {
  return {
    writeBundle: vi.fn().mockResolvedValue({ path: '/tmp/hyveon-diagnostics.zip' }),
  } as Partial<DiagnosticsBundleService> as DiagnosticsBundleService;
}

/** Widens `DiagnosticsController`'s protected test seams to public so specs can stub them without casts. */
class TestableDiagnosticsController extends DiagnosticsController {
  public override showSaveDialog(): Promise<string | undefined> {
    return super.showSaveDialog();
  }

  public override revealInFolder(path: string): void {
    return super.revealInFolder(path);
  }
}

describe('DiagnosticsController', () => {
  describe('getTail', () => {
    it('should return lines from DiagnosticsService', async () => {
      const svc = makeDiagnostics();
      const result = await new DiagnosticsController(svc, makeBundle()).getTail();
      expect(result).toEqual({ lines: ['line1', 'line2', 'line3'] });
    });

    it('should call DiagnosticsService.readTail with 500 lines', async () => {
      const svc = makeDiagnostics();
      await new DiagnosticsController(svc, makeBundle()).getTail();
      expect(svc.readTail).toHaveBeenCalledWith(500);
    });
  });

  describe('getPath', () => {
    it('should return the current log path from DiagnosticsService', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsController(svc, makeBundle()).getPath();
      expect(result).toEqual({ path: '/var/log/app/main-2026-05-23.log' });
    });

    it('should delegate to DiagnosticsService.getTodayLogPath', () => {
      const svc = makeDiagnostics();
      new DiagnosticsController(svc, makeBundle()).getPath();
      expect(svc.getTodayLogPath).toHaveBeenCalled();
    });
  });

  describe('reportError', () => {
    it('should call DiagnosticsService.logRendererError with the payload fields', () => {
      const svc = makeDiagnostics();
      new DiagnosticsController(svc, makeBundle()).reportError({
        message: 'boom',
        stack: 'Error: boom\n  at x',
        source: 'boundary',
      });

      expect(svc.logRendererError).toHaveBeenCalledWith('boom', 'Error: boom\n  at x', 'boundary');
    });

    it('should pass through an undefined stack unchanged', () => {
      const svc = makeDiagnostics();
      new DiagnosticsController(svc, makeBundle()).reportError({
        message: 'unhandled rejection',
        source: 'unhandled-rejection',
      });

      expect(svc.logRendererError).toHaveBeenCalledWith('unhandled rejection', undefined, 'unhandled-rejection');
    });

    it('should return undefined', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsController(svc, makeBundle()).reportError({
        message: 'boom',
        source: 'window-error',
      });

      expect(result).toBeUndefined();
    });
  });

  describe('reportLog', () => {
    it('should call DiagnosticsService.logRendererConsoleBatch with the entries and dropped count', () => {
      const svc = makeDiagnostics();
      const entries = [
        { level: 'log' as const, message: 'first' },
        { level: 'warn' as const, message: 'second' },
      ];

      new DiagnosticsController(svc, makeBundle()).reportLog({ entries, droppedCount: 3 });

      expect(svc.logRendererConsoleBatch).toHaveBeenCalledWith(entries, 3);
    });

    it('should pass through an undefined droppedCount unchanged', () => {
      const svc = makeDiagnostics();
      const entries = [{ level: 'info' as const, message: 'hello' }];

      new DiagnosticsController(svc, makeBundle()).reportLog({ entries });

      expect(svc.logRendererConsoleBatch).toHaveBeenCalledWith(entries, undefined);
    });

    it('should return undefined', () => {
      const svc = makeDiagnostics();
      const result = new DiagnosticsController(svc, makeBundle()).reportLog({ entries: [] });

      expect(result).toBeUndefined();
    });
  });

  describe('exportBundle', () => {
    it('should write the bundle and return the written path when the operator picks a save location', async () => {
      const bundle = makeBundle();
      const controller = new TestableDiagnosticsController(makeDiagnostics(), bundle);
      vi.spyOn(controller, 'showSaveDialog').mockResolvedValue('/tmp/hyveon-diagnostics.zip');

      const result = await controller.exportBundle();

      expect(bundle.writeBundle).toHaveBeenCalledWith('/tmp/hyveon-diagnostics.zip');
      expect(result).toEqual({ status: 'written', path: '/tmp/hyveon-diagnostics.zip' });
    });

    it('should return a cancelled result without calling writeBundle when the operator cancels the dialog', async () => {
      const bundle = makeBundle();
      const controller = new TestableDiagnosticsController(makeDiagnostics(), bundle);
      vi.spyOn(controller, 'showSaveDialog').mockResolvedValue(undefined);

      const result = await controller.exportBundle();

      expect(bundle.writeBundle).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'cancelled' });
    });

    it('should return an error result with a message, not a thrown error, when writeBundle rejects', async () => {
      const bundle = makeBundle();
      vi.mocked(bundle.writeBundle).mockRejectedValue(new Error('disk full'));
      const controller = new TestableDiagnosticsController(makeDiagnostics(), bundle);
      vi.spyOn(controller, 'showSaveDialog').mockResolvedValue('/tmp/hyveon-diagnostics.zip');

      const result = await controller.exportBundle();

      expect(result).toEqual({ status: 'error', message: 'disk full' });
    });
  });

  describe('showInFolder', () => {
    it('should delegate to revealInFolder with the given path', () => {
      const controller = new TestableDiagnosticsController(makeDiagnostics(), makeBundle());
      const spy = vi.spyOn(controller, 'revealInFolder').mockImplementation(() => {});

      controller.showInFolder({ path: '/tmp/hyveon-diagnostics.zip' });

      expect(spy).toHaveBeenCalledWith('/tmp/hyveon-diagnostics.zip');
    });

    it('should never throw when revealInFolder fails', () => {
      const controller = new TestableDiagnosticsController(makeDiagnostics(), makeBundle());
      vi.spyOn(controller, 'revealInFolder').mockImplementation(() => {
        throw new Error('no file manager available');
      });

      expect(() => controller.showInFolder({ path: '/tmp/hyveon-diagnostics.zip' })).not.toThrow();
    });
  });
});
