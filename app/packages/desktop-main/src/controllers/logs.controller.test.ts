import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogsController } from './logs.controller.js';
import type { LogsService } from '../services/LogsService.js';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before any vi.mock() factory runs.
// ---------------------------------------------------------------------------

/**
 * Captures every listener registered via `ipcMain.handle` or `ipcMain.once`
 * so tests can assert on routing registration and fire cancel callbacks
 * synchronously.
 *
 * `mockIpcMainHandle` captures the `ipcMain.handle('logs.stream', ...)` call
 * made by `onModuleInit()`. Without it, calling `onModuleInit` in a test
 * environment (where the real Electron `ipcMain` is absent) would throw.
 */
const {
  mockIpcMainHandle,
  mockIpcMainOnce,
  mockIpcMainRemoveAllListeners,
  mockIpcMainRemoveHandler,
} = vi.hoisted(() => {
  const mockIpcMainHandle = vi.fn();
  const mockIpcMainOnce = vi.fn();
  const mockIpcMainRemoveAllListeners = vi.fn();
  const mockIpcMainRemoveHandler = vi.fn();
  return { mockIpcMainHandle, mockIpcMainOnce, mockIpcMainRemoveAllListeners, mockIpcMainRemoveHandler };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockIpcMainHandle,
    once: mockIpcMainOnce,
    removeAllListeners: mockIpcMainRemoveAllListeners,
    removeHandler: mockIpcMainRemoveHandler,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a LogsService stub with default no-op implementations. */
function makeLogs(): LogsService {
  return {
    getRecentLogs: vi.fn().mockResolvedValue({ lines: ['line1', 'line2'], oldestTimestamp: 100 }),
    streamLogs: vi.fn().mockImplementation(async function* () { /* empty */ }),
    getRecentLambdaLogs: vi.fn().mockResolvedValue({ lines: ['lambda-line1'], oldestTimestamp: 100 }),
    streamLambdaLogs: vi.fn().mockImplementation(async function* () { /* empty */ }),
    getOlderLogs: vi.fn().mockResolvedValue({ lines: ['older1'], oldestTimestamp: 500, atOldest: false }),
    getNewerLogs: vi.fn().mockResolvedValue({ lines: ['newer1'], newestTimestamp: 1500, hasMore: false }),
    getOlderLambdaLogs: vi.fn().mockResolvedValue({ lines: ['lambda-older1'], oldestTimestamp: 500, atOldest: false }),
    getNewerLambdaLogs: vi.fn().mockResolvedValue({ lines: ['lambda-newer1'], newestTimestamp: 1500, hasMore: false }),
  } as unknown as LogsService;
}

/**
 * Build a minimal `IpcMainInvokeEvent` stub with a controlled `sender`
 * (WebContents). Tests can inspect calls on `sender.send` and control the
 * return value of `sender.isDestroyed()`.
 */
function makeCtx(isDestroyed = false) {
  const sender = {
    send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(isDestroyed),
  };
  return {
    ctx: { evt: { sender } } as unknown as { evt: { sender: typeof sender } },
    sender,
  };
}

/** Flush the microtask queue so async fire-and-forget loops fully settle. */
function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value guards against typos in the
 * channel name that would silently break IPC routing.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('LogsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // @MessagePattern channel name registration
  // -------------------------------------------------------------------------

  describe('@MessagePattern channel names', () => {
    it('should register getRecentLogs on the "logs.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getRecentLogs);
      expect(pattern).toEqual(['logs.get']);
    });

    it('should register streamLogs on the "logs.stream" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.streamLogs);
      expect(pattern).toEqual(['logs.stream']);
    });

    it('should register getRecentLambdaLogs on the "logs.lambda.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getRecentLambdaLogs);
      expect(pattern).toEqual(['logs.lambda.get']);
    });

    it('should register streamLambdaLogs on the "logs.lambda.stream" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.streamLambdaLogs);
      expect(pattern).toEqual(['logs.lambda.stream']);
    });

    it('should register getOlderLogs on the "logs.getOlder" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getOlderLogs);
      expect(pattern).toEqual(['logs.getOlder']);
    });

    it('should register getNewerLogs on the "logs.getNewer" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getNewerLogs);
      expect(pattern).toEqual(['logs.getNewer']);
    });

    it('should register getOlderLambdaLogs on the "logs.lambda.getOlder" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getOlderLambdaLogs);
      expect(pattern).toEqual(['logs.lambda.getOlder']);
    });

    it('should register getNewerLambdaLogs on the "logs.lambda.getNewer" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getNewerLambdaLogs);
      expect(pattern).toEqual(['logs.lambda.getNewer']);
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit — ipcMain.handle bridge for logs.stream
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    // onModuleInit only wires the bridge when running inside a real Electron
    // main process, detected via `process.versions.electron`. Vitest runs under
    // plain Node where it's undefined, so fake it for the "is Electron" cases
    // and restore afterwards.
    const realElectronVersion = process.versions.electron;
    const setElectron = (value: string | undefined): void => {
      if (value === undefined) {
        delete (process.versions as { electron?: string }).electron;
      } else {
        Object.defineProperty(process.versions, 'electron', { value, configurable: true });
      }
    };
    beforeEach(() => setElectron('30.0.0'));
    afterEach(() => setElectron(realElectronVersion));

    it('should skip the ipcMain bridge when not running inside an Electron main process', async () => {
      // Plain-Node runtimes (integration test server, Docker, CI) have no
      // `process.versions.electron`; importing electron there would throw, so
      // the bridge must be skipped without touching ipcMain at all.
      setElectron(undefined);
      await new LogsController(makeLogs()).onModuleInit();
      expect(mockIpcMainHandle).not.toHaveBeenCalled();
      expect(mockIpcMainRemoveHandler).not.toHaveBeenCalled();
    });

    it('should register ipcMain.handle for "logs.stream" so ipcRenderer.invoke can resolve', async () => {
      // onModuleInit bridges the gap between @MessagePattern (transport-internal
      // dispatch only) and ipcMain.handle (required by ipcRenderer.invoke). Without
      // this registration, invoke hangs indefinitely and { streamId } is never
      // destructured in the preload.
      await new LogsController(makeLogs()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('logs.stream', expect.any(Function));
    });

    it('should remove any existing "logs.stream" handler before registering so hot-reload re-bootstrap does not throw', async () => {
      // A second bootstrap (hot-reload / dev restart) would otherwise hit
      // "Attempted to register a second handler for 'logs.stream'". Clearing the
      // handler first keeps re-registration idempotent.
      await new LogsController(makeLogs()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('logs.stream');
      expect(mockIpcMainRemoveHandler.mock.invocationCallOrder[0]).toBeLessThan(
        mockIpcMainHandle.mock.invocationCallOrder[0],
      );
    });

    it('should register ipcMain.handle for "logs.lambda.stream" so ipcRenderer.invoke can resolve', async () => {
      await new LogsController(makeLogs()).onModuleInit();
      expect(mockIpcMainHandle).toHaveBeenCalledWith('logs.lambda.stream', expect.any(Function));
    });

    it('should remove any existing "logs.lambda.stream" handler before registering', async () => {
      await new LogsController(makeLogs()).onModuleInit();
      expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('logs.lambda.stream');
    });
  });

  // -------------------------------------------------------------------------
  // getRecentLogs
  // -------------------------------------------------------------------------

  describe('getRecentLogs', () => {
    it('should return the game name, log lines, and oldestTimestamp from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getRecentLogs({ game: 'minecraft' });
      expect(result).toEqual({ game: 'minecraft', lines: ['line1', 'line2'], oldestTimestamp: 100 });
    });

    it('should default to 50 log lines when no limit is provided in the payload', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getRecentLogs({ game: 'palworld' });
      expect(logs.getRecentLogs).toHaveBeenCalledWith('palworld', 50);
    });

    it('should forward the explicit limit from the payload to LogsService', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getRecentLogs({ game: 'minecraft', limit: 100 });
      expect(logs.getRecentLogs).toHaveBeenCalledWith('minecraft', 100);
    });
  });

  // -------------------------------------------------------------------------
  // getOlderLogs
  // -------------------------------------------------------------------------

  describe('getOlderLogs', () => {
    it('should log an entry line naming the game before invoking', async () => {
      const { logger } = await import('../logger.js');
      await new LogsController(makeLogs()).getOlderLogs({ game: 'minecraft', beforeTimestamp: 1000 });
      expect(logger.debug).toHaveBeenCalledWith('LogsController: logs.getOlder invoked', { game: 'minecraft' });
    });

    it('should return the game name and the older page from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getOlderLogs({ game: 'minecraft', beforeTimestamp: 1000 });
      expect(result).toEqual({ game: 'minecraft', lines: ['older1'], oldestTimestamp: 500, atOldest: false });
    });

    it('should default the limit to 100 when omitted', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getOlderLogs({ game: 'minecraft', beforeTimestamp: 1000 });
      expect(logs.getOlderLogs).toHaveBeenCalledWith('minecraft', 1000, 100);
    });

    it('should forward an explicit limit from the payload', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getOlderLogs({ game: 'minecraft', beforeTimestamp: 1000, limit: 25 });
      expect(logs.getOlderLogs).toHaveBeenCalledWith('minecraft', 1000, 25);
    });

    it('should normalize a thrown LogsService error to a plain Error', async () => {
      const logs = makeLogs();
      vi.mocked(logs.getOlderLogs).mockRejectedValue(new Error('denied'));
      await expect(
        new LogsController(logs).getOlderLogs({ game: 'minecraft', beforeTimestamp: 1000 }),
      ).rejects.toThrow('denied');
    });
  });

  // -------------------------------------------------------------------------
  // getNewerLogs
  // -------------------------------------------------------------------------

  describe('getNewerLogs', () => {
    it('should log an entry line naming the game before invoking', async () => {
      const { logger } = await import('../logger.js');
      await new LogsController(makeLogs()).getNewerLogs({ game: 'minecraft', afterTimestamp: 1000 });
      expect(logger.debug).toHaveBeenCalledWith('LogsController: logs.getNewer invoked', { game: 'minecraft' });
    });

    it('should return the game name and the newer page from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getNewerLogs({ game: 'minecraft', afterTimestamp: 1000 });
      expect(result).toEqual({ game: 'minecraft', lines: ['newer1'], newestTimestamp: 1500, hasMore: false });
    });

    it('should default the limit to 100 when omitted', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getNewerLogs({ game: 'minecraft', afterTimestamp: 1000 });
      expect(logs.getNewerLogs).toHaveBeenCalledWith('minecraft', 1000, 100);
    });

    it('should forward an explicit limit and afterTimestamp to LogsService.getNewerLogs', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getNewerLogs({ game: 'minecraft', afterTimestamp: 50, limit: 25 });
      expect(logs.getNewerLogs).toHaveBeenCalledWith('minecraft', 50, 25);
    });

    it('should normalize a thrown LogsService error to a plain Error', async () => {
      const logs = makeLogs();
      vi.mocked(logs.getNewerLogs).mockRejectedValue(new Error('throttled'));
      await expect(
        new LogsController(logs).getNewerLogs({ game: 'minecraft', afterTimestamp: 1000 }),
      ).rejects.toThrow('throttled');
    });
  });

  // -------------------------------------------------------------------------
  // streamLogs
  // -------------------------------------------------------------------------

  describe('streamLogs', () => {
    it('should return a non-empty streamId string immediately', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      const result = await new LogsController(logs).streamLogs('minecraft', ctx);

      expect(result).toHaveProperty('streamId');
      expect(typeof result.streamId).toBe('string');
      expect(result.streamId.length).toBeGreaterThan(0);
    });

    it('should register a cancel listener on the per-stream cancel channel', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);

      expect(mockIpcMainOnce).toHaveBeenCalledWith(
        `logs.stream.${streamId}.cancel`,
        expect.any(Function),
      );
    });

    it('should send each log line as a chunk to the renderer via sender.send', async () => {
      async function* twoLines() {
        yield 'hello';
        yield 'world';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(twoLines);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.chunk`, 'hello');
      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.chunk`, 'world');
    });

    it('should send an end message with no error when the generator is exhausted', async () => {
      async function* empty() { /* no lines */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(empty);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.end`, {});
    });

    it('should send an end message with no error when the stream is cancelled (AbortError)', async () => {
      async function* throwsAbort(): AsyncGenerator<string> {
        yield 'partial';
        throw new DOMException('Aborted', 'AbortError');
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(throwsAbort);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.stream.${streamId}.end`, {});
      // The error field must NOT be present on an AbortError end message.
      const endCall = sender.send.mock.calls.find(([ch]) => ch === `logs.stream.${streamId}.end`);
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with an error string when the generator throws a non-abort error', async () => {
      async function* throwsNonAbort(): AsyncGenerator<string> {
        yield 'partial';
        throw new Error('CloudWatch throttled');
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(throwsNonAbort);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([ch]) => ch === `logs.stream.${streamId}.end`);
      expect(endCall?.[1]).toHaveProperty('error');
      expect(String(endCall?.[1]?.error)).toContain('CloudWatch throttled');
    });

    it('should create its own AbortController and pass the signal to LogsService.streamLogs', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      // The signal passed to streamLogs must be an AbortSignal created by the controller.
      expect(logs.streamLogs).toHaveBeenCalledWith('minecraft', expect.any(AbortSignal));
    });

    it('should abort the stream when the cancel IPC listener is invoked', async () => {
      // Make streamLogs block until signalled so we can inspect the abort state.
      let capturedSignal: AbortSignal | null = null;
      async function* waitForAbort(
        _game: string,
        signal: AbortSignal,
      ): AsyncGenerator<string> {
        capturedSignal = signal;
        // Yield one line then wait indefinitely so the cancel path is exercised.
        yield 'first';
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(waitForAbort);
      const { ctx } = makeCtx();

      await new LogsController(logs).streamLogs('minecraft', ctx);

      // Retrieve the cancel handler registered via ipcMain.once and invoke it.
      const [, cancelHandler] = mockIpcMainOnce.mock.calls[0] as [string, () => void];
      cancelHandler();

      await flushPromises();

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('should remove the cancel listener after the stream ends naturally', async () => {
      async function* empty() { /* terminates immediately */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(empty);
      const { ctx } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(mockIpcMainRemoveAllListeners).toHaveBeenCalledWith(`logs.stream.${streamId}.cancel`);
    });

    it('should not send to a destroyed WebContents', async () => {
      async function* oneLine() { yield 'line'; }
      const logs = makeLogs();
      vi.mocked(logs.streamLogs).mockImplementation(oneLine);
      // Simulate WebContents already destroyed before the loop runs.
      const { ctx, sender } = makeCtx(true);

      await new LogsController(logs).streamLogs('minecraft', ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getRecentLambdaLogs
  // -------------------------------------------------------------------------

  describe('getRecentLambdaLogs', () => {
    it('should return the functionKey, log lines, and oldestTimestamp from LogsService.getRecentLambdaLogs', async () => {
      const result = await new LogsController(makeLogs()).getRecentLambdaLogs({ functionKey: 'watchdog' });
      expect(result).toEqual({ functionKey: 'watchdog', lines: ['lambda-line1'], oldestTimestamp: 100 });
    });

    it('should default to 50 log lines when no limit is provided in the payload', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getRecentLambdaLogs({ functionKey: 'followup' });
      expect(logs.getRecentLambdaLogs).toHaveBeenCalledWith('followup', 50);
    });
  });

  // -------------------------------------------------------------------------
  // getOlderLambdaLogs
  // -------------------------------------------------------------------------

  describe('getOlderLambdaLogs', () => {
    it('should log an entry line naming the functionKey before invoking', async () => {
      const { logger } = await import('../logger.js');
      await new LogsController(makeLogs()).getOlderLambdaLogs({ functionKey: 'watchdog', beforeTimestamp: 1000 });
      expect(logger.debug).toHaveBeenCalledWith('LogsController: logs.lambda.getOlder invoked', { functionKey: 'watchdog' });
    });

    it('should return the functionKey and the older page from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getOlderLambdaLogs({ functionKey: 'watchdog', beforeTimestamp: 1000 });
      expect(result).toEqual({ functionKey: 'watchdog', lines: ['lambda-older1'], oldestTimestamp: 500, atOldest: false });
    });

    it('should default the limit to 100 when omitted', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getOlderLambdaLogs({ functionKey: 'followup', beforeTimestamp: 1000 });
      expect(logs.getOlderLambdaLogs).toHaveBeenCalledWith('followup', 1000, 100);
    });

    it('should normalize a thrown LogsService error to a plain Error', async () => {
      const logs = makeLogs();
      vi.mocked(logs.getOlderLambdaLogs).mockRejectedValue(new Error('no log group'));
      await expect(
        new LogsController(logs).getOlderLambdaLogs({ functionKey: 'watchdog', beforeTimestamp: 1000 }),
      ).rejects.toThrow('no log group');
    });
  });

  // -------------------------------------------------------------------------
  // getNewerLambdaLogs
  // -------------------------------------------------------------------------

  describe('getNewerLambdaLogs', () => {
    it('should log an entry line naming the functionKey before invoking', async () => {
      const { logger } = await import('../logger.js');
      await new LogsController(makeLogs()).getNewerLambdaLogs({ functionKey: 'watchdog', afterTimestamp: 1000 });
      expect(logger.debug).toHaveBeenCalledWith('LogsController: logs.lambda.getNewer invoked', { functionKey: 'watchdog' });
    });

    it('should return the functionKey and the newer page from LogsService', async () => {
      const result = await new LogsController(makeLogs()).getNewerLambdaLogs({ functionKey: 'watchdog', afterTimestamp: 1000 });
      expect(result).toEqual({ functionKey: 'watchdog', lines: ['lambda-newer1'], newestTimestamp: 1500, hasMore: false });
    });

    it('should forward afterTimestamp and limit to LogsService.getNewerLambdaLogs', async () => {
      const logs = makeLogs();
      await new LogsController(logs).getNewerLambdaLogs({ functionKey: 'watchdog', afterTimestamp: 50, limit: 25 });
      expect(logs.getNewerLambdaLogs).toHaveBeenCalledWith('watchdog', 50, 25);
    });

    it('should normalize a thrown LogsService error to a plain Error', async () => {
      const logs = makeLogs();
      vi.mocked(logs.getNewerLambdaLogs).mockRejectedValue(new Error('no log group'));
      await expect(
        new LogsController(logs).getNewerLambdaLogs({ functionKey: 'watchdog', afterTimestamp: 1000 }),
      ).rejects.toThrow('no log group');
    });
  });

  // -------------------------------------------------------------------------
  // streamLambdaLogs
  // -------------------------------------------------------------------------

  describe('streamLambdaLogs', () => {
    it('should return a non-empty streamId string immediately', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      const result = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);

      expect(result).toHaveProperty('streamId');
      expect(typeof result.streamId).toBe('string');
      expect(result.streamId.length).toBeGreaterThan(0);
    });

    it('should register a cancel listener on the per-stream cancel channel', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);

      expect(mockIpcMainOnce).toHaveBeenCalledWith(
        `logs.lambda.stream.${streamId}.cancel`,
        expect.any(Function),
      );
    });

    it('should send each log line as a chunk to the renderer via sender.send', async () => {
      async function* twoLines() {
        yield 'hello';
        yield 'world';
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(twoLines);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.lambda.stream.${streamId}.chunk`, 'hello');
      expect(sender.send).toHaveBeenCalledWith(`logs.lambda.stream.${streamId}.chunk`, 'world');
    });

    it('should send an end message with no error when the generator is exhausted', async () => {
      async function* empty() { /* no lines */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(empty);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.lambda.stream.${streamId}.end`, {});
    });

    it('should send an end message with no error when the stream is cancelled (AbortError)', async () => {
      async function* throwsAbort(): AsyncGenerator<string> {
        yield 'partial';
        throw new DOMException('Aborted', 'AbortError');
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(throwsAbort);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      expect(sender.send).toHaveBeenCalledWith(`logs.lambda.stream.${streamId}.end`, {});
      // The error field must NOT be present on an AbortError end message.
      const endCall = sender.send.mock.calls.find(([ch]) => ch === `logs.lambda.stream.${streamId}.end`);
      expect(endCall?.[1]).not.toHaveProperty('error');
    });

    it('should send an end message with an error string when the generator throws a non-abort error', async () => {
      async function* throwsNonAbort(): AsyncGenerator<string> {
        yield 'partial';
        throw new Error('CloudWatch throttled');
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(throwsNonAbort);
      const { ctx, sender } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      const endCall = sender.send.mock.calls.find(([ch]) => ch === `logs.lambda.stream.${streamId}.end`);
      expect(endCall?.[1]).toHaveProperty('error');
      expect(String(endCall?.[1]?.error)).toContain('CloudWatch throttled');
    });

    it('should create its own AbortController and pass the signal to LogsService.streamLambdaLogs', async () => {
      const logs = makeLogs();
      const { ctx } = makeCtx();

      await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      expect(logs.streamLambdaLogs).toHaveBeenCalledWith('watchdog', expect.any(AbortSignal));
    });

    it('should abort the stream when the cancel IPC listener is invoked', async () => {
      let capturedSignal: AbortSignal | null = null;
      async function* waitForAbort(
        _functionKey: string,
        signal: AbortSignal,
      ): AsyncGenerator<string> {
        capturedSignal = signal;
        yield 'first';
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(waitForAbort);
      const { ctx } = makeCtx();

      await new LogsController(logs).streamLambdaLogs('watchdog', ctx);

      const [, cancelHandler] = mockIpcMainOnce.mock.calls[0] as [string, () => void];
      cancelHandler();

      await flushPromises();

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('should remove the cancel listener after the stream ends naturally', async () => {
      async function* empty() { /* terminates immediately */ }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(empty);
      const { ctx } = makeCtx();

      const { streamId } = await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      expect(mockIpcMainRemoveAllListeners).toHaveBeenCalledWith(`logs.lambda.stream.${streamId}.cancel`);
    });

    it('should not send to a destroyed WebContents', async () => {
      async function* oneLine() { yield 'line'; }
      const logs = makeLogs();
      vi.mocked(logs.streamLambdaLogs).mockImplementation(oneLine);
      const { ctx, sender } = makeCtx(true);

      await new LogsController(logs).streamLambdaLogs('watchdog', ctx);
      await flushPromises();

      expect(sender.send).not.toHaveBeenCalled();
    });
  });
});
