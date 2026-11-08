/**
 * Drives a streaming channel end to end through the real preload bridge (`preload.ts` and `stream-bridge.ts`) and the
 * real `LogsController`/`registerSelfBridgedHandlers` with no `__test.mock` registered. An in-process IPC bus stands
 * in for Electron: it structured-clones every payload and reply, and it delivers the invoke reply and the
 * `webContents.send` pushes over separate paths with no ordering guarantee between them. The reply is held back
 * behind every push (the adversarial order), so a protocol that depends on the reply arriving first loses events
 * and fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogsService } from './services/LogsService.js';
import { LogsController } from './controllers/logs.controller.js';

const bus = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return {
    handlers: new Map<string, (evt: unknown, payload: unknown) => Promise<unknown>>(),
    mainEmitter: new EventEmitter(),
    rendererEmitter: new EventEmitter(),
    exposed: {} as Record<string, unknown>,
    /** Macrotask delay applied to every invoke reply; pushes are delivered on the very next macrotask. */
    replyDelayMs: 25,
  };
});

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => {
  const sender = {
    isDestroyed: () => false,
    send: (channel: string, data: unknown) => {
      const delivered = structuredClone(data);
      setImmediate(() => bus.rendererEmitter.emit(channel, {}, delivered));
    },
  };
  return {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => void (bus.exposed[name] = api) },
    webUtils: { getPathForFile: vi.fn() },
    ipcMain: {
      handle: (channel: string, fn: (evt: unknown, payload: unknown) => Promise<unknown>) => bus.handlers.set(channel, fn),
      removeHandler: (channel: string) => bus.handlers.delete(channel),
      once: (channel: string, fn: () => void) => bus.mainEmitter.once(channel, fn),
      removeAllListeners: (channel: string) => bus.mainEmitter.removeAllListeners(channel),
    },
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => {
        const handler = bus.handlers.get(channel);
        if (!handler) return Promise.reject(new Error(`No handler registered for '${channel}'`));
        return new Promise((resolve, reject) => {
          handler({ sender }, structuredClone(args[0])).then(
            (value) => {
              const reply = structuredClone(value);
              setTimeout(() => resolve(reply), bus.replyDelayMs);
            },
            (err: unknown) => setTimeout(() => reject(err), bus.replyDelayMs),
          );
        });
      },
      send: (channel: string, ...args: unknown[]) => void setImmediate(() => bus.mainEmitter.emit(channel, {}, ...args)),
      on: (channel: string, fn: (...a: unknown[]) => void) => bus.rendererEmitter.on(channel, fn),
      once: (channel: string, fn: (...a: unknown[]) => void) => bus.rendererEmitter.once(channel, fn),
      removeListener: (channel: string, fn: (...a: unknown[]) => void) => bus.rendererEmitter.removeListener(channel, fn),
    },
    IpcRendererEvent: {},
  };
});

interface LogsBridge {
  logs: { stream: (game: string) => AsyncIterable<string> & { cancel: () => void } };
}

/** Collects every value a stream handle yields, rejecting with the error it throws or after 1.5s of silence (a hung stream). */
async function drain(handle: AsyncIterable<string> & { cancel: () => void }): Promise<string[]> {
  const out: string[] = [];
  const consume = (async () => {
    for await (const line of handle) out.push(line);
    return out;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      handle.cancel();
      reject(new Error(`stream hung after ${out.length} chunk(s)`));
    }, 1500);
  });
  try {
    return await Promise.race([consume, hung]);
  } finally {
    clearTimeout(timer);
  }
}

// @spec APP-IPC-STREAM-011
describe('logs.stream through the real preload bridge and LogsController', () => {
  const realElectronVersion = process.versions.electron;
  const realTestMode = process.env.HYVEON_TEST_MODE;
  let streamLogs: ReturnType<typeof vi.fn<LogsService['streamLogs']>>;

  beforeEach(async () => {
    Object.defineProperty(process.versions, 'electron', { value: '30.0.0', configurable: true });
    delete process.env.HYVEON_TEST_MODE;
    bus.handlers.clear();
    streamLogs = vi.fn<LogsService['streamLogs']>();
    const logsService: Partial<LogsService> = { streamLogs };
    await new LogsController(logsService as LogsService).onModuleInit();
    await import('../../desktop-preload/src/preload.js');
  });

  afterEach(() => {
    if (realTestMode === undefined) delete process.env.HYVEON_TEST_MODE;
    else process.env.HYVEON_TEST_MODE = realTestMode;
    if (realElectronVersion === undefined) delete (process.versions as { electron?: string }).electron;
    else Object.defineProperty(process.versions, 'electron', { value: realElectronVersion, configurable: true });
  });

  const bridge = () => bus.exposed['hyveon'] as LogsBridge;

  it('should deliver every chunk the main process emits and end cleanly', async () => {
    streamLogs.mockImplementation(async function* () {
      yield 'line one';
      yield 'line two';
    });

    await expect(drain(bridge().logs.stream('minecraft'))).resolves.toEqual(['line one', 'line two']);
  });

  // @spec APP-IPC-STREAM-013, APP-IPC-ERR-007
  it('should surface an immediate source failure with the handler message and no "Error: " prefix', async () => {
    streamLogs.mockImplementation(async function* (): AsyncGenerator<string> {
      await Promise.reject(new Error('no such log group'));
      yield 'unreachable';
    });

    await expect(drain(bridge().logs.stream('minecraft'))).rejects.toThrow(/^no such log group$/);
  });

  // @spec APP-IPC-STREAM-008
  it('should abort the main-side source and end without error when the renderer cancels', async () => {
    let sourceSignal: AbortSignal | undefined;
    streamLogs.mockImplementation(async function* (_game: string, signal: AbortSignal) {
      sourceSignal = signal;
      yield 'first';
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });

    const handle = bridge().logs.stream('minecraft');
    const seen: string[] = [];
    for await (const line of handle) {
      seen.push(line);
      handle.cancel();
    }

    expect(seen).toEqual(['first']);
    expect(sourceSignal?.aborted).toBe(true);
  });

  // @spec APP-IPC-STREAM-008, APP-IPC-STREAM-010
  it('should abort the main-side source and drop the renderer listeners when the consumer breaks out of for-await', async () => {
    let sourceSignal: AbortSignal | undefined;
    streamLogs.mockImplementation(async function* (_game: string, signal: AbortSignal) {
      sourceSignal = signal;
      yield 'first';
      yield 'second';
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });

    for await (const line of bridge().logs.stream('minecraft')) {
      expect(line).toBe('first');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sourceSignal?.aborted).toBe(true);
    expect(bus.rendererEmitter.eventNames().filter((name) => String(name).startsWith('logs.stream.'))).toEqual([]);
  });
});
