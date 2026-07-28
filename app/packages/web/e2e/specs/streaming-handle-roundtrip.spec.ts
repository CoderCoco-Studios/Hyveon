import { test, expect, _electron } from '../fixtures/index.js';
import { electronMain, electronEnv } from '../../playwright.config.js';

/**
 * Regression spec for the streaming-IPC contextBridge clone bug: every
 * bridged streaming channel (`logs.stream`, `terraform.init`,
 * `terraform.runs.streamLogs`) used to return a raw `AsyncGenerator` from the
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
 * Each test still seeds its channel's *data source* via
 * `window.hyveon.__test.mock(channel, handler)`, since there is no real
 * AWS/Terraform backend available in this test environment — but the mock
 * handler here returns a **plain object** implementing the async-iterator
 * protocol (`next()` + `[Symbol.asyncIterator]()`), not a real
 * `async function*`. A real generator instance run from a mock handler has
 * its own, separate crossing to make — the mock handler itself lives in the
 * renderer (registered via `win.evaluate`) and is invoked *from* preload via
 * a reverse proxy, so whatever it returns has to cross renderer→preload
 * before `streamLogs`/`streamTerraformInit`/`streamTerraformRunLogs` can
 * `yield*` it — and a raw `AsyncGenerator` doesn't survive that crossing
 * either, for the same underlying reason. That reverse-direction mock
 * limitation is a pre-existing property of the `__test.mock` convenience
 * surface, not the bug this spec guards (the mock plumbing was never touched
 * by the fix), so every mock below is written as a plain-object iterable to
 * stay clear of it. What's actually under test — never bypassed or mocked —
 * is the `HyveonStreamHandle` wrapping `openLogsStream` /
 * `openTerraformInitStream` / `openTerraformRunLogsStream` return from the
 * real preload script, and their trip across the real `contextBridge` back
 * to this renderer. This mirrors `electron-ipc-roundtrip.spec.ts`'s own use
 * of `electronEnv` (which sets `HYVEON_TEST_MODE=1`) while still calling
 * itself "unmocked" for the specific bug it guards.
 */
test.describe('streaming IPC handle round-trip (contextBridge clone)', () => {
  test('should stream chunks from window.hyveon.logs.stream() without a clone error', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

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

  test('should stream chunks from window.hyveon.terraform.init() without a clone error', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

      const result = await win.evaluate(async () => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
          terraform: {
            init: (config: unknown) => AsyncIterable<{ stream: string; line: string }> & { cancel: () => void };
          };
        };

        hyveon.__test.mock('terraform.init', () => {
          const queued = [
            { stream: 'stdout', line: 'Initializing the backend...' },
            { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
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

        const handle = hyveon.terraform.init({ bucket: 'b', region: 'us-east-1', dynamodbTable: 't' });
        const chunks: { stream: string; line: string }[] = [];
        for await (const chunk of handle) {
          chunks.push(chunk);
        }
        return { chunks, hasCancel: typeof handle.cancel === 'function' };
      });

      expect(result.chunks).toEqual([
        { stream: 'stdout', line: 'Initializing the backend...' },
        { stream: 'stdout', line: 'Terraform has been successfully initialized!' },
      ]);
      expect(result.hasCancel).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('should stream chunks from window.hyveon.terraform.runs.streamLogs() without a clone error', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

      const result = await win.evaluate(async () => {
        const hyveon = (window as unknown as Record<string, unknown>)['hyveon'] as {
          __test: { mock: (channel: string, handler: unknown) => void };
          terraform: {
            runs: {
              streamLogs: (
                runId: string,
              ) => AsyncIterable<{ stream: string; line: string }> & { cancel: () => void };
            };
          };
        };

        hyveon.__test.mock('terraform.runs.logs', () => {
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

        const handle = hyveon.terraform.runs.streamLogs('run-123');
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
   * `cancel()`'s full functional behaviour (it aborts the handle's internal
   * `AbortController`, which drives `streamLogs`/`streamTerraformInit`/
   * `streamTerraformRunLogs`'s own `signal.aborted` checks and
   * `signal.addEventListener('abort', …)` listeners) is exercised
   * deterministically in `preload.test.ts`, entirely within the preload
   * process — no contextBridge crossing involved there, since Vitest calls
   * the module functions directly.
   *
   * This spec instead proves the piece only a real Electron process can
   * prove: that `cancel` itself is a real, callable function once it has
   * crossed the bridge (not stripped or replaced by the clone), and that
   * calling it doesn't throw or otherwise crash the renderer. It
   * deliberately does not also assert that `cancel()` interrupts a
   * mock-backed stream: the internally-minted `AbortSignal` `bridgeStream`
   * forwards to a `__test.mock` handler is itself a value crossing
   * preload→renderer as a call argument, and a real `AbortSignal` doesn't
   * survive that crossing intact either (its prototype getters/methods are
   * stripped) — this is the same underlying contextBridge limitation the
   * production fix works around by never handing the renderer a signal to
   * begin with, but it still applies to a signal preload forwards *into* a
   * mock handler, which is a pre-existing property of the `__test.mock`
   * convenience surface untouched by this fix, not something this spec
   * guards.
   */
  test('should expose a callable cancel() on the returned handle without throwing across the bridge', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();

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
