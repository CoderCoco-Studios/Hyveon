import type { MessageHandler } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ElectronIPCTransport } from 'nestjs-electron-ipc-transport';
import { firstValueFrom, isObservable } from 'rxjs';
import { logger } from './logger.js';

/**
 * IPC channels that manage their own `ipcMain.handle` registration and must
 * be skipped by the generic bridge to avoid a double registration.
 *
 * Every channel in this set streams progress or output over a side channel
 * (often derived from a `streamId` it mints itself) for the duration of a
 * long-running run, and its owning controller bridges it manually to push
 * those follow-up chunk/end messages — see `logs.controller.ts`,
 * `iac.controller.ts`, and `iac-runs.controller.ts`.
 *
 * Two exceptions worth calling out specifically:
 * - `iac.rollback.confirm` must stay in this set for a second, independent
 *   reason: NestJS's `RpcContextCreator` never sizes its `initialArgs` array
 *   for the undecorated `ctx` parameter the generic bridge would pass, so
 *   leaving it off silently drops `ctx` and crashes every invocation with a
 *   "Cannot read properties of undefined (reading 'evt')" TypeError.
 * - `iac.destroy.mintToken` is deliberately *not* in this set — unlike
 *   `iac.destroy`, it resolves a single value, so the generic bridge handles
 *   it fine.
 */
export const SELF_BRIDGED_PATTERNS: ReadonlySet<string> = new Set([
  'logs.stream',
  'logs.lambda.stream',
  'iac.plan',
  'iac.apply',
  'iac.destroy',
  'iac.rollback.confirm',
  'iac.runs.logs',
  'iac.stack.initialize',
]);

/**
 * `ElectronIPCTransport` (from `nestjs-electron-ipc-transport`) only exposes
 * its registered `@MessagePattern` handlers via the `messageHandlers` map it
 * inherits from `@nestjs/microservices`'s abstract `Server` class, and that
 * field is `protected`. Rather than reaching into it with an
 * `as unknown as` cast at every call site, this subclass exposes a single
 * public, typed accessor so callers (and this module's own
 * {@link registerIpcMainBridges} helper) can read the map through the normal
 * type system.
 */
export class BridgedElectronIPCTransport extends ElectronIPCTransport {
  /** Public, typed view of the protected `messageHandlers` map inherited from `Server`. */
  public get messagePatternHandlers(): Map<string, MessageHandler> {
    return this.messageHandlers;
  }

  /**
   * Nest 11 promoted `on()` and `unwrap()` to abstract members of the
   * `Server` base class. `nestjs-electron-ipc-transport` was written against
   * Nest 8 and implements neither, so the concrete subclass has to supply
   * them or `tsc` rejects the class as abstract-incomplete.
   *
   * Both throw rather than silently no-op. Neither is reachable from Nest's
   * own bootstrap path — they exist for application code that wants to
   * observe broker-level events or reach the underlying client — and this
   * transport has neither an event emitter nor a native server object to
   * hand back. A thrown error surfaces that immediately; a no-op `on()`
   * would swallow the registration and leave the caller waiting on events
   * that can never arrive.
   */
  public on(event: string | symbol): never {
    throw new Error(
      `BridgedElectronIPCTransport does not emit transport events (received "${String(event)}"). ` +
        'Electron IPC has no broker-level event stream to subscribe to.',
    );
  }

  /** See {@link on} — there is no underlying server instance to unwrap. */
  public unwrap<T>(): T {
    throw new Error(
      'BridgedElectronIPCTransport has no underlying server instance to unwrap. ' +
        "Import Electron's `ipcMain` directly if you need the raw IPC surface.",
    );
  }
}

/**
 * Bridges every NestJS `@MessagePattern` handler registered on `transport`
 * (except those in {@link SELF_BRIDGED_PATTERNS}) onto a matching
 * `ipcMain.handle` registration, so `ipcRenderer.invoke(channel, payload)`
 * calls made from the preload actually resolve.
 *
 * `ElectronIPCTransport.listen()` only subscribes to its own internal
 * `ipcMessageDispatcher` — it never calls `ipcMain.handle` itself. Without
 * this bridge, every non-self-bridged channel hangs forever when invoked
 * from the renderer (see #277). Any existing handler is removed first via
 * `ipcMain.removeHandler` so hot-reload re-registration does not throw
 * "Attempted to register a second handler for '<channel>'".
 *
 * A rejected handler promise is caught and normalized to a plain `Error`
 * carrying only `.message` before it is rethrown. This app has no NestJS
 * exception filter anywhere, and this bridge is the one structural choke
 * point every `@MessagePattern` handler passes through — without this
 * normalization, a handler that lets a raw SDK/Node error escape (e.g. an
 * AWS SDK exception with non-plain fields like `$metadata` or symbol-keyed
 * internals) fails Electron's structured-clone when the rejection is
 * marshalled back to the renderer, surfacing as a generic "object could not
 * be cloned" failure instead of the real error message.
 *
 * An uncaught throw inside a `@MessagePattern` handler doesn't reach here as
 * a rejection at all: `RpcProxy.create` (`@nestjs/microservices`) catches it
 * and *resolves* with an RxJS `Observable` built from `throwError(...)` —
 * Nest's RPC context has no HTTP response to write the error to, so it hands
 * the error back as a stream instead. Left alone, that Observable is what
 * Electron tries to structured-clone, producing the same failure without
 * ever entering the `catch` block below. `firstValueFrom` converts that
 * Observable back into a rejected promise so it flows through the same
 * normalization path as every other thrown error — though the *message* on
 * that rejection is only real because of {@link RpcErrorMessageFilter}.
 *
 * Silent no-op outside a real Electron main process
 * (`process.versions.electron` undefined) — matching the guard
 * `LogsController.onModuleInit` uses — so the plain-Node integration test
 * harness, Docker builds, and CI never attempt to import `electron`.
 */
export async function registerIpcMainBridges(transport: BridgedElectronIPCTransport): Promise<void> {
  if (!process.versions.electron) {
    // Not running inside the Electron main process — bridge skipped.
    return;
  }

  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMain };

  for (const [pattern, handler] of transport.messagePatternHandlers) {
    if (SELF_BRIDGED_PATTERNS.has(pattern)) {
      continue;
    }

    ipcMain.removeHandler(pattern);
    ipcMain.handle(pattern, async (evt: IpcMainInvokeEvent, payload: unknown) => {
      try {
        const result = await handler(payload, { evt });
        return isObservable(result) ? await firstValueFrom(result) : result;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err !== null && 'message' in err
              ? String((err as { message: unknown }).message)
              : String(err);
        logger.error(`ipc-main-bridge: handler for "${pattern}" failed: ${message}`, {
          pattern,
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw new Error(message);
      }
    });
  }
}
