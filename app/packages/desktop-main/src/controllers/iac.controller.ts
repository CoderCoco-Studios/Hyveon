import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { RunLockHeldError } from '@hyveon/shared';
import type { StackOutputs } from '@hyveon/shared';
import {
  PulumiService,
  PulumiOperationInFlightError,
  PulumiRollbackPlanFailedError,
  type PulumiRunChunk,
  type PulumiPreviewResult,
  type PulumiUpResult,
  type PulumiDestroyResult,
} from '../services/PulumiService.js';
import { PulumiUnrecognizedLockError } from '../services/PulumiLockRecovery.js';
import { ConfigService } from '../services/ConfigService.js';
import { AuditService } from '../services/AuditService.js';
import { RunRecordService } from '../services/RunRecordService.js';
import { logger } from '../logger.js';

/** Fixed side-channel `IacController.plan` pushes streamed output on. */
const PLAN_CHUNK_CHANNEL = 'iac.plan.chunk';

/** Fixed side-channel `IacController.plan` sends its terminal message on. */
const PLAN_END_CHANNEL = 'iac.plan.end';

/** Fixed side-channel `IacController.apply` pushes streamed output on. */
const APPLY_CHUNK_CHANNEL = 'iac.apply.chunk';

/** Fixed side-channel `IacController.apply` sends its terminal message on. */
const APPLY_END_CHANNEL = 'iac.apply.end';

/** Fixed side-channel `IacController.destroy` pushes streamed output on. */
const DESTROY_CHUNK_CHANNEL = 'iac.destroy.chunk';

/** Fixed side-channel `IacController.destroy` sends its terminal message on. */
const DESTROY_END_CHANNEL = 'iac.destroy.end';

/**
 * Side-channel {@link IacController.confirmRollback} pushes streamed
 * rollback-plan output on. `PulumiService.confirmRollback` streams a real
 * plan run internally (restore-then-plan as one guarded unit), so chunks are
 * forwarded here for a future caller — the renderer today only awaits the
 * resolved ack, not this channel.
 */
const ROLLBACK_CONFIRM_CHUNK_CHANNEL = 'iac.rollback.confirm.chunk';

/**
 * Backend configuration values the first-run wizard passes for the S3
 * remote-state backend. Kept here to preserve {@link IacController.init}'s
 * payload type (and the `iac.init` IPC contract's shape) even though the
 * method body itself is now an inert rejection — see {@link init}.
 */
interface TerraformInitConfig {
  bucket: string;
  region: string;
  dynamodbTable: string;
}

/**
 * Immediate acknowledgement `init()` resolves with. `started: true` means the
 * streaming loop was kicked off in the background (chunk/end messages follow
 * on the side channels, tagged with `streamId`). `started: false` means
 * `config` failed validation, or validation passed but `init()` is a no-op
 * under the Pulumi engine (see {@link IacController.init}) — either way no
 * run was attempted and `streamId` is omitted.
 */
interface TerraformInitAck {
  started: boolean;
  streamId?: string;
  error?: string;
}

/**
 * Payload accepted by {@link IacController.output}. `force` is kept for
 * payload compatibility with the preload/renderer contract but is now
 * ignored — see {@link IacController.output}.
 */
interface TerraformOutputPayload {
  force?: boolean;
}

/**
 * Payload accepted by {@link IacController.plan}. `tfvarsVersionId`, when the
 * configured configuration source is S3-backed, is forwarded to
 * `PulumiService.preview`'s pre-spawn staleness check against the current
 * head version. `rolledBackFrom`, when supplied by the rollback flow, is
 * stamped onto the resulting plan's `PulumiRunRecord` to tag it as a
 * rollback of that `runId`.
 */
interface TerraformPlanPayload {
  tfvarsVersionId?: string;
  rolledBackFrom?: string;
}

/**
 * Message payload sent, in order, on {@link PLAN_CHUNK_CHANNEL} for every
 * chunk `PulumiService.preview` yields. `runId` ties the chunk back to the
 * `plan()` call that produced it (see {@link TerraformPlanAck.runId}) so
 * overlapping runs can never be confused with each other.
 */
interface TerraformPlanChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link PLAN_END_CHANNEL} when a `iac.plan`
 * run finishes. `exitCode` is `0` on success, or `null` on failure — the
 * Pulumi Automation API has no real process exit code to report, so `null`
 * uniformly means "this run did not succeed". `result` is present only on a
 * successful run.
 */
interface TerraformPlanEndMessage {
  runId: string;
  exitCode: number | null;
  error?: string;
  result?: PulumiPreviewResult;
}

/**
 * Holder/age evidence for one lock entry parsed off a Pulumi backend lock
 * conflict — the IPC-safe mirror of `PulumiStackLockInfo`
 * (`../services/PulumiLockRecovery.js`). `lockedAt` is serialized to an ISO
 * string rather than carried as a `Date`: a raw `Date` does not survive
 * Electron's IPC structured-clone/contextBridge boundary reliably, so
 * {@link serializeStaleLock} converts it explicitly at the point this leaves
 * the main process.
 */
interface StaleLockHolder {
  lockUrl: string;
  username: string;
  hostname: string;
  pid: number;
  lockedAt: string;
}

/**
 * Attached to an ack or end message when the underlying `PulumiService` call
 * threw `PulumiUnrecognizedLockError` — the backend lock conflict could not
 * be proven to be this installation's own orphaned run, so the operator must
 * confirm before it's cleared. Carries the same holder/age evidence the
 * error itself carries so a caller has real data to render instead of only
 * `error`'s prose. Only this read side is wired — no "clear the lock" write
 * path exists yet.
 */
interface StaleLockInfo {
  stackName: string;
  locks: StaleLockHolder[];
}

/**
 * Serializes a caught {@link PulumiUnrecognizedLockError} into
 * {@link StaleLockInfo} — see that type's doc comment for why `lockedAt`
 * becomes a string here.
 */
function serializeStaleLock(err: PulumiUnrecognizedLockError): StaleLockInfo {
  return {
    stackName: err.stackName,
    locks: err.locks.map((lock) => ({
      lockUrl: lock.lockUrl,
      username: lock.username,
      hostname: lock.hostname,
      pid: lock.pid,
      lockedAt: lock.lockedAt.toISOString(),
    })),
  };
}

/**
 * Immediate acknowledgement `plan()` resolves with. `started: true` means a
 * `runId` was pre-minted and the streaming loop was kicked off in the
 * background (chunk/end messages follow on the side channels, tagged with
 * that same `runId`). `started: false` means the submission was rejected
 * before any `PulumiService.preview` run was attempted and no `runId` is
 * present — `error` describes why, and `conflict` names the already-running
 * operation (`preview`/`up`/`destroy`/`rollback`) when the rejection was
 * because the shared workspace was busy (see
 * `PulumiService.getOperationInFlight()`). `staleLock` is present instead of
 * `conflict` when the rejection was `PulumiUnrecognizedLockError` — see
 * {@link StaleLockInfo}.
 */
