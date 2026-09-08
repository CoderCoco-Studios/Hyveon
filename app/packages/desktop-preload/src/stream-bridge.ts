/**
 * Shared buffered-stream machinery for `preload.ts`'s per-channel async generators.
 *
 * Every streaming channel in `preload.ts` follows the same shape: `invoke` a channel to open a
 * stream, listen on derived chunk/end IPC channels, buffer incoming chunks behind a `wake`
 * resolver, and drain them through an `async function*` until an end event (or abort) closes the
 * loop. {@link createBufferedStream} extracts that machinery once; `preload.ts` calls it four
 * times to produce four separately-named generator factories (`streamLogs`, `streamLambdaLogs`,
 * `streamStackInitialize`, `streamIacRunLogs`) — it is never used to build the exposed
 * `window.hyveon` API object itself, since a `contextBridge`-safe surface can only be built from
 * statically named, own-enumerable properties (see `preload.ts`'s module doc comment).
 *
 * Two channel shapes exist among the four streams, both handled here:
 *
 * - **Per-call channels** (`streamLogs`, `streamLambdaLogs`): the chunk/end channel names embed
 *   the `streamId` minted by the `invoke` ack, so they're unique to this call and listeners attach
 *   only once that ack resolves. Cancellation sends a dedicated `.cancel` message and waits for the
 *   main process to ack it with its own `.end` event before the generator's `finally` block runs.
 *   Selected when `chunkChannel`/`endChannel` are passed as functions of `streamId`.
 * - **Shared side channels** (`streamStackInitialize`, `streamIacRunLogs`): the chunk/end channels
 *   are fixed constants reused by every concurrent call, so listeners attach *before* invoking (to
 *   never drop an event sent right after the ack) and every event is tagged with its own
 *   `streamId`, filtered against this call's `ownStreamId`, and buffered raw until that id is
 *   known. Cancellation has no dedicated channel — aborting just stops the local drain loop
 *   immediately, since there is no per-call main-process run to tear down early. Selected when
 *   `chunkChannel`/`endChannel` are passed as plain strings.
 */

import { ipcRenderer, IpcRendererEvent } from 'electron';

/** Raw end-event payload shared by both channel styles; `streamId` is only present for the shared-side-channel style. */
interface StreamEndData {
  streamId?: string;
  error?: string;
}

/**
 * Configuration for one buffered stream.
 *
 * @typeParam TArg - The stream's single positional argument (e.g. `game`, `functionKey`, `runId`); `undefined` for a
 * stream that takes none.
 * @typeParam TWire - The raw chunk payload received over IPC.
 * @typeParam TOut - The value the generator yields.
 */
export interface BufferedStreamConfig<TArg, TWire, TOut> {
  /** IPC channel used both to open the stream (`invoke`) and to look up a registered test mock. */
  invokeChannel: string;
  /**
   * Chunk-event channel name. A function of `streamId` selects the per-call style (attach after
   * the invoke ack resolves); a plain string selects the shared-side-channel style (attach before
   * invoking, filter by `streamId`).
   */
  chunkChannel: string | ((streamId: string) => string);
  /** End-event channel name, in the same per-call-vs-shared style as {@link chunkChannel}. */
  endChannel: string | ((streamId: string) => string);
  /** Per-call style only: cancel-channel name sent on abort. Omit for the shared-side-channel style, which has none. */
  cancelChannel?: (streamId: string) => string;
  /** Maps a raw wire chunk to the value the generator yields. */
  mapChunk: (raw: TWire) => TOut;
  /** Extracts this call's `streamId` from a raw wire chunk — shared-side-channel style only, used to filter foreign events. */
  getStreamId?: (raw: TWire) => string;
  /** Validates the `invoke` ack and returns its `streamId`, or throws if the stream never started. */
  checkAck: (ack: unknown) => string;
  /** Builds the `invoke` call's argument list from `arg`. Defaults to `[arg]` (or `[]` when `arg` is `undefined`). */
  toInvokeArgs?: (arg: TArg) => unknown[];
}

/**
 * Preload-internal dependencies {@link createBufferedStream} needs from `preload.ts` — its
 * mock-aware `invoke` wrapper and the shared mock registry — passed in rather than imported so
 * this module has no dependency on `preload.ts`'s module-level state.
 */
export interface BufferedStreamDeps {
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  mockRegistry: Map<string, (...args: unknown[]) => unknown>;
}

/**
 * Builds a preload-internal `async function*` implementing one buffered IPC stream — the shared
 * body behind `streamLogs`, `streamLambdaLogs`, `streamStackInitialize`, and `streamIacRunLogs`.
 * See the module doc comment for the two channel styles this handles.
 *
 * The returned generator first checks `deps.mockRegistry` for `config.invokeChannel` (test mode
 * only) and, if present, delegates entirely to the mock's returned `AsyncIterable` instead of
 * touching real IPC — called with `(arg, signal)`, or just `(signal)` when `arg` is `undefined`.
 *
 * @param config - Channel names, chunk/ack mapping, and cancellation shape for this stream.
 * @param deps - `preload.ts`'s `invoke` wrapper and mock registry.
 * @returns A generator factory taking the stream's single positional argument and an optional `AbortSignal`.
 */
