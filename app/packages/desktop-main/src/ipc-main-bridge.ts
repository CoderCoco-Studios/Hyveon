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
 * - `terraform.init`: NOT self-bridged (unlike before task 7.10 of the
 *   `migrate-iac-to-pulumi` change) — `TerraformController.init` no longer
 *   streams anything under the Pulumi engine (see that method's own TSDoc);
 *   it resolves a single value like any other channel, so the generic bridge
 *   below handles it now.
 * - `terraform.plan`: bridged manually by its controller because it streams
 *   `pulumi preview` progress over a side channel for the duration of a
 *   long-running run, the same self-bridging pattern `logs.stream` uses.
 * - `terraform.apply`: bridged manually by the same controller for the same
 *   reason as `terraform.plan` — it streams `terraform apply` progress over a
 *   side channel for the duration of a long-running run (see #109).
 * - `terraform.destroy`: bridged manually by the same controller for the
 *   same reason as `terraform.apply` — it streams `terraform destroy`
 *   progress over a side channel for the duration of a long-running run (see
 *   #307). `terraform.destroy.mintToken` is *not* in this set — it resolves
 *   a single value, so the generic bridge handles it.
 * - `terraform.runs.logs`: bridged manually by `TerraformRunsController`
 *   because the handler streams a run's live/replayed output over a side
 *   channel derived from a `streamId` it mints itself, the same
 *   self-bridging pattern `terraform.init`/`terraform.plan` use — see
 *   `app/packages/desktop-main/src/controllers/terraform-runs.controller.ts`.
 */
export const SELF_BRIDGED_PATTERNS: ReadonlySet<string> = new Set([
  'logs.stream',
  'terraform.plan',
  'terraform.apply',
  'terraform.destroy',
  'terraform.runs.logs',
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
    ipcMain.handle(pattern, (evt: IpcMainInvokeEvent, payload: unknown) =>
      handler(payload, { evt }),
    );
  }
}