interface TerraformPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
  staleLock?: StaleLockInfo;
}

/**
 * Payload accepted by {@link IacController.approve}. `planRunId`
 * identifies the successful `plan` run to approve. There is no client-supplied
 * approver identity — the approver is always resolved server-side (see
 * {@link IacController.resolveApprover}) so an IPC caller can never
 * spoof who approved a run.
 *
 * Mirrors `approve: (opts: { planRunId: string }) => ...` in
 * `@hyveon/desktop-preload/src/hyveon-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface TerraformApprovePayload {
  planRunId: string;
}

/**
 * Result `approve()` resolves with. `approved: true` means
 * `RunRecordService.approveRun` succeeded — `approvedBy`/`approvedAt` mirror
 * the values now stamped onto the persisted `RunRecord`. `approved: false`
 * means no write was attempted (payload failed validation) or the write was
 * attempted and rejected (table not configured, no matching record, record
 * isn't a successful `plan` run) — `error` is always a human-readable
 * description of why, and `approvedBy`/`approvedAt` are omitted.
 */
interface TerraformApproveAck {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  error?: string;
}

/**
 * Payload accepted by {@link IacController.resolveRollback} and
 * {@link IacController.confirmRollback} — both key off the `apply` run
 * being rolled back.
 */
interface TerraformRollbackPayload {
  applyRunId: string;
}

/**
 * Result `resolveRollback()` resolves with. `resolved: true` means
 * `PulumiService.resolveRollbackTarget` found a prior configuration version
 * to restore — `versionId`/`lastModified` identify it, for the confirmation
 * dialog to display before anything is written. `resolved: false` means the
 * payload failed validation or resolution was rejected (no matching apply
 * run, not an apply run, no recorded configuration version id, or no earlier
 * version exists) — `error` is always a human-readable description of why.
 */
interface TerraformRollbackResolveAck {
  resolved: boolean;
  versionId?: string;
  lastModified?: string;
  error?: string;
}

/**
 * Result `confirmRollback()` resolves with. `confirmed: true` means the
 * historic configuration content was restored as a new head version and the
 * follow-up plan `PulumiService.confirmRollback` runs internally completed
 * successfully — `versionId` is the restored version's id, ready to pass to
 * `iac.plan`'s `tfvarsVersionId` (alongside `rolledBackFrom: applyRunId`) —
 * see {@link IacController.confirmRollback}. `confirmed: false` means no
 * write was attempted, or the restore-then-plan unit failed partway through
 * — `error` describes why. `versionId` is also populated on a
 * `confirmed: false` ack when the failure is
 * `PulumiRollbackPlanFailedError` (the restore write succeeded but the
 * follow-up plan didn't) — it names the version that was actually restored
 * as the new head despite the ack reporting failure, so a caller can act on
 * it (e.g. offer "plan against the restored version" as a next step).
 */
interface TerraformRollbackConfirmAck {
  confirmed: boolean;
  versionId?: string;
  error?: string;
}

/**
 * Message payload sent, in order, on {@link ROLLBACK_CONFIRM_CHUNK_CHANNEL}
 * for every chunk the plan run inside `PulumiService.confirmRollback` yields.
 * `applyRunId` ties the chunk back to the `confirmRollback()` call that
 * produced it, mirroring {@link TerraformPlanChunkMessage}.
 */
interface TerraformRollbackConfirmChunkMessage {
  applyRunId: string;
  chunk: PulumiRunChunk;
}

/**
 * Payload accepted by {@link IacController.apply}. `planRunId` identifies the
 * approved `plan` run to apply — also reused, unchanged, as the apply run's
 * own `runId`. `planHash` is the caller's expected plan hash, checked
 * against the plan run's stored `planHash` by `PulumiService.apply`'s own
 * self-contained gate — this controller does not re-derive or pre-check it;
 * see {@link apply}.
 *
 * Mirrors `TerraformApplyPayload` in
 * `@hyveon/desktop-preload/src/hyveon-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface TerraformApplyPayload {
  planRunId: string;
  planHash: string;
}

/**
 * Message payload sent, in order, on {@link APPLY_CHUNK_CHANNEL} for every
 * chunk `PulumiService.apply` yields. `runId` ties the chunk back to the
 * `apply()` call that produced it — the same id already handed back in the
 * ack `IacController.apply` resolves — mirrors
 * {@link TerraformPlanChunkMessage}.
 */
interface TerraformApplyChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link APPLY_END_CHANNEL} when a `iac.apply`
 * run finishes. `exitCode` is `0` on success, or `null` on failure — see
 * {@link TerraformPlanEndMessage} for why there's no real numeric exit code
 * to report. `result` is present only on a successful run. `staleLock` is
 * present when the failure was `PulumiUnrecognizedLockError` — see
 * {@link StaleLockInfo}. Unlike {@link TerraformPlanAck},
 * `PulumiUnrecognizedLockError` can surface here (rather than on the
 * immediate ack) because `stack.up()`'s lock conflict is only discovered
 * once the operation has already been streaming.
 */
interface TerraformApplyEndMessage {
  runId: string;
  exitCode: number | null;
  error?: string;
  result?: PulumiUpResult;
  staleLock?: StaleLockInfo;
}

/**
 * Result {@link IacController.mintDestroyToken} resolves with —
 * delegates directly to `PulumiService.mintDestroyConfirmationToken()`,
 * which the operator must then supply back on {@link IacController.destroy}'s
 * payload within its short expiry window (see that method's TSDoc).
 */
interface TerraformDestroyMintAck {
  token: string;
}

/**
 * Payload accepted by {@link IacController.destroy}. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by {@link IacController.mintDestroyToken} — enforced
 * server-side by `PulumiService.destroy`'s own token gate (see
 * `DestroyNotConfirmedError`).
 *
 * Mirrors `TerraformDestroyPayload` in
 * `@hyveon/desktop-preload/src/hyveon-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface TerraformDestroyPayload {
  confirmationToken: string;
}

/**
 * Message payload sent, in order, on {@link DESTROY_CHUNK_CHANNEL} for every
 * chunk `PulumiService.destroy` yields. `runId` ties the chunk back to the
 * `destroy()` call that produced it — the same id already handed back in the
 * ack `IacController.destroy` resolves — mirrors
 * {@link TerraformApplyChunkMessage}.
 */