export function createBufferedStream<TArg, TWire, TOut>(
  config: BufferedStreamConfig<TArg, TWire, TOut>,
  deps: BufferedStreamDeps,
): (arg: TArg, signal?: AbortSignal) => AsyncGenerator<TOut> {
  const { invokeChannel, chunkChannel, endChannel, cancelChannel, mapChunk, getStreamId, checkAck, toInvokeArgs } =
    config;
  const shared = typeof chunkChannel === 'string';
  if (shared && !getStreamId) {
    throw new Error(`createBufferedStream: getStreamId is required for shared-channel stream '${invokeChannel}'`);
  }

  return async function* (arg: TArg, signal?: AbortSignal): AsyncGenerator<TOut> {
    const mock = deps.mockRegistry.get(invokeChannel);
    if (mock !== undefined) {
      const mockArgs = arg === undefined ? [signal] : [arg, signal];
      const mockIterable = mock(...mockArgs) as AsyncIterable<TOut>;
      yield* mockIterable;
      return;
    }

    /** Chunks mapped and ready to yield. */
    const buffer: TOut[] = [];
    let ended = false;
    let endError: string | undefined;
    /** Resolves the pending `await` when a chunk arrives, the stream ends, or (shared style) the signal aborts. */
    let wake: (() => void) | null = null;
    const signalWake = () => {
      if (wake) {
        const fn = wake;
        wake = null;
        fn();
      }
    };
    const invokeArgs = toInvokeArgs ? toInvokeArgs(arg) : arg === undefined ? [] : [arg];

    if (shared) {
      const fixedChunkChannel = chunkChannel as string;
      const fixedEndChannel = endChannel as string;
      let aborted = false;
      /** This call's own `streamId`, known only once the invoke ack resolves. */
      let ownStreamId: string | null = null;
      const rawChunkBuffer: TWire[] = [];
      const rawEndBuffer: StreamEndData[] = [];

      const applyChunk = (data: TWire) => {
        if (getStreamId!(data) !== ownStreamId) return;
        buffer.push(mapChunk(data));
        signalWake();
      };
      const applyEnd = (data: StreamEndData) => {
        if (data.streamId !== ownStreamId) return;
        ended = true;
        endError = data.error;
        signalWake();
      };
      const onChunk = (_evt: IpcRendererEvent, data: TWire) => {
        if (ownStreamId === null) {
          rawChunkBuffer.push(data);
          return;
        }
        applyChunk(data);
      };
      const onEnd = (_evt: IpcRendererEvent, data: StreamEndData) => {
        if (ownStreamId === null) {
          rawEndBuffer.push(data);
          return;
        }
        applyEnd(data);
      };
      const onAbort = () => {
        aborted = true;
        signalWake();
      };

      // Attach both listeners before invoking so no early event sent right after the main process
      // acknowledges the call is ever dropped; `onEnd` uses `.on` (not `.once`) since a foreign
      // concurrent call's end event can arrive on this same fixed channel before our own.
      ipcRenderer.on(fixedChunkChannel, onChunk);
      ipcRenderer.on(fixedEndChannel, onEnd);
      if (signal) {
        if (signal.aborted) aborted = true;
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        if (aborted) return;

        const ack = await deps.invoke(invokeChannel, ...invokeArgs);
        ownStreamId = checkAck(ack);

        // Replay anything observed before we knew our own streamId, filtering out events tagged
        // with a different (foreign, overlapping) call.
        for (const data of rawChunkBuffer) applyChunk(data);
        rawChunkBuffer.length = 0;
        for (const data of rawEndBuffer) applyEnd(data);
        rawEndBuffer.length = 0;

        while (true) {
          while (buffer.length > 0) {
            if (aborted) return;
            yield buffer.shift()!;
          }
          if (aborted) return;
          if (ended) {
            if (endError) throw new Error(endError);
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        ipcRenderer.removeListener(fixedChunkChannel, onChunk);
        ipcRenderer.removeListener(fixedEndChannel, onEnd);
        signal?.removeEventListener('abort', onAbort);
      }
    }

    // Per-call channels: open the stream first to learn its streamId, then derive and attach to
    // channels unique to this call — no filtering needed, and cancellation sends a dedicated
    // message the main process acks with its own end event.
    const ack = await deps.invoke(invokeChannel, ...invokeArgs);
    const streamId = checkAck(ack);
    const derivedChunkChannel = (chunkChannel as (id: string) => string)(streamId);
    const derivedEndChannel = (endChannel as (id: string) => string)(streamId);
    const sendCancel = cancelChannel ? () => ipcRenderer.send(cancelChannel(streamId)) : () => {};

    const onChunk = (_evt: IpcRendererEvent, data: TWire) => {
      buffer.push(mapChunk(data));
      signalWake();
    };
    const onEnd = (_evt: IpcRendererEvent, data: StreamEndData) => {
      ended = true;
      endError = data?.error;
      signalWake();
    };
    const onAbort = () => sendCancel();

    ipcRenderer.on(derivedChunkChannel, onChunk);
    ipcRenderer.once(derivedEndChannel, onEnd);
    if (signal) {
      if (signal.aborted) sendCancel();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      while (true) {
        while (buffer.length > 0) {
          yield buffer.shift()!;
        }
        if (ended) {
          if (endError) throw new Error(endError);
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      ipcRenderer.removeListener(derivedChunkChannel, onChunk);
      ipcRenderer.removeListener(derivedEndChannel, onEnd);
      signal?.removeEventListener('abort', onAbort);
      // Consumer left before the stream ended (early break/return or abort) — tell the main
      // process to stop tailing so it doesn't leak the loop.
      if (!ended) sendCancel();
    }
  };
}
