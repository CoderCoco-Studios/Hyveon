import type { MessageHandler } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ElectronIPCTransport } from 'nestjs-electron-ipc-transport';
import { logger } from './logger.js';

/**
 * IPC channels that manage their own `ipcMain.handle` registration and must
 * be skipped by the generic bridge to avoid a double registration.
 *
 * - `logs.stream`: `LogsController.onModuleInit` bridges it manually because
 *   the handler needs to push follow-up chunk/end messages over side channels
 *   derived from a `streamId` it mints itself — see
 *   `app/packages/desktop-main/src/controllers/logs.controller.ts`.
 * - `iac.plan`: bridged manually by its controller because it streams
 *   `pulumi preview` progress over a side channel for the duration of a
 *   long-running run, the same self-bridging pattern `logs.stream` uses.
 * - `iac.apply`: bridged manually by the same controller for the same
 *   reason as `iac.plan` — it streams `pulumi up` progress over a
 *   side channel for the duration of a long-running run (see #109).
 * - `iac.destroy`: bridged manually by the same controller for the
 *   same reason as `iac.apply` — it streams `pulumi destroy`
 *   progress over a side channel for the duration of a long-running run (see
 *   #307). `iac.destroy.mintToken` is *not* in this set — it resolves
 *   a single value, so the generic bridge handles it.
 * - `iac.rollback.confirm`: bridged manually by the same controller for
 *   the same reason as `iac.plan`/`iac.apply`/`iac.destroy`
 *   — `PulumiService.confirmRollback` is an `AsyncGenerator` that streams a
 *   real plan run internally, and `IacController.confirmRollback` forwards
 *   each chunk over its own side channel for the duration of that run
 *   before resolving. This channel must stay in this set: NestJS's
 *   `RpcContextCreator` never sizes its `initialArgs` array for the
 *   undecorated `ctx` parameter the generic bridge would pass, so leaving
 *   it off silently drops `ctx` and crashes every invocation with a
 *   "Cannot read properties of undefined (reading 'evt')" TypeError.
 * - `iac.runs.logs`: bridged manually by `IacRunsController`
 *   because the handler streams a run's live/replayed output over a side
 *   channel derived from a `streamId` it mints itself, the same
 *   self-bridging pattern `iac.plan`/`logs.stream` use — see
 *   `app/packages/desktop-main/src/controllers/iac-runs.controller.ts`.
 * - `iac.stack.initialize`: bridged manually by `IacController`, replacing
 *   the deleted `iac.init` channel, for the same reason as `iac.plan` — it
 *   streams `PulumiService.initializeStack`'s `onPhase` progress over a
 *   side channel for the duration of a long-running run.
 */
export const SELF_BRIDGED_PATTERNS: ReadonlySet<string> = new Set([
  'logs.stream',
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
 * `ElectronIPCTransport.listen()` (from `nestjs-electron-ipc-transport`) only
 * subscribes to its own internal `ipcMessageDispatcher` — it never calls
 * `ipcMain.handle` itself. Without this bridge, every `@MessagePattern`
 * channel other than `logs.stream` (which bridges itself, see
 * {@link SELF_BRIDGED_PATTERNS}) hangs forever when invoked from the
 * renderer, because `ipcRenderer.invoke` requires a matching
 * `ipcMain.handle` registration in the main process (see #277).
 *
 * For each bridged pattern, any existing handler is removed first via
 * `ipcMain.removeHandler` so hot-reload re-registration does not throw
 * "Attempted to register a second handler for '<channel>'", mirroring the
 * approach `LogsController.onModuleInit` already takes for `logs.stream`.
 * The registered `ipcMain.handle` callback invokes the NestJS handler as
 * `handler(payload, { evt })`, matching the `{ evt }` context shape
 * `ElectronIPCTransport.onMessage` passes today so controller method
 * signatures do not need to change.
 *
 * A rejected handler promise is caught and normalized to a plain `Error`
 * carrying only `.message` before it is rethrown. This app has no NestJS
 * exception filter anywhere, and this bridge is the one structural choke
 * point every `@MessagePattern` handler passes through — without this
 * normalization, a handler that lets a raw SDK/Node error escape (e.g. an
 * AWS SDK exception with non-plain fields like `$metadata` or symbol-keyed
 * internals) fails Electron's structured-clone when the rejection is
 * marshalled back to the renderer, surfacing as a generic "object could not
 * be cloned" failure and leaving the renderer's `invoke()` promise
 * unresolved instead of the real error message. Every failure is logged
 * here too, so the daily log file has a record of which channel failed and
 * why even when a caller doesn't handle the rejection.
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
        return await handler(payload, { evt });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`ipc-main-bridge: handler for "${pattern}" failed: ${message}`, {
          pattern,
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw new Error(message);
      }
    });
  }
}