interface TerraformDestroyChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link DESTROY_END_CHANNEL} when a
 * `iac.destroy` run finishes. `exitCode` is `0` on success, or `null`
 * on failure — see {@link TerraformPlanEndMessage}'s doc comment for why.
 * `result` is present only on a successful run. `staleLock` is present when
 * the failure was `PulumiUnrecognizedLockError` — see
 * {@link TerraformApplyEndMessage}'s identical field for why this surfaces
 * here rather than on the immediate ack.
 */
interface TerraformDestroyEndMessage {
  runId: string;
  exitCode: number | null;
  staleLock?: StaleLockInfo;
  error?: string;
  result?: PulumiDestroyResult;
}

/**
 * IPC-only Terraform controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * {@link plan} bridges `PulumiService.preview`'s async-generator output onto
 * the fixed `iac.plan.chunk` / `iac.plan.end` side channels, plus a
 * pre-flight `PulumiService.getOperationInFlight()` conflict check and a
 * persisted `AuditService.record()` entry for every accepted submission.
 * {@link approve} resolves a single value, so the generic `ipcMain.handle`
 * bridge in `../ipc-main-bridge.ts` wires it automatically, and delegates
 * the actual write to `RunRecordService.approveRun`. {@link apply} mirrors
 * {@link plan}'s streaming/bridging shape — since `PulumiService.apply`'s
 * gate is entirely self-contained, this controller performs none of the
 * plan-hash/approval/lock pre-checks itself; it awaits the gate's own
 * outcome (the generator's first `.next()`) before acking, then starts
 * forwarding chunks. {@link destroy} mirrors {@link apply}'s shape, gated
 * behind a short-lived confirmation token minted by {@link mintDestroyToken}
 * instead of a plan/approval lineage — `mintDestroyToken` needs no bridging
 * either, same as {@link approve}.
 */
