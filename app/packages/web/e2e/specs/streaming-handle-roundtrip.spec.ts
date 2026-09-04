import { test, expect, launchElectron } from '../fixtures/index.js';

/**
 * Regression spec for the streaming-IPC contextBridge clone bug: every
 * bridged streaming channel (`logs.stream`, `iac.stack.initialize`,
 * `iac.runs.streamLogs`) used to return a raw `AsyncGenerator` from the
 * preload script. `contextBridge.exposeInMainWorld` structured-clones every
 * value crossing the isolated-world boundary, and an `AsyncGenerator` isn't
 * cloneable — calling any of these three methods from the renderer threw
 * synchronously with `Uncaught Error: An object could not be cloned.` before
 * the generator body ever ran, so no IPC was ever sent and no chunk was ever
 * yielded. Nothing at the Vitest/jsdom tier can catch this: jsdom never
 * touches Electron's real `contextBridge`, so a jsdom-mocked `window.hyveon`
 * happily returns whatever shape a test hands it. Only a real Electron
 * process proves the object that comes back from a bridged call actually
 * survived the clone.
 *
 * `preload.ts` now wraps each internal `async function*` in a
 * `HyveonStreamHandle` — a plain object exposing `next()`, `cancel()`, and
 * `[Symbol.asyncIterator]` — before it ever crosses `exposeInMainWorld`. This
 * spec drives all three channels end-to-end inside a real `_electron.launch()`
 * process and asserts the renderer actually receives working chunks, proving
 * that object crossed the clone boundary intact.
 *
 * Each test seeds its channel's data source via `window.hyveon.__test.mock()`
 * with a plain async-iterable, not a real `async function*` — the mock
 * itself crosses renderer→preload and hits the same clone wall in reverse.
 * What's under test is the real preload's `HyveonStreamHandle` crossing back.
 */
test.describe('streaming IPC handle round-trip (contextBridge clone)', () => {
  test('should stream chunks from window.hyveon.logs.stream() without a clone error', async () => {
    const { app, win } = await launchElectron();

    try {
      const result = await win.evaluate(async () => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
          logs: { stream: (game: string) => AsyncIterable<string> & { cancel: () => void } };
        };

        // Plain-object mock iterable — see the module doc comment for why
        // this isn't a real `async function*`.
        hyveon.__test.mock('logs.stream', () => {
          const queued = ['line-one', 'line-two'];
          let index = 0;
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: () =>
              index < queued.length
                ? Promise.resolve({ done: false, value: queued[index++] })
                : Promise.resolve({ done: true }),
          };
        });

        const handle = hyveon.logs.stream('minecraft');
        const chunks: string[] = [];
        for await (const chunk of handle) {
          chunks.push(chunk);
        }
        return { chunks, hasCancel: typeof handle.cancel === 'function' };
      });

      expect(result.chunks).toEqual(['line-one', 'line-two']);
      expect(result.hasCancel).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('should stream phase events from window.hyveon.iac.stack.initialize() without a clone error', async () => {
    const { app, win } = await launchElectron();

    try {
      const result = await win.evaluate(async () => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
          iac: {
            stack: {
              initialize: () => AsyncIterable<{ phase: string; status: string }> & { cancel: () => void };
            };
          };
        };

        hyveon.__test.mock('iac.stack.initialize', () => {
          const queued = [
            { phase: 'engine', status: 'start' },
            { phase: 'engine', status: 'end' },
          ];
          let index = 0;
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: () =>
              index < queued.length
                ? Promise.resolve({ done: false, value: queued[index++] })
                : Promise.resolve({ done: true }),
          };
        });

        const handle = hyveon.iac.stack.initialize();
        const chunks: { phase: string; status: string }[] = [];
        for await (const chunk of handle) {
          chunks.push(chunk);
        }
        return { chunks, hasCancel: typeof handle.cancel === 'function' };
      });

      expect(result.chunks).toEqual([
        { phase: 'engine', status: 'start' },
        { phase: 'engine', status: 'end' },
      ]);
      expect(result.hasCancel).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('should stream chunks from window.hyveon.iac.runs.streamLogs() without a clone error', async () => {
    const { app, win } = await launchElectron();

    try {
      const result = await win.evaluate(async () => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
          iac: {
            runs: {
              streamLogs: (
                runId: string,
              ) => AsyncIterable<{ stream: string; line: string }> & { cancel: () => void };
            };
          };
        };

        hyveon.__test.mock('iac.runs.logs', () => {
          const queued = [{ stream: 'stdout', line: 'Refreshing state...' }];
          let index = 0;
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: () =>
              index < queued.length
                ? Promise.resolve({ done: false, value: queued[index++] })
                : Promise.resolve({ done: true }),
          };
        });

        const handle = hyveon.iac.runs.streamLogs('run-123');
        const chunks: { stream: string; line: string }[] = [];
        for await (const chunk of handle) {
          chunks.push(chunk);
        }
        return { chunks, hasCancel: typeof handle.cancel === 'function' };
      });

      expect(result.chunks).toEqual([{ stream: 'stdout', line: 'Refreshing state...' }]);
      expect(result.hasCancel).toBe(true);
    } finally {
      await app.close();
    }
  });

  /**
   * `cancel()`'s functional behaviour (aborting the handle's internal
   * `AbortController`) is exercised deterministically in `preload.test.ts`,
   * with no contextBridge crossing involved. This spec instead proves the
   * piece only a real Electron process can prove: that `cancel` is a real,
   * callable function once it has crossed the bridge, and that calling it
   * doesn't throw. It deliberately does not assert that `cancel()` interrupts
   * a mock-backed stream, since the `AbortSignal` forwarded to a
   * `__test.mock` handler doesn't survive that crossing intact either — a
   * pre-existing `__test.mock` limitation, not something this spec guards.
   */
  test('should expose a callable cancel() on the returned handle without throwing across the bridge', async () => {
    const { app, win } = await launchElectron();

    try {
      const result = await win.evaluate(async () => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
          logs: {
            stream: (game: string) => {
              next: () => Promise<{ done?: boolean; value?: string }>;
              cancel: () => void;
            };
          };
        };

        hyveon.__test.mock('logs.stream', () => ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => Promise.resolve({ done: false, value: 'only-chunk' }),
        }));

        const handle = hyveon.logs.stream('minecraft');
        const hasCancel = typeof handle.cancel === 'function';
        let cancelThrew = false;
        try {
          handle.cancel();
        } catch {
          cancelThrew = true;
        }
        // The handle should still be safely consumable after cancel() —
        // cancelling never poisons `next()` into throwing.
        const afterCancel = await handle.next();
        return { hasCancel, cancelThrew, afterCancelDone: afterCancel.done ?? false };
      });

      expect(result.hasCancel).toBe(true);
      expect(result.cancelThrew).toBe(false);
      expect(result.afterCancelDone).toBe(false);
    } finally {
      await app.close();
    }
  });
});
