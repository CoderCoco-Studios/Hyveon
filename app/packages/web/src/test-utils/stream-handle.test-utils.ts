import type { HyveonStreamHandle } from '@hyveon/desktop-preload';

/**
 * Wraps an async generator function so a Vitest `mockImplementation` can back
 * a streaming `window.hyveon` method (`logs.stream`, `iac.stack.initialize`,
 * `iac.runs.streamLogs`) with a {@link HyveonStreamHandle}-shaped
 * return value — matching what the real preload bridge now returns (see
 * `bridgeStream` in `@hyveon/desktop-preload`'s `preload.ts`) instead of a
 * bare `AsyncGenerator`, which the contextBridge can't clone across the
 * isolated-world boundary in production and which no longer has the `cancel()`
 * method components call on unmount/re-run.
 *
 * Call sites keep writing an ordinary generator body —
 * `toStreamHandleMock(async function* () { yield chunk; })` — this only
 * adapts the *shape* handed back to the component under test; `cancel()`
 * calls the wrapped generator's own `return()` so a component's cleanup
 * effect actually stops the mock stream, the same way the real bridge's
 * `cancel()` eventually stops the real one.
 *
 * @param genFn - The generator function to wrap, e.g. `async function* () { yield chunk; }`.
 */
export function toStreamHandleMock<Args extends unknown[], T>(
  genFn: (...args: Args) => AsyncGenerator<T>,
): (...args: Args) => HyveonStreamHandle<T> {
  return (...args: Args) => {
    const source = genFn(...args);
    const handle: HyveonStreamHandle<T> = {
      next: () => source.next(),
      cancel: () => {
        void source.return(undefined);
      },
      [Symbol.asyncIterator]: () => handle,
    };
    return handle;
  };
}