@Controller()
export class IacController implements OnModuleInit {
  /**
   * `audit`/`runRecord`/`config` are typed optional (`?`) so existing test
   * call sites that construct `new IacController(pulumi)` directly
   * (bypassing Nest's DI container) keep compiling without stubbing them —
   * every real bootstrap through `AppModule` still resolves concrete
   * instances of all three. `runRecord` backs {@link approve}'s
   * `RunRecordService.approveRun` write. `config` backs {@link output}'s
   * preferred `ConfigService.getStackOutputs()` delegate, falling back to
   * `PulumiService.getStackOutputs()` directly when unavailable.
   *
   * There is no `RunService` dependency here: `PulumiService.apply`/`.destroy`'s
   * self-contained gates acquire and release the durable apply lock
   * internally, so this controller has nothing left to do with `RunService`.
   */
  constructor(
    private readonly pulumi: PulumiService,
    private readonly audit?: AuditService,
    private readonly runRecord?: RunRecordService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Per-call `AbortController`s keyed by the `runId` minted in {@link plan}.
   * Lets a future `iac.plan.cancel` channel reach the right in-flight
   * run, and lets the `WebContents` `'destroyed'` listener in {@link plan}
   * abort immediately without racing the chunk loop's own `isDestroyed()`
   * check.
   */
  private readonly activePlans = new Map<string, AbortController>();

  /**
   * Per-call `AbortController`s keyed by the `runId` (the applied plan's own
   * `runId` — see {@link apply}) an in-flight `apply()` call is running
   * against. Mirrors {@link activePlans} — lets a future
   * `iac.apply.cancel` channel reach the right in-flight run, and lets
   * the `WebContents` `'destroyed'` listener in {@link apply} abort
   * immediately without racing the chunk loop's own `isDestroyed()` check.
   */
  private readonly activeApplies = new Map<string, AbortController>();

  /**
   * Per-call `AbortController`s keyed by the `runId` pre-minted in
   * {@link destroy}. Mirrors {@link activeApplies} — lets a future
   * `iac.destroy.cancel` channel reach the right in-flight run, and
   * lets the `WebContents` `'destroyed'` listener in {@link destroy} abort
   * immediately without racing the chunk loop's own `isDestroyed()` check.
   */
  private readonly activeDestroys = new Map<string, AbortController>();

  /**
   * Registers an `ipcMain.handle` bridge for the `iac.plan` channel (and
   * `iac.apply`/`iac.destroy`/`iac.rollback.confirm`) after the Nest module
   * initialises, so `ipcRenderer.invoke(...)` in the preload actually
   * resolves.
   *
   * `@MessagePattern(...)` only wires the transport's internal dispatcher —
   * it does **not** call `ipcMain.handle`, so `ipcRenderer.invoke` would
   * otherwise hang. This hook bridges the gap, mirroring
   * `LogsController.onModuleInit`'s handling of `logs.stream` — see
   * `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`, which excludes these
   * channels from the generic bridge because each handler pushes follow-up
   * chunk/end messages over side channels for the duration of a
   * long-running run rather than resolving a single value.
   *
   * `iac.init` is NOT registered here — {@link init} no longer streams
   * anything (see its own TSDoc), so it's resolved by the generic
   * `ipcMain.handle` bridge like any other single-value channel.
   *
   * `iac.rollback.confirm` needs the same manual registration:
   * {@link confirmRollback}'s `ctx: { evt }` second parameter has no
   * `@Payload()`/etc. decorator, exactly like `plan`/`apply`/`destroy` — left
   * off the generic bridge, NestJS's `RpcContextCreator` sizes its
   * `initialArgs` array to the one decorated parameter it sees and silently
   * drops `ctx`, which then arrives as `undefined` at runtime.
   *
   * Only runs inside a real Electron main process. In plain-Node runtimes
   * (integration test server, Docker, CI) `process.versions.electron` is
   * undefined and importing `electron` would throw, so the bridge is skipped
   * entirely.
   */
  async onModuleInit(): Promise<void> {
    if (!process.versions.electron) {
      // Not running inside the Electron main process — ipcMain bridge skipped.
      return;
    }
    const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMain };
    // Remove any existing handler first so hot-reload re-registration does
    // not throw "IPC channel already registered".
    ipcMain.removeHandler('iac.plan');
    ipcMain.handle('iac.plan', (evt, payload: TerraformPlanPayload) =>
      this.plan(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.apply` streams chunk/end messages the same way `iac.plan` does —
    // see `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`.
    ipcMain.removeHandler('iac.apply');
    ipcMain.handle('iac.apply', (evt, payload: TerraformApplyPayload) =>
      this.apply(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.destroy` streams chunk/end messages the same way `iac.apply` does
    // — see `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`.
    // `iac.destroy.mintToken` resolves a single value, so the generic bridge
    // wires it automatically — no entry here.
    ipcMain.removeHandler('iac.destroy');
    ipcMain.handle('iac.destroy', (evt, payload: TerraformDestroyPayload) =>
      this.destroy(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.rollback.confirm` streams chunk messages the same way
    // `iac.destroy` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`.
    ipcMain.removeHandler('iac.rollback.confirm');
    ipcMain.handle('iac.rollback.confirm', (evt, payload: TerraformRollbackPayload) =>
      this.confirmRollback(payload, { evt: evt as IpcMainInvokeEvent }),
    );
  }

  /**
   * `iac.init` under the Pulumi engine — a deliberate no-op rejection, not a
   * real operation.
   *
   * Pulumi has no analogue to `terraform init`: `PulumiEngineService`
   * auto-installs/resolves the Pulumi engine binary on first use, and
   * `PulumiWorkspaceService` constructs the Automation API workspace/backend
   * on demand — neither requires a separate, explicit initialization step.
   * The channel is kept wired (deleting it would break any remaining
   * `ipcRenderer.invoke('iac.init', ...)` caller, and reporting success
   * would let the wizard believe a real initialization happened) but always
   * resolves `{ started: false, error }`, naming the Pulumi engine as the
   * reason no `terraform init` ran. This is an accepted interim state — the
   * wizard's init-dependent prerequisite step still needs a proper
   * replacement. `config` validation runs unchanged ahead of the rejection
   * so a malformed payload still gets its own specific error message.
   *
   * Reachable via the Electron IPC transport (`iac.init`), resolved by the
   * generic `ipcMain.handle` bridge in `../ipc-main-bridge.ts` since nothing
   * is streamed any more.
   */
  @MessagePattern('iac.init')
  async init(@Payload() config: TerraformInitConfig): Promise<TerraformInitAck> {
    const validationError = IacController.validateConfig(config);
    if (validationError) {
      logger.error('terraform init rejected: invalid config', { error: validationError });
      return { started: false, error: validationError };
    }

    logger.warn('terraform init rejected: no-op under the Pulumi engine', {});
    return {
      started: false,
      error:
        'iac.init is not applicable when using the Pulumi engine — Pulumi resolves and ' +
        'installs its own engine automatically and has no separate init step. (Interim state ' +
        'pending Phase 10 of the migrate-iac-to-pulumi change, which replaces the wizard\'s ' +
        'init-dependent prerequisite step.)',
    };
  }

  /**
   * Kicks off a Pulumi preview (`terraform plan`'s successor) and streams its
   * output back to the renderer — pre-mints a `runId` since
   * `PulumiService.preview` needs one to name its saved plan artifact
   * directory.
   *
   * Checks `PulumiService.getOperationInFlight()` first: if a `preview`,
   * `up`, `destroy`, or `rollback` operation is already running against the
   * shared workspace, no run is attempted — the method resolves immediately
   * with `{ started: false, error, conflict: <in-flight op> }`. No chunk/end
   * messages are sent and no audit entry is recorded for a rejected
   * submission.
   *
   * Otherwise a `runId` is minted up front and handed to
   * `PulumiService.preview` as `preMintedRunId`, and the generator's first
   * step is driven synchronously (before anything is awaited) to reserve the
   * shared workspace — `PulumiService.preview`'s own `operationInFlight`
   * check-and-set runs before its own first `await`, so driving `.next()`
   * here with no intervening `await` closes the TOCTOU gap between the
   * `getOperationInFlight()` check above and this call. The `.catch()` below
   * only marks `firstStep` as handled so Node doesn't log an
   * unhandledRejection warning while it sits unawaited during the
   * `audit.record()` call further down — the streaming loop handles whatever
   * it actually settles to.
   *
   * Only once that reservation has happened is an audit entry
   * (`action: 'plan'`) recorded, and the streaming loop fired and forgotten;
   * the method resolves immediately with `{ started: true, runId }`, well before
   * the preview run itself settles. Every chunk/end message is tagged with
   * that same `runId`: each chunk is forwarded via `sender.send` on
   * {@link PLAN_CHUNK_CHANNEL} as `{ runId, chunk }`, and once the run
   * settles a single terminal message is sent on {@link PLAN_END_CHANNEL}:
   * `{ runId, exitCode: 0, result }` on success, or
   * `{ runId, exitCode: null, error }` on failure.
   *
   * Drives `PulumiService.preview`'s async generator manually via repeated
   * `.next()` calls (rather than `for await...of`) so the terminal
   * `PulumiPreviewResult` (the generator's return value) can be attached to
   * the end message's `result` field. If the `WebContents` is destroyed
   * mid-stream, the generator is explicitly finalized via `stream.return()`
   * so `PulumiService.preview`'s own force-closed-generator cleanup
   * (persisting a cancelled run record) still runs.
   *
   * Creates its own `AbortController` per invocation, registers it in
   * {@link activePlans} keyed by `runId` so a future cancel channel can reach
   * it, and passes its `signal` through to `PulumiService.preview`. A
   * `'destroyed'` listener on the `WebContents` aborts the controller the
   * instant the window/webview goes away.
   *
   * Reachable via the Electron IPC transport (`iac.plan`).
   */
  @MessagePattern('iac.plan')
  async plan(
    @Payload() payload: TerraformPlanPayload = {},
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformPlanAck> {
    const inFlight = this.pulumi.getOperationInFlight();
    if (inFlight) {
      const error =
        `terraform plan refused: ${inFlight} is already in flight; wait for it to finish ` +
        'before submitting another plan';
      logger.error('terraform plan rejected: workspace busy', { inFlight });
      return { started: false, error, conflict: inFlight };
    }

    const sender: WebContents = ctx.evt.sender;
    const runId = randomUUID();
    const ac = new AbortController();

    const stream = this.pulumi.preview(payload.tfvarsVersionId, ac.signal, runId, payload.rolledBackFrom);
    const firstStep = stream.next();
    firstStep.catch(() => { /* handled in the streaming loop below */ });

    this.activePlans.set(runId, ac);

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);
    const cleanup = () => {
      this.activePlans.delete(runId);
      sender.removeListener('destroyed', onDestroyed);
    };

    // Best-effort: AuditService.record() never throws (failures are logged
    // and swallowed internally), so awaiting it here cannot block or fail
    // this now-accepted submission's ack. `game`/`before`/`after` are the
    // fixed values the `game_servers`-shaped audit schema takes for a
    // workspace-wide `plan` action not scoped to a single game.
    await this.audit?.record({
      action: 'plan',
      game: '',
      before: null,
      after: null,
      ...(payload.tfvarsVersionId !== undefined ? { versionId: payload.tfvarsVersionId } : {}),
    });

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        let next = await firstStep;
        while (!next.done) {
          if (sender.isDestroyed()) {
            ac.abort();
            await stream.return(undefined);
            return;
          }
          const chunkMessage: TerraformPlanChunkMessage = { runId, chunk: next.value };
          sender.send(PLAN_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: TerraformPlanEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(PLAN_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform plan error', { err });
        if (!sender.isDestroyed()) {
          const message: TerraformPlanEndMessage = { runId, exitCode: null, error: String(err) };
          sender.send(PLAN_END_CHANNEL, message);
        }
      } finally {
        cleanup();
      }
    })();

    return { started: true, runId };
  }

  /**
   * Applies the approved plan run `payload.planRunId` and streams its output
   * back to the renderer — mirrors {@link plan}'s streaming shape.
   * `PulumiService.apply`'s gate is entirely self-contained: plan-record
   * lookup, approval/expiry checks, plan-hash verification (stored-hash
   * comparison and on-disk artifact re-hash), engine-version check, and the
   * durable apply-lock reservation all happen inside `PulumiService.apply`
   * itself.
   *
   * This controller does not reintroduce any of that gate's checks — it only
   * needs to know the gate is entirely synchronous-relative-to-yielding:
   * every gate step runs to completion before the generator's first `yield`
   * (the first real chunk of `stack.up()`'s output). So the first `.next()`
   * call on the returned generator either rejects (any gate-step failure —
   * `RunLockHeldError`, mapped below to `conflict: 'up'`; or
   * `PulumiOperationInFlightError`, mapped to its own in-flight operation
   * name, since the renderer's busy banner reads `ack.conflict` regardless
   * of which guard refused the submission) or resolves with the operation
   * genuinely under way. This method awaits that first `.next()` call before
   * acking, so `{ started: true, runId }` is only ever returned once the
   * gate has actually passed.
   *
   * Validates `payload` first (`planRunId`/`planHash` both non-empty
   * strings) — the only validation this controller performs itself;
   * everything else is the gate's job. A gate failure resolves
   * `{ started: false, error }` (plus `conflict` as above) without ever
   * touching {@link activeApplies} or recording an audit entry.
   *
   * Once the gate has passed, {@link activeApplies} is populated, a
   * `'destroyed'` listener is armed on the `WebContents`, a best-effort audit
   * entry (`action: 'apply'`) is recorded, and the (now partially-drained)
   * generator is driven to completion in a fire-and-forget streaming loop —
   * mirrors {@link plan}'s loop shape, starting from the already-resolved
   * first step. Each subsequent chunk is forwarded via `sender.send` on
   * {@link APPLY_CHUNK_CHANNEL} as `{ runId, chunk }`; once the run settles a
   * single terminal message is sent on {@link APPLY_END_CHANNEL} — see
   * {@link TerraformPlanEndMessage} for the `exitCode` convention.
   *
   * There is no `RunService.createRun`/`releaseRun` call anywhere in this
   * controller — `PulumiService.apply`'s own gate acquires the durable lock
   * and its own persistence path releases it on every settlement path,
   * including a force-closed generator.
   *
   * Creates its own `AbortController` per invocation and registers it in
   * {@link activeApplies} keyed by `runId`, the same reasoning as
   * {@link plan}.
   *
   * Reachable via the Electron IPC transport (`iac.apply`).
   */
  @MessagePattern('iac.apply')
  async apply(
    @Payload() payload: TerraformApplyPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformPlanAck> {
    const validationError = IacController.validateApplyPayload(payload);
    if (validationError) {
      logger.error('terraform apply rejected: invalid payload', { error: validationError });
      return { started: false, error: validationError };
    }

    const runId = payload.planRunId;
    const sender: WebContents = ctx.evt.sender;
    const ac = new AbortController();
    const stream = this.pulumi.apply(runId, payload.planHash, ac.signal);

    let first: Awaited<ReturnType<typeof stream.next>>;
    try {
      first = await stream.next();
    } catch (err) {
      if (err instanceof RunLockHeldError) {
        logger.error('terraform apply rejected: apply lock already held', { planRunId: payload.planRunId, lock: err.lock });
        return { started: false, error: err.message, conflict: 'up' };
      }
      if (err instanceof PulumiOperationInFlightError) {
        // Mirrors plan()'s pre-flight conflict shape: the in-process
        // operationInFlight mutex is a cheaper, earlier-checked guard than
        // the durable RunLockHeldError race above, but a busy refusal from
        // it must populate `conflict` the same way — the renderer's busy
        // banner (terraform.page.tsx) reads ack.conflict regardless of which
        // guard refused the submission.
        logger.error('terraform apply rejected: workspace busy', { planRunId: payload.planRunId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
      }
      if (err instanceof PulumiUnrecognizedLockError) {
        // stack.up() can hit an unrecognized backend lock conflict before
        // ever yielding a chunk — see the streaming loop's identical catch
        // below for the more common case where it surfaces after streaming
        // has already begun.
        logger.error('terraform apply rejected: unrecognized stale stack lock', {
          planRunId: payload.planRunId,
          stackName: err.stackName,
        });
        return { started: false, error: err.message, staleLock: serializeStaleLock(err) };
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('terraform apply rejected', { planRunId: payload.planRunId, error });
      return { started: false, error };
    }

    this.activeApplies.set(runId, ac);

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);
    const cleanup = () => {
      this.activeApplies.delete(runId);
      sender.removeListener('destroyed', onDestroyed);
    };

    // Best-effort: AuditService.record() never throws (failures are logged
    // and swallowed internally), so awaiting it here cannot block or fail
    // this now-accepted submission's ack. `game`/`before`/`after` are the
    // fixed values the `game_servers`-shaped audit schema takes for a
    // workspace-wide `apply` action not scoped to a single game. No
    // `versionId` is attached — this controller doesn't look up the plan
    // record itself (that's the gate's job now).
    await this.audit?.record({ action: 'apply', game: '', before: null, after: null });

    // Fire-and-forget the streaming loop, mirroring plan()'s shape — starts
    // from the already-resolved `first` step since this method awaited the
    // gate above before acking.
    void (async () => {
      try {
        let next = first;
        while (!next.done) {
          if (sender.isDestroyed()) {
            ac.abort();
            await stream.return(undefined);
            return;
          }
          const chunkMessage: TerraformApplyChunkMessage = { runId, chunk: next.value };
          sender.send(APPLY_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: TerraformApplyEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(APPLY_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform apply error', { err });
        if (!sender.isDestroyed()) {
          const message: TerraformApplyEndMessage = {
            runId,
            exitCode: null,
            error: String(err),
            staleLock: err instanceof PulumiUnrecognizedLockError ? serializeStaleLock(err) : undefined,
          };
          sender.send(APPLY_END_CHANNEL, message);
        }
      } finally {
        cleanup();
      }
    })();

    return { started: true, runId };
  }

  /**
   * Mints a fresh, short-lived destroy-confirmation token by delegating to
   * `PulumiService.mintDestroyConfirmationToken()` — the operator's
   * type-to-confirm dialog calls this the moment the confirmation phrase is
   * accepted, then submits the returned token to {@link destroy}'s payload
   * before it expires. Minting a new token invalidates any prior unconsumed
   * one, so only the most recently minted token can confirm a destroy.
   *
   * Needs no manual bridging — it resolves a single value, so the generic
   * `ipcMain.handle` bridge in `../ipc-main-bridge.ts` wires it
   * automatically.
   *
   * Reachable via the Electron IPC transport (`iac.destroy.mintToken`).
   */
  @MessagePattern('iac.destroy.mintToken')
  mintDestroyToken(): TerraformDestroyMintAck {
    return { token: this.pulumi.mintDestroyConfirmationToken() };
  }

  /**
   * Destroys the deployed stack and streams its output back to the renderer
   * — mirrors {@link apply}'s streaming/gate-awaiting shape, gated behind
   * `payload.confirmationToken` (minted via {@link mintDestroyToken}) instead
   * of a plan/approval lineage, since a destroy has no preceding plan to
   * inherit a `runId` from.
   *
   * Like {@link apply}, `PulumiService.destroy`'s gate is entirely
   * self-contained: the `operationInFlight` busy check, config-presence
   * checks, single-use confirmation-token consumption (synchronous, so a
   * same-token race is decided cleanly without touching `RunLockService`),
   * and the durable apply-lock reservation all happen before the generator's
   * first `yield`. This method awaits that first `.next()` call before
   * acking, exactly like {@link apply} — a gate failure
   * (`DestroyNotConfirmedError` for a missing/stale/already-consumed token,
   * `RunLockHeldError` mapped to `conflict: 'destroy'`, or
   * `PulumiOperationInFlightError` mapped to its own in-flight operation
   * name) resolves `{ started: false, error }` without touching
   * {@link activeDestroys} or recording an audit entry — and without burning
   * a token that an unrelated rejection shouldn't have consumed, since the
   * gate only consumes the token once its cheap, synchronous
   * config-presence checks have already passed.
   *
   * Validates only `payload.confirmationToken` is present — everything else
   * is the gate's job. Once the gate has passed, `runId` is minted fresh (a
   * destroy has no inherited id to reuse), {@link activeDestroys} is
   * populated, a `'destroyed'` listener is armed, a best-effort audit entry
   * (`action: 'destroy'`) is recorded, and the streaming loop is driven to
   * completion from the already-resolved first step — mirrors {@link apply}'s
   * loop shape. Each chunk is forwarded via `sender.send` on
   * {@link DESTROY_CHUNK_CHANNEL} as `{ runId, chunk }`; once the run settles
   * a single terminal message is sent on {@link DESTROY_END_CHANNEL},
   * mirroring {@link TerraformApplyEndMessage}'s `exitCode` convention.
   *
   * There is no `RunService.createRun`/`releaseRun` call anywhere in this
   * controller — `PulumiService.destroy`'s own gate and persistence path own
   * that entirely, mirroring {@link apply}.
   *
   * Creates its own `AbortController` per invocation and registers it in
   * {@link activeDestroys} keyed by `runId`, the same reasoning as
   * {@link apply}.
   *
   * Reachable via the Electron IPC transport (`iac.destroy`).
   */
  @MessagePattern('iac.destroy')
  async destroy(
    @Payload() payload: TerraformDestroyPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformPlanAck> {
    const validationError = IacController.validateDestroyPayload(payload);
    if (validationError) {
      logger.error('terraform destroy rejected: invalid payload', { error: validationError });
      return { started: false, error: validationError };
    }

    const runId = randomUUID();
    const sender: WebContents = ctx.evt.sender;
    const ac = new AbortController();
    const stream = this.pulumi.destroy(payload.confirmationToken, ac.signal, runId);

    let first: Awaited<ReturnType<typeof stream.next>>;
    try {
      first = await stream.next();
    } catch (err) {
      if (err instanceof RunLockHeldError) {
        logger.error('terraform destroy rejected: apply lock already held', { runId, lock: err.lock });
        return { started: false, error: err.message, conflict: 'destroy' };
      }
      if (err instanceof PulumiOperationInFlightError) {
        // Mirrors apply()'s equivalent branch — the in-process mutex needs
        // the same `conflict` treatment as the durable RunLockHeldError race
        // above.
        logger.error('terraform destroy rejected: workspace busy', { runId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
      }
      if (err instanceof PulumiUnrecognizedLockError) {
        // Mirrors apply()'s identical branch — can surface here, before any
        // streaming ever started, rather than only on the end-of-stream
        // catch below.
        logger.error('terraform destroy rejected: unrecognized stale stack lock', {
          runId,
          stackName: err.stackName,
        });
        return { started: false, error: err.message, staleLock: serializeStaleLock(err) };
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('terraform destroy rejected', { runId, error });
      return { started: false, error };
    }

    this.activeDestroys.set(runId, ac);

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);
    const cleanup = () => {
      this.activeDestroys.delete(runId);
      sender.removeListener('destroyed', onDestroyed);
    };

    // Best-effort: AuditService.record() never throws (failures are logged
    // and swallowed internally), mirrors apply()'s own audit-entry call.
    await this.audit?.record({ action: 'destroy', game: '', before: null, after: null });

    // Fire-and-forget the streaming loop, mirroring apply()'s shape.
    void (async () => {
      try {
        let next = first;
        while (!next.done) {
          if (sender.isDestroyed()) {
            ac.abort();
            await stream.return(undefined);
            return;
          }
          const chunkMessage: TerraformDestroyChunkMessage = { runId, chunk: next.value };
          sender.send(DESTROY_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: TerraformDestroyEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(DESTROY_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('terraform destroy error', { err });
        if (!sender.isDestroyed()) {
          const message: TerraformDestroyEndMessage = {
            runId,
            exitCode: null,
            error: String(err),
            staleLock: err instanceof PulumiUnrecognizedLockError ? serializeStaleLock(err) : undefined,
          };
          sender.send(DESTROY_END_CHANNEL, message);
        }
      } finally {
        cleanup();
      }
    })();

    return { started: true, runId };
  }

  /**
   * Returns the current stack outputs. Unlike {@link plan}, this channel
   * needs no manual bridging — it resolves a single value, so the generic
   * `ipcMain.handle` bridge in `../ipc-main-bridge.ts` wires
   * `ipcRenderer.invoke('iac.output', ...)` to this handler automatically.
   *
   * Returns `StackOutputs` (`@hyveon/shared`) — the same shape every other
   * controller in this codebase returns to the renderer (`GamesController`,
   * `DiscordController`, `CostsController`, `EnvController`, etc.). There is
   * no Pulumi analogue to a local `terraform.tfstate` file to read directly;
   * a Pulumi-orchestrated stack's state lives in the S3 backend.
   *
   * `payload.force` is accepted but ignored: it used to bypass
   * `TerraformService.output()`'s in-memory cache after an apply/destroy,
   * but that need is now handled automatically — `PulumiService.apply`/`.destroy`
   * both call `ConfigService.invalidateCache()` on a successful settlement,
   * so the next `getStackOutputs()` call after a real change already misses
   * its cache. The field is kept in {@link TerraformOutputPayload} rather
   * than removed, since dropping it would break any caller that still sends
   * it.
   *
   * Prefers `ConfigService.getStackOutputs()` (`this.config`) over calling
   * `PulumiService.getStackOutputs()` directly, since `ConfigService`'s own
   * delegate adds a request-coalescing cache on top — falls back to
   * `PulumiService.getStackOutputs()` directly only in the test-construction
   * path where `config` isn't supplied.
   *
   * Reachable via the Electron IPC transport (`iac.output`).
   */
  @MessagePattern('iac.output')
  async output(@Payload() payload: TerraformOutputPayload = {}): Promise<StackOutputs | null> {
    void payload;
    return this.config ? this.config.getStackOutputs() : this.pulumi.getStackOutputs();
  }

  /**
   * Approves a successful `plan` run for a later apply, delegating the
   * actual write to `RunRecordService.approveRun`.
   *
   * Validates `payload` first: `planRunId` must be a non-empty string. If
   * validation fails, neither `RunRecordService.approveRun` nor
   * `AuditService.record` is ever called and the method resolves immediately
   * with `{ approved: false, error }`.
   *
   * The approver identity is never taken from the client — it's resolved
   * server-side via {@link resolveApprover} (the local OS username), so an
   * IPC caller can't spoof who approved a run. `RunRecordService.approveRun`
   * is then awaited directly (unlike {@link plan}, there is no streaming
   * output to bridge — this resolves a single value):
   *
   * - On success, a best-effort `AuditService.record()` entry (action
   *   `'approve'`) is recorded — mirroring {@link plan}'s audit shape, this
   *   never throws and never blocks/fails the response — and the method
   *   resolves `{ approved: true, approvedBy, approvedAt }` with the values
   *   `RunRecordService.approveRun` stamped onto the persisted `RunRecord`.
   * - On failure (the run-history table isn't configured, no record exists
   *   for `planRunId`, the record isn't a `plan` run, or the record's status
   *   isn't `success`), the thrown error's `message` is surfaced as
   *   `{ approved: false, error }`. Nothing is written in this case.
   *
   * Reachable via the Electron IPC transport (`iac.approve`), bridged
   * automatically by the generic `ipcMain.handle` bridge in
   * `../ipc-main-bridge.ts`.
   */
  @MessagePattern('iac.approve')
  async approve(@Payload() payload: TerraformApprovePayload): Promise<TerraformApproveAck> {
    const validationError = IacController.validateApprovePayload(payload);
    if (validationError) {
      logger.error('terraform approve rejected: invalid payload', { error: validationError });
      return { approved: false, error: validationError };
    }

    if (!this.runRecord) {
      const error = 'iac.approve requires a configured RunRecordService';
      logger.error('terraform approve rejected: no RunRecordService available', { planRunId: payload.planRunId });
      return { approved: false, error };
    }

    try {
      const approvedBy = IacController.resolveApprover();
      const record = await this.runRecord.approveRun(payload.planRunId, approvedBy);

      // Best-effort: AuditService.record() never throws (failures are logged
      // and swallowed internally), mirroring the audit entry recorded by
      // plan() for its own accepted submissions.
      await this.audit?.record({
        action: 'approve',
        game: '',
        before: null,
        after: null,
      });

      return { approved: true, approvedBy: record.approvedBy, approvedAt: record.approvedAt };
    } catch (err) {
      logger.error('terraform approve error', { err, planRunId: payload.planRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { approved: false, error };
    }
  }

  /**
   * Previews the rollback flow's target configuration version for
   * `payload.applyRunId`, without writing anything — delegates to
   * `PulumiService.resolveRollbackTarget`. Called when the operator clicks
   * "Rollback" on an apply row in history, so the confirmation dialog can
   * name the version it would restore before the operator commits to it.
   *
   * Reachable via the Electron IPC transport (`iac.rollback.resolve`),
   * bridged automatically by the generic `ipcMain.handle` bridge since it
   * resolves a single value.
   */
  @MessagePattern('iac.rollback.resolve')
  async resolveRollback(@Payload() payload: TerraformRollbackPayload): Promise<TerraformRollbackResolveAck> {
    const validationError = IacController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('terraform rollback resolve rejected: invalid payload', { error: validationError });
      return { resolved: false, error: validationError };
    }

    try {
      const target = await this.pulumi.resolveRollbackTarget(payload.applyRunId);
      return { resolved: true, versionId: target.versionId, lastModified: target.lastModified.toISOString() };
    } catch (err) {
      logger.error('terraform rollback resolve error', { err, applyRunId: payload.applyRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { resolved: false, error };
    }
  }

  /**
   * Confirms the rollback flow for `payload.applyRunId`.
   *
   * `PulumiService.confirmRollback` fuses the historic-configuration restore
   * write and a follow-up plan into one guarded unit, held under the same
   * `operationInFlight` lock for its entire duration, as an `AsyncGenerator`
   * that streams a real plan run internally — the same shape as {@link plan}.
   * The renderer, however, still expects `iac.rollback.confirm` to resolve a
   * single `TerraformRollbackConfirmAck` and still submits a SEPARATE
   * `iac.plan` call afterwards to actually queue the plan the operator
   * watches. This method reconciles the two: it drives
   * `PulumiService.confirmRollback`'s generator to completion internally (a
   * manual `.next()` loop, mirroring {@link plan}'s manual-drive shape so
   * `PulumiPreviewResult` is reachable), forwarding every intermediate chunk
   * on {@link ROLLBACK_CONFIRM_CHUNK_CHANNEL} (no current subscriber), and
   * only resolves once the whole restore+plan unit has settled.
   *
   * **Known, accepted consequence**: because the renderer still submits its
   * own follow-up `iac.plan` call after a successful ack, and
   * `PulumiService.confirmRollback` also runs a real plan internally, a
   * successful rollback produces TWO `PulumiRunRecord`s tagged
   * `rolledBackFrom: applyRunId` — the internal one (whose `runId` is never
   * surfaced to the renderer) and the renderer-driven one the operator
   * actually sees and can approve/apply. This wastes a `pulumi preview`
   * invocation and leaves an orphaned run-history entry, but every rollback
   * still completes correctly. Fixing it means updating the renderer to
   * consume `confirmRollback`'s already-completed plan directly instead of
   * re-submitting one.
   *
   * The restored configuration version id
   * (`TerraformRollbackConfirmAck.versionId`) isn't a field of
   * `PulumiPreviewResult` (which describes the plan artifact, not the
   * configuration version it ran against) — it's recovered via
   * `PulumiService.readRunRecord(result.runId)` once the generator settles,
   * reading back the `PulumiRunRecord.tfvarsVersionId` that `PulumiService`
   * persisted for this run.
   *
   * Reachable via the Electron IPC transport (`iac.rollback.confirm`).
   * Despite resolving a single `TerraformRollbackConfirmAck`, this channel is
   * bridged manually by {@link onModuleInit}, not the generic
   * `ipcMain.handle` bridge — see that method's own TSDoc and
   * `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`: the `ctx: { evt }`
   * second parameter below is undecorated, exactly like
   * {@link plan}/{@link apply}/{@link destroy}, and the generic bridge cannot
   * supply it correctly through NestJS's transport layer.
   */
  @MessagePattern('iac.rollback.confirm')
  async confirmRollback(
    @Payload() payload: TerraformRollbackPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<TerraformRollbackConfirmAck> {
    const validationError = IacController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('terraform rollback confirm rejected: invalid payload', { error: validationError });
      return { confirmed: false, error: validationError };
    }

    const sender: WebContents = ctx.evt.sender;
    const ac = new AbortController();
    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);

    try {
      const stream = this.pulumi.confirmRollback(payload.applyRunId, ac.signal);
      let next = await stream.next();
      while (!next.done) {
        if (!sender.isDestroyed()) {
          const chunkMessage: TerraformRollbackConfirmChunkMessage = {
            applyRunId: payload.applyRunId,
            chunk: next.value,
          };
          sender.send(ROLLBACK_CONFIRM_CHUNK_CHANNEL, chunkMessage);
        }
        next = await stream.next();
      }

      const result = next.value;
      if (!result) {
        // The generator settled without a result and without throwing —
        // only reachable if `signal` aborted mid-run. Return a well-formed
        // "not confirmed" ack defensively rather than treating an
        // `undefined` result as success.
        return { confirmed: false, error: 'Rollback confirmation was aborted before it could complete.' };
      }

      const record = this.pulumi.readRunRecord(result.runId);
      const versionId = record?.tfvarsVersionId;
      if (!versionId) {
        // Should not happen — previewCore always writes tfvarsVersionId for
        // a successful plan run before returning. Defensive fallback so a
        // genuinely unexpected gap surfaces as a clear ack error rather than
        // a "confirmed" ack the renderer can't act on.
        logger.error('terraform rollback confirm: missing persisted tfvarsVersionId after a successful rollback plan', {
          applyRunId: payload.applyRunId,
          runId: result.runId,
        });
        return { confirmed: false, error: 'Rollback plan completed but its restored version id could not be recovered.' };
      }

      // Best-effort: AuditService.record() never throws, mirroring the audit
      // entries recorded by plan()/apply()/approve() — restoring a version
      // as a new head is consequential enough that it shouldn't be exempt
      // from the audit trail.
      await this.audit?.record({
        action: 'rollback',
        game: '',
        before: null,
        after: null,
        versionId,
      });

      return { confirmed: true, versionId };
    } catch (err) {
      logger.error('terraform rollback confirm error', { err, applyRunId: payload.applyRunId });
      if (err instanceof PulumiRollbackPlanFailedError) {
        // The restore write DID succeed — err.restoredVersionId is now the
        // new head — only the follow-up plan failed. Surface it
        // programmatically (not just in err.message's prose) so a caller can
        // act on it, e.g. offer "plan against the restored version" next.
        return { confirmed: false, versionId: err.restoredVersionId, error: err.message };
      }
      const error = err instanceof Error ? err.message : String(err);
      return { confirmed: false, error };
    } finally {
      sender.removeListener('destroyed', onDestroyed);
    }
  }

  /**
   * Resolves the identity of the local operator approving a plan run, as the
   * OS username reported by `node:os`'s `userInfo()`. Wrapped in its own
   * method (rather than calling `os.userInfo().username` inline in
   * {@link approve}) so it's a single, stubbable seam for tests — and so the
   * approver identity is always derived server-side, never trusted from a
   * client-supplied field.
   */
  private static resolveApprover(): string {
    return os.userInfo().username;
  }

  /**
   * Validates that `config.bucket`, `config.region`, and
   * `config.dynamodbTable` are all non-empty strings. Returns a descriptive
   * error message when validation fails, or `null` when `config` is valid.
   */
  private static validateConfig(config: TerraformInitConfig): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (
      !isNonEmptyString(config?.bucket) ||
      !isNonEmptyString(config?.region) ||
      !isNonEmptyString(config?.dynamodbTable)
    ) {
      return 'iac.init requires non-empty bucket, region, and dynamodbTable strings';
    }
    return null;
  }

  /**
   * Validates that `payload.planRunId` is a non-empty string. Returns a
   * descriptive error message when validation fails, or `null` when
   * `payload` is valid.
   */
  private static validateApprovePayload(payload: TerraformApprovePayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.planRunId)) {
      return 'iac.approve requires a non-empty planRunId string';
    }
    return null;
  }

  /**
   * Validates that `payload.confirmationToken` is a non-empty string.
   * Returns a descriptive error message when validation fails, or `null`
   * when `payload` is valid.
   */
  private static validateDestroyPayload(payload: TerraformDestroyPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.confirmationToken)) {
      return 'iac.destroy requires a non-empty confirmationToken string';
    }
    return null;
  }

  /**
   * Validates that `payload.applyRunId` is a non-empty string. Returns a
   * descriptive error message when validation fails, or `null` when
   * `payload` is valid. Shared by {@link resolveRollback} and
   * {@link confirmRollback} — both key off the same field.
   */
  private static validateRollbackPayload(payload: TerraformRollbackPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.applyRunId)) {
      return 'iac.rollback requires a non-empty applyRunId string';
    }
    return null;
  }

  /**
   * Validates that `payload.planRunId` and `payload.planHash` are both
   * non-empty strings. Returns a descriptive error message when validation
   * fails, or `null` when `payload` is valid.
   */
  private static validateApplyPayload(payload: TerraformApplyPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.planRunId) || !isNonEmptyString(payload?.planHash)) {
      return 'iac.apply requires non-empty planRunId and planHash strings';
    }
    return null;
  }
}
