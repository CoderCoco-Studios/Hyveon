import type { MessageHandler } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ElectronIPCTransport } from 'nestjs-electron-ipc-transport';

/**
 * IPC channels that manage their own `ipcMain.handle` registration and must
 * be skipped by the generic bridge to avoid a double registration.
 *
 * - `logs.stream`: `LogsController.onModuleInit` bridges it manually because
 *   the handler needs to push follow-up chunk/end messages over side channels
 *   derived from a `streamId` it mints itself — see
 *   `app/packages/desktop-main/src/controllers/logs.controller.ts`.
 * - `iac.plan` / `iac.apply` / `iac.destroy`: bridged manually by
 *   `IacController` because each streams `pulumi preview`/`up`/`destroy`
 *   progress over a side channel for the duration of a long-running run, the
 *   same self-bridging pattern `logs.stream` uses. `iac.destroy.mintToken`
 *   is *not* in this set — it resolves a single value, so the generic bridge
 *   handles it.
 * - `iac.rollback.confirm`: bridged manually by `IacController` for the same
 *   reason — `PulumiService.confirmRollback` is an `AsyncGenerator` that
 *   streams a real plan run internally, and `IacController.confirmRollback`
 *   forwards each chunk over its own side channel before resolving. Its
 *   `ctx: { evt }` parameter is undecorated, so the generic bridge cannot
 *   size NestJS's `initialArgs` array correctly for it — omitting this entry
 *   would silently drop `ctx` at runtime.
 * - `iac.runs.logs`: bridged manually by `IacRunsController` because the
 *   handler streams a run's live/replayed output over a side channel derived
 *   from a `streamId` it mints itself, the same self-bridging pattern above
 *   — see `app/packages/desktop-main/src/controllers/iac-runs.controller.ts`.
 */
export const SELF_BRIDGED_PATTERNS: ReadonlySet<string> = new Set([
  'logs.stream',
  'iac.plan',
  'iac.apply',
  'iac.destroy',
  'iac.rollback.confirm',
  'iac.runs.logs',
]);

/**
 * `ElectronIPCTransport` (from `nestjs-electron-ipc-transport`) only exposes
 * its registered `@MessagePattern` handlers via the `messageHandlers` map it
 * inherits from `@nestjs/microservices`'s abstract `Server` class, and that
 * field is `protected`. This subclass exposes a single public, typed
 * accessor so callers (and {@link registerIpcMainBridges}) can read the map
 * through the normal type system instead of an `as unknown as` cast at every
 * call site.
 */
export class BridgedElectronIPCTransport extends ElectronIPCTransport {
  /** Public, typed view of the protected `messageHandlers` map inherited from `Server`. */
  public get messagePatternHandlers(): Map<string, MessageHandler> {
    return this.messageHandlers;
  }

  /**
   * Nest 11 promoted `on()` and `unwrap()` to abstract members of the
   * `Server` base class. `nestjs-electron-ipc-transport` was written against
   * Nest 8 and implements neither, so this subclass must supply them or
   * `tsc` rejects the class as abstract-incomplete.
   *
   * Both throw rather than silently no-op: neither is reachable from Nest's
   * own bootstrap path, and this transport has no event emitter or native
   * server object to hand back. A thrown error surfaces immediately; a
   * no-op `on()` would leave a caller waiting on events that can never
   * arrive.
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
 * this bridge, every `@MessagePattern` channel other than `logs.stream`
 * (which bridges itself, see {@link SELF_BRIDGED_PATTERNS}) hangs forever
 * when invoked from the renderer.
 *
 * For each bridged pattern, any existing handler is removed first via
 * `ipcMain.removeHandler` so hot-reload re-registration does not throw. The
 * registered `ipcMain.handle` callback invokes the NestJS handler as
 * `handler(payload, { evt })`, matching the `{ evt }` context shape
 * `ElectronIPCTransport.onMessage` passes today.
 *
 * Silent no-op outside a real Electron main process
 * (`process.versions.electron` undefined) so the plain-Node integration test
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
    ipcMain.handle(pattern, (evt: IpcMainInvokeEvent, payload: unknown) =>
      handler(payload, { evt }),
    );
  }
}
