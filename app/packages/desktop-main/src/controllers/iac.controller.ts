import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { RunLockHeldError } from '@hyveon/shared';
import type { DeploymentConfigDiff, RunLock, StackOutputs } from '@hyveon/shared';
import {
  PulumiService,
  PulumiOperationInFlightError,
  PulumiRollbackPlanFailedError,
  PulumiStackInitializationError,
  type PulumiRunChunk,
  type PulumiPreviewResult,
  type PulumiUpResult,
  type PulumiDestroyResult,
} from '../services/PulumiService.js';
import type { PulumiPhaseCallback, PulumiProvisioningPhase, PulumiPhaseStatus } from '../services/PulumiEngineService.js';
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
 * Fixed side-channel {@link IacController.confirmRollback} pushes streamed
 * rollback-plan output on. `PulumiService.confirmRollback` is an
 * `AsyncGenerator` that streams a real plan run internally (the
 * restore-then-plan "one guarded unit" design — see that method's own
 * TSDoc). Nothing subscribes to this channel yet — the renderer's
 * `RollbackAction` component still only awaits `confirmRollback`'s resolved
 * ack (see that method's own TSDoc, "Streaming vs. the renderer's existing
 * one-shot contract") — but the plumbing exists so a long-running
 * restore+plan isn't a total black box for a future caller that wants to
 * watch it live, mirroring {@link PLAN_CHUNK_CHANNEL}'s shape exactly.
 */
const ROLLBACK_CONFIRM_CHUNK_CHANNEL = 'iac.rollback.confirm.chunk';

/** Fixed side-channel `IacController.initializeStack` pushes streamed phase events on. */
const STACK_INIT_CHUNK_CHANNEL = 'iac.stack.initialize.chunk';

/** Fixed side-channel `IacController.initializeStack` sends its terminal message on. */
const STACK_INIT_END_CHANNEL = 'iac.stack.initialize.end';

/**
 * Immediate acknowledgement `initializeStack()` resolves with. `started: true`
 * means `PulumiService.initializeStack` was kicked off in the background —
 * phase-event/end messages will follow on {@link STACK_INIT_CHUNK_CHANNEL}/
 * {@link STACK_INIT_END_CHANNEL}, tagged with `streamId`. `started: false`
 * means the shared workspace was already busy (`conflict` names whichever of
 * `preview`/`up`/`destroy`/`rollback` was running) — no run was attempted and
 * `streamId` is omitted.
 */
interface StackInitializeAck {
  started: boolean;
  streamId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
}

/**
 * Message payload sent, in order, on {@link STACK_INIT_CHUNK_CHANNEL} for
 * every `onPhase(phase, status)` call `PulumiService.initializeStack` makes.
 * `streamId` ties the event back to the `initializeStack()` call that
 * produced it — the same id already handed back in
 * {@link StackInitializeAck.streamId} — mirrors {@link IacPlanChunkMessage}.
 */
interface StackInitializePhaseMessage {
  streamId: string;
  phase: PulumiProvisioningPhase;
  status: PulumiPhaseStatus;
}

/**
 * Message payload sent once on {@link STACK_INIT_END_CHANNEL} when an
 * `iac.stack.initialize` run finishes. `error` is present only on a failed
 * run.
 *
 * Deliberately carries no separate structured `failedPhase` field — see
 * {@link IacController.initializeStack}'s own TSDoc, "Why no structured
 * `failedPhase` field", for why that data can't reliably reach the renderer
 * over this path. `error` already names the failed phase in prose — see
 * `PulumiStackInitializationError`'s own message format
 * (`PulumiService.ts`) — which is sufficient for the operator-facing error
 * text, and the renderer independently derives the same phase attribution
 * from the {@link STACK_INIT_CHUNK_CHANNEL} event stream itself (the phase
 * whose `'start'` never got a matching successful `'end'`), which is both
 * reliable (plain data, unlike a thrown error's custom properties) and
 * already correct.
 */
interface StackInitializeEndMessage {
  streamId: string;
  error?: string;
}

/**
 * Payload accepted by {@link IacController.output}. `force` is kept
 * for backward payload compatibility with the preload/renderer contract —
 * see {@link IacController.output}'s own TSDoc for why it's now
 * ignored rather than removed.
 */
interface IacOutputPayload {
  force?: boolean;
}

/**
 * Payload accepted by {@link IacController.plan}. `configVersionId`,
 * when the configured configuration source is S3-backed, is forwarded
 * verbatim to `PulumiService.preview`'s pre-spawn staleness check against
 * the current head version of the configuration object. `rolledBackFrom`,
 * when supplied by the rollback flow (#112), is stamped onto the resulting
 * plan's `PulumiRunRecord` so history can tag it as a rollback of that
 * `runId`.
 */
interface IacPlanPayload {
  configVersionId?: string;
  rolledBackFrom?: string;
}

/**
 * Message payload sent, in order, on {@link PLAN_CHUNK_CHANNEL} for every
 * chunk `PulumiService.preview` yields. `runId` ties the chunk back to the
 * `plan()` call that produced it — the same id already handed back in
 * {@link IacPlanAck.runId} — so the renderer (and a second, rejected
 * concurrent call) can never mix up output from two overlapping runs.
 */
interface IacPlanChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link PLAN_END_CHANNEL} when a
 * `iac.plan` run finishes. `exitCode` is `0` on success, or `null` on
 * failure — the Automation API has no process exit code, so `null`
 * uniformly means "did not succeed" here, rather than trying to recover a
 * synthetic non-zero number. `result` is
 * present only on a successful run — the structured `changeSummary` and
 * artifact/hash/engine-version fields `PulumiService.preview` resolved.
 */
interface IacPlanEndMessage {
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
 * `error`'s prose; {@link IacController.clearStaleLock} is the write path
 * that clears the lock once the operator confirms.
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
 * Result the `iac.lock.clear` IPC channel resolves with.
 * `cleared: true` means `PulumiService.clearStaleLock`
 * successfully called `stack.cancel()` against the Pulumi backend — the
 * operator should now resubmit their original plan/apply/destroy via the
 * normal button; this channel never re-attempts it automatically (see that
 * method's own TSDoc, "Does not retry"). `cleared: false` means nothing was
 * cleared — either another operation was already running against the shared
 * workspace (`PulumiOperationInFlightError`), the backend isn't configured
 * yet, or the clear attempt itself failed (`PulumiLockClearError`) — `error`
 * is always a human-readable description of why.
 */
interface IacLockClearAck {
  cleared: boolean;
  error?: string;
}

/**
 * Result {@link IacController.mintLockClearToken} resolves with — delegates
 * directly to `PulumiService.mintLockClearConfirmationToken()`, which the
 * operator must then supply back on {@link IacController.clearStaleLock}'s
 * payload within its short expiry window. Mirrors {@link IacDestroyMintAck}.
 */
interface IacLockClearMintAck {
  token: string;
}

/**
 * Payload accepted by {@link IacController.clearStaleLock}. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by {@link IacController.mintLockClearToken} — enforced
 * server-side by `PulumiService.clearStaleLock`'s own token gate (see
 * `LockClearNotConfirmedError`).
 *
 * Mirrors `IacLockClearPayload` in
 * `@hyveon/desktop-preload/src/hyveon-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface IacLockClearPayload {
  confirmationToken: string;
}

/**
 * Immediate acknowledgement `plan()` resolves with. `started: true` means a
 * `runId` was pre-minted and the streaming loop was kicked off in the
 * background (chunk/end messages will follow on the side channels, tagged
 * with that same `runId`). `started: false` means the submission was
 * rejected before any `PulumiService.preview` run was attempted and no
 * `runId` is present — `error` is a human-readable description of why, and
 * `conflict` additionally names the already-running operation
 * (`preview`/`up`/`destroy`/`rollback`) when the rejection was specifically
 * because the shared workspace was busy (see
 * `PulumiService.getOperationInFlight()`). `staleLock` is present instead of
 * `conflict` when the rejection was `PulumiUnrecognizedLockError` (an
 * `apply`/`destroy` gate-step failure whose lock conflict couldn't be proven
 * to be this installation's own orphaned run) — see {@link StaleLockInfo}.
 */
interface IacPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
  staleLock?: StaleLockInfo;
  /**
   * The durable apply lock currently held by another run, present only when
   * the rejection was `RunLockHeldError` (as opposed to a
   * `PulumiOperationInFlightError` busy refusal, which populates `conflict`
   * identically but has no lock to attach — that flag means *this* process
   * is busy right now). Lets the renderer offer a "Clear lock and retry"
   * action only for the genuinely clearable case.
   */
  runLock?: RunLock;
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
interface IacApprovePayload {
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
interface IacApproveAck {
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
interface IacRollbackPayload {
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
 *
 * `diff` is a best-effort addition (the `iac-rollback` spec's SHOULD
 * requirement): populated with `PulumiService.computeRollbackDiff`'s result
 * when `resolved: true` AND the diff could be computed, omitted otherwise —
 * either because resolution itself failed (`resolved: false`) or because the
 * diff computation specifically failed (network error, unparseable
 * configuration JSON, missing current head). A missing `diff` on a
 * `resolved: true` result is NOT an error condition; the confirmation dialog
 * must render normally without it (see `RollbackAction`'s own doc comment).
 */
interface IacRollbackResolveAck {
  resolved: boolean;
  versionId?: string;
  lastModified?: string;
  diff?: DeploymentConfigDiff;
  error?: string;
}

/**
 * Result `confirmRollback()` resolves with. `confirmed: true` means the
 * historic configuration content was restored as a new head version AND the
 * follow-up plan `PulumiService.confirmRollback` runs against it internally
 * completed successfully — `versionId` is the restored version's id, ready
 * to pass to `iac.plan`'s `configVersionId` (alongside
 * `rolledBackFrom: applyRunId`) for a renderer that still drives the
 * existing two-call flow (see {@link IacController.confirmRollback}'s
 * own TSDoc, "Streaming vs. the renderer's existing one-shot contract").
 * `confirmed: false` means no write was attempted, or a write was attempted
 * and the restore-then-plan unit failed partway through — `error` is always
 * a human-readable description of why. `versionId` is ALSO populated on a
 * `confirmed: false` ack specifically when the failure is
 * `PulumiRollbackPlanFailedError` (the restore write succeeded but the
 * follow-up plan didn't) — it names the version that was actually restored
 * as the new head despite the ack reporting failure, so a caller can act on
 * it (e.g. offer "plan against the restored version" as a next step) instead
 * of only reading it out of `error`'s prose.
 */
interface IacRollbackConfirmAck {
  confirmed: boolean;
  versionId?: string;
  error?: string;
}

/**
 * Message payload sent, in order, on {@link ROLLBACK_CONFIRM_CHUNK_CHANNEL}
 * for every chunk the plan run inside `PulumiService.confirmRollback` yields.
 * `applyRunId` ties the chunk back to the `confirmRollback()` call that
 * produced it, mirroring {@link IacPlanChunkMessage}.
 */
interface IacRollbackConfirmChunkMessage {
  applyRunId: string;
  chunk: PulumiRunChunk;
}

/**
 * Payload accepted by {@link IacController.apply}. `planRunId`
 * identifies the approved `plan` run to apply — also reused, unchanged, as
 * the apply run's own `runId` (see `PulumiService.apply`'s TSDoc, "run id").
 * `planHash` is the caller's expected plan hash, checked against the plan
 * run's stored `planHash` by `PulumiService.apply`'s own self-contained
 * gate — this controller does not re-derive or pre-check any of that
 * itself; see {@link apply}'s own TSDoc.
 *
 * Mirrors `IacApplyPayload` in
 * `@hyveon/desktop-preload/src/hyveon-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface IacApplyPayload {
  planRunId: string;
  planHash: string;
}

/**
 * Message payload sent, in order, on {@link APPLY_CHUNK_CHANNEL} for every
 * chunk `PulumiService.apply` yields. `runId` ties the chunk back to the
 * `apply()` call that produced it — the same id already handed back in the
 * ack `IacController.apply` resolves — mirrors
 * {@link IacPlanChunkMessage}.
 */
interface IacApplyChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link APPLY_END_CHANNEL} when a
 * `iac.apply` run finishes. `exitCode` is `0` on success, or `null` on
 * failure — see {@link IacPlanEndMessage}'s doc comment for why there
 * is no real numeric exit code to report under the Pulumi Automation API.
 * `result` is present only on a successful run. `staleLock` is present when
 * the failure was `PulumiUnrecognizedLockError` — see {@link StaleLockInfo}.
 * Unlike {@link IacPlanAck}, `PulumiUnrecognizedLockError` can surface
 * here (rather than on the immediate ack) because `stack.up()`'s lock
 * conflict is only discovered once the operation has already been streaming.
 */
interface IacApplyEndMessage {
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
interface IacDestroyMintAck {
  token: string;
}

/**
 * Payload accepted by {@link IacController.destroy}. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by {@link IacController.mintDestroyToken} — enforced
 * server-side by `PulumiService.destroy`'s own token gate (see
 * `DestroyNotConfirmedError`).
 *
 * Mirrors `IacDestroyPayload` in
 * `@hyveon/desktop-preload/src/hyveon-api.ts` — keep this shape in sync with
 * that sibling contract.
 */
interface IacDestroyPayload {
  confirmationToken: string;
}

/**
 * Message payload sent, in order, on {@link DESTROY_CHUNK_CHANNEL} for every
 * chunk `PulumiService.destroy` yields. `runId` ties the chunk back to the
 * `destroy()` call that produced it — the same id already handed back in the
 * ack `IacController.destroy` resolves — mirrors
 * {@link IacApplyChunkMessage}.
 */
interface IacDestroyChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link DESTROY_END_CHANNEL} when a
 * `iac.destroy` run finishes. `exitCode` is `0` on success, or `null`
 * on failure — see {@link IacPlanEndMessage}'s doc comment for why.
 * `result` is present only on a successful run. `staleLock` is present when
 * the failure was `PulumiUnrecognizedLockError` — see
 * {@link IacApplyEndMessage}'s identical field for why this surfaces
 * here rather than on the immediate ack.
 */
interface IacDestroyEndMessage {
  runId: string;
  exitCode: number | null;
  staleLock?: StaleLockInfo;
  error?: string;
  result?: PulumiDestroyResult;
}

/**
 * IPC-only Iac controller. Handles Electron main-process messages via `@MessagePattern` — no
 * HTTP routes are registered here. Every orchestration call site delegates to `PulumiService`.
 *
 * {@link plan} bridges `PulumiService.preview`'s async-generator output onto the fixed
 * `iac.plan.chunk`/`iac.plan.end` side channels. {@link apply} and {@link destroy} mirror that
 * streaming shape but delegate their entire pre-flight gate (plan-hash/approval/lock checks) to
 * `PulumiService.apply`/`.destroy`, which are self-contained — this controller performs none of
 * that bookkeeping itself. See each method's own TSDoc for specifics.
 */
@Controller()
export class IacController implements OnModuleInit {
  /**
   * `audit`/`runRecord`/`config` are typed optional (`?`) so existing test call sites that
   * construct `new IacController(pulumi)` directly (bypassing Nest's DI container) keep
   * compiling without stubbing them — a real bootstrap through `AppModule` always resolves
   * concrete instances.
   *
   * No `RunService` dependency: `PulumiService.apply`/`.destroy`'s self-contained gates acquire
   * and release the durable apply lock entirely internally.
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
   * Registers an `ipcMain.handle` bridge for the streaming channels (`iac.plan`, `iac.apply`,
   * `iac.destroy`, `iac.rollback.confirm`, `iac.stack.initialize`) after the Nest module
   * initializes.
   *
   * @remarks
   * `@MessagePattern(...)` only wires the transport's internal dispatcher — it does **not** call
   * `ipcMain.handle`, so `ipcRenderer.invoke` would otherwise hang. These five channels are
   * excluded from the generic bridge in `../ipc-main-bridge.ts` (`SELF_BRIDGED_PATTERNS`) because
   * each pushes follow-up chunk/end messages over side channels rather than resolving a single
   * value; `iac.rollback.confirm` additionally needs manual bridging because its undecorated
   * `ctx: { evt }` parameter would otherwise be dropped by NestJS's `RpcContextCreator`, which
   * sizes `initialArgs` to the one decorated parameter it sees.
   *
   * Only runs inside a real Electron main process — `process.versions.electron` is undefined in
   * plain-Node runtimes (integration test server, Docker, CI), so the bridge is skipped entirely.
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
    ipcMain.handle('iac.plan', (evt, payload: IacPlanPayload) =>
      this.plan(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.apply` streams chunk/end messages the same way
    // `iac.plan` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason.
    ipcMain.removeHandler('iac.apply');
    ipcMain.handle('iac.apply', (evt, payload: IacApplyPayload) =>
      this.apply(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.destroy` streams chunk/end messages the same way
    // `iac.apply` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason. `iac.destroy.mintToken` needs no such bridging
    // (it resolves a single value), so the generic bridge wires it
    // automatically — no entry here.
    ipcMain.removeHandler('iac.destroy');
    ipcMain.handle('iac.destroy', (evt, payload: IacDestroyPayload) =>
      this.destroy(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.rollback.confirm` streams chunk messages the same way
    // `iac.destroy` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason (see this method's own TSDoc for why the undecorated
    // `ctx` parameter needs manual bridging).
    ipcMain.removeHandler('iac.rollback.confirm');
    ipcMain.handle('iac.rollback.confirm', (evt, payload: IacRollbackPayload) =>
      this.confirmRollback(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.stack.initialize` streams phase-event/end messages the same way
    // `iac.plan` streams chunk/end messages — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason.
    ipcMain.removeHandler('iac.stack.initialize');
    ipcMain.handle('iac.stack.initialize', (evt, payload: unknown) =>
      this.initializeStack(payload, { evt: evt as IpcMainInvokeEvent }),
    );
  }

  /**
   * Replacement for the `iac.init` channel — Pulumi has no one-shot CLI init analogue, so this
   * streams `PulumiService.initializeStack`'s phase-by-phase provisioning instead. Mints a
   * `streamId` and pushes every `onPhase` event on {@link STACK_INIT_CHUNK_CHANNEL}; a single
   * terminal message follows on {@link STACK_INIT_END_CHANNEL}.
   *
   * @remarks
   * ## Why no structured `failedPhase` field
   *
   * `StackInitializeEndMessage` deliberately carries no structured `failedPhase` field.
   * Electron's contextBridge uses the same structured-clone algorithm as `structuredClone()`,
   * which preserves only `name`/`message`/`stack` on a thrown `Error` — custom own properties
   * like `.phase` do not survive the crossing to the renderer. The renderer instead derives the
   * same phase attribution independently from the {@link STACK_INIT_CHUNK_CHANNEL} event stream
   * itself (plain data, proven to cross correctly).
   *
   * Reachable via the Electron IPC transport (`iac.stack.initialize`); self-bridged — see
   * {@link onModuleInit}.
   */
  @MessagePattern('iac.stack.initialize')
  async initializeStack(
    @Payload() _payload: unknown,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<StackInitializeAck> {
    logger.debug('IacController: iac.stack.initialize invoked');
    const inFlight = this.pulumi.getOperationInFlight();
    if (inFlight) {
      const error =
        `stack initialization refused: ${inFlight} is already in flight; wait for it to finish ` +
        'before starting another operation';
      logger.error('stack initialization rejected: workspace busy', { inFlight });
      return { started: false, error, conflict: inFlight };
    }

    const sender: WebContents = ctx.evt.sender;
    const streamId = randomUUID();
    const onPhase: PulumiPhaseCallback = (phase, status) => {
      // Logged before the `isDestroyed()` check so this phase transition is
      // still written to the daily log file even if the renderer window has
      // already closed — the whole point of this line is server-side
      // traceability, independent of whether the renderer is still around to
      // receive the corresponding chunk message below.
      logger.debug('iac.stack.initialize phase transition', { streamId, phase, status });
      if (sender.isDestroyed()) return;
      const message: StackInitializePhaseMessage = { streamId, phase, status };
      sender.send(STACK_INIT_CHUNK_CHANNEL, message);
    };

    // No `await` between the busy check above and this call — see this
    // method's own TSDoc for why that closes the same TOCTOU gap `plan()`'s
    // identical comment explains.
    const promise = this.pulumi.initializeStack(onPhase);

    void promise
      .then(() => {
        if (!sender.isDestroyed()) {
          const message: StackInitializeEndMessage = { streamId };
          sender.send(STACK_INIT_END_CHANNEL, message);
        }
      })
      .catch((err: unknown) => {
        // Logged server-side with the structured `phase` field intact
        // (never crosses the contextBridge, so no cloning concern applies
        // here — see this method's own TSDoc, "Why no structured
        // `failedPhase` field", for why the *renderer-facing* message below
        // deliberately doesn't try to carry the same field).
        logger.error('stack initialization error', {
          err,
          failedPhase: err instanceof PulumiStackInitializationError ? err.phase : undefined,
        });
        if (!sender.isDestroyed()) {
          const message: StackInitializeEndMessage = {
            streamId,
            error: err instanceof Error ? err.message : String(err),
          };
          sender.send(STACK_INIT_END_CHANNEL, message);
        }
      });

    return { started: true, streamId };
  }

  /**
   * Kicks off a Pulumi preview and streams its output back to the renderer — pre-mints a
   * `runId` since `PulumiService.preview` needs one to name its saved plan artifact directory.
   *
   * @remarks
   * The generator's first step is driven synchronously, with no `await` between the
   * `getOperationInFlight()` check above and the call to `this.pulumi.preview(...)` — this
   * closes the TOCTOU gap a busy-workspace check would otherwise leave open, because
   * `preview`'s own `operationInFlight` check-and-set also runs synchronously, before its own
   * first `await`.
   *
   * Drives the generator manually via repeated `.next()` calls rather than `for await...of` so
   * the terminal `PulumiPreviewResult` (the generator's return value once `done`) can be
   * attached to the end message's `result` field — a `for await` loop discards that value.
   *
   */
  @MessagePattern('iac.plan')
  async plan(
    @Payload() payload: IacPlanPayload = {},
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<IacPlanAck> {
    logger.debug('IacController: iac.plan invoked');
    const inFlight = this.pulumi.getOperationInFlight();
    if (inFlight) {
      const error =
        `plan refused: ${inFlight} is already in flight; wait for it to finish ` +
        'before submitting another plan';
      logger.error('plan rejected: workspace busy', { inFlight });
      return { started: false, error, conflict: inFlight };
    }

    const sender: WebContents = ctx.evt.sender;
    const runId = randomUUID();
    const ac = new AbortController();

    const stream = this.pulumi.preview(payload.configVersionId, ac.signal, runId, payload.rolledBackFrom);
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
    // workspace-wide `plan` action that isn't scoped to a single game. By
    // this point the workspace reservation above has already succeeded, so
    // this audit entry is only ever recorded for a submission that really
    // did start a run.
    await this.audit?.record({
      action: 'plan',
      game: '',
      before: null,
      after: null,
      ...(payload.configVersionId !== undefined ? { versionId: payload.configVersionId } : {}),
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
          const chunkMessage: IacPlanChunkMessage = { runId, chunk: next.value };
          sender.send(PLAN_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: IacPlanEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(PLAN_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('plan error', { err });
        if (!sender.isDestroyed()) {
          const message: IacPlanEndMessage = { runId, exitCode: null, error: String(err) };
          sender.send(PLAN_END_CHANNEL, message);
        }
      } finally {
        cleanup();
      }
    })();

    return { started: true, runId };
  }

  /**
   * Applies the approved plan run `payload.planRunId` and streams its output back to the
   * renderer — mirrors {@link plan}'s streaming shape, but the gate underneath is different:
   * `PulumiService.apply`'s entire 8-step gate (plan-record lookup, approval/expiry checks,
   * plan-hash verification, engine-version check, durable apply-lock reservation) runs to
   * completion before the generator's first `yield`.
   *
   * @remarks
   * Because the gate runs to completion before the first `yield`, this method awaits the
   * generator's first `.next()` call BEFORE acking — `{ started: true, runId }` is only ever
   * returned once the gate has actually passed. A gate-step failure (rejection) is caught and
   * mapped to `{ started: false, error, conflict? }` without ever populating
   * {@link activeApplies} or recording an audit entry.
   *
   * There is no `RunService.createRun`/`releaseRun` call anywhere in this controller —
   * `PulumiService.apply`'s own gate and persistence path own the durable lock's full lifecycle.
   *
   */
  @MessagePattern('iac.apply')
  async apply(
    @Payload() payload: IacApplyPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<IacPlanAck> {
    logger.debug('IacController: iac.apply invoked');
    const validationError = IacController.validateApplyPayload(payload);
    if (validationError) {
      logger.error('apply rejected: invalid payload', { error: validationError });
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
        logger.error('apply rejected: apply lock already held', { planRunId: payload.planRunId, lock: err.lock });
        return { started: false, error: err.message, conflict: 'up', runLock: err.lock };
      }
      if (err instanceof PulumiOperationInFlightError) {
        // Mirrors plan()'s pre-flight conflict shape: the in-process
        // operationInFlight mutex is a cheaper, earlier-checked guard than
        // the durable RunLockHeldError race above, but a busy refusal from it
        // must populate `conflict` exactly the same way — the renderer's
        // busy banner (iac.page.tsx) reads ack.conflict regardless of
        // which of the two guards refused the submission.
        logger.error('apply rejected: workspace busy', { planRunId: payload.planRunId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
      }
      if (err instanceof PulumiUnrecognizedLockError) {
        // stack.up() can hit an unrecognized backend lock conflict before
        // ever yielding a chunk (the gate steps above this catch never
        // throw this error — it's raised inside attemptUp() itself, only
        // once operationSettled) — see the streaming loop's identical catch
        // below for the more common case where it surfaces after streaming
        // has already begun.
        logger.error('apply rejected: unrecognized stale stack lock', {
          planRunId: payload.planRunId,
          stackName: err.stackName,
        });
        return { started: false, error: err.message, staleLock: serializeStaleLock(err) };
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('apply rejected', { planRunId: payload.planRunId, error });
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
    // workspace-wide `apply` action that isn't scoped to a single game. No
    // `versionId` is attached — this controller doesn't look up the plan
    // record itself (that's the gate's job), so it has nothing extra worth a
    // second redundant `getByRunId` call purely for audit metadata.
    await this.audit?.record({ action: 'apply', game: '', before: null, after: null });

    // Fire-and-forget the streaming loop, mirroring plan()'s shape — starts
    // from the already-resolved `first` step instead of an unawaited one,
    // since this method awaited the gate above before acking.
    void (async () => {
      try {
        let next = first;
        while (!next.done) {
          if (sender.isDestroyed()) {
            ac.abort();
            await stream.return(undefined);
            return;
          }
          const chunkMessage: IacApplyChunkMessage = { runId, chunk: next.value };
          sender.send(APPLY_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: IacApplyEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(APPLY_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('apply error', { err });
        if (!sender.isDestroyed()) {
          const message: IacApplyEndMessage = {
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
   * accepted, then submits the returned token straight through to
   * {@link destroy}'s payload before it expires. Minting a new token
   * supersedes (invalidates) any prior unconsumed one, so only the most
   * recently minted token can ever confirm a destroy.
   *
   * Needs no manual bridging — it resolves a single value rather than
   * streaming progress, so the generic `ipcMain.handle` bridge in
   * `../ipc-main-bridge.ts` wires it automatically (it isn't listed in
   * `SELF_BRIDGED_PATTERNS`).
   *
   */
  @MessagePattern('iac.destroy.mintToken')
  mintDestroyToken(): IacDestroyMintAck {
    logger.debug('IacController: iac.destroy.mintToken invoked');
    return { token: this.pulumi.mintDestroyConfirmationToken() };
  }

  /**
   * Mints a fresh, single-use confirmation token the renderer must supply
   * back on {@link clearStaleLock}'s payload before it expires — mirrors
   * {@link mintDestroyToken} exactly, for the lock-clear confirmation gate.
   *
   */
  @MessagePattern('iac.lock.clear.mintToken')
  mintLockClearToken(): IacLockClearMintAck {
    logger.debug('IacController: iac.lock.clear.mintToken invoked');
    return { token: this.pulumi.mintLockClearConfirmationToken() };
  }

  /**
   * Destroys the deployed stack and streams its output back to the renderer — mirrors
   * {@link apply}'s streaming/gate-awaiting shape, gated behind `payload.confirmationToken`
   * (minted via {@link mintDestroyToken}) instead of a plan/approval lineage.
   *
   * @remarks
   * `PulumiService.destroy`'s gate consumes (invalidates) the confirmation token only after its
   * cheap, synchronous config-presence checks have already passed — so a genuinely concurrent,
   * unrelated rejection (e.g. `RunLockHeldError`) never burns a token that an invalid request
   * would otherwise waste.
   *
   */
  @MessagePattern('iac.destroy')
  async destroy(
    @Payload() payload: IacDestroyPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<IacPlanAck> {
    logger.debug('IacController: iac.destroy invoked');
    const validationError = IacController.validateDestroyPayload(payload);
    if (validationError) {
      logger.error('destroy rejected: invalid payload', { error: validationError });
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
        logger.error('destroy rejected: apply lock already held', { runId, lock: err.lock });
        return { started: false, error: err.message, conflict: 'destroy', runLock: err.lock };
      }
      if (err instanceof PulumiOperationInFlightError) {
        // Mirrors apply()'s equivalent branch — see that catch block's
        // comment for why the in-process mutex needs the same `conflict`
        // treatment as the durable RunLockHeldError race above.
        logger.error('destroy rejected: workspace busy', { runId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
      }
      if (err instanceof PulumiUnrecognizedLockError) {
        // Mirrors apply()'s identical branch — see that catch block's
        // comment for why this can surface here, before any streaming ever
        // started, rather than only on the end-of-stream catch below.
        logger.error('destroy rejected: unrecognized stale stack lock', {
          runId,
          stackName: err.stackName,
        });
        return { started: false, error: err.message, staleLock: serializeStaleLock(err) };
      }
      const error = err instanceof Error ? err.message : String(err);
      logger.error('destroy rejected', { runId, error });
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
          const chunkMessage: IacDestroyChunkMessage = { runId, chunk: next.value };
          sender.send(DESTROY_CHUNK_CHANNEL, chunkMessage);
          next = await stream.next();
        }
        if (!sender.isDestroyed()) {
          const message: IacDestroyEndMessage = { runId, exitCode: 0, result: next.value };
          sender.send(DESTROY_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('destroy error', { err });
        if (!sender.isDestroyed()) {
          const message: IacDestroyEndMessage = {
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
   * Returns the current stack outputs. Resolves a single value, so the generic `ipcMain.handle`
   * bridge wires this automatically — no manual bridging needed.
   *
   * @remarks
   * Returns `StackOutputs` (`@hyveon/shared`), not a raw state-file shape — a Pulumi-orchestrated
   * stack's state lives in the DIY S3 backend, never as a local file this app reads directly.
   *
   * `payload.force` is accepted for payload compatibility but ignored: `PulumiService.apply`/
   * `.destroy` already invalidate the outputs cache on a successful settlement, so the next call
   * after a real change misses the cache with no caller-supplied bypass needed.
   *
   * Prefers `ConfigService.getStackOutputs()` (adds its own request-coalescing cache) over
   * `PulumiService.getStackOutputs()` directly; falls back to the latter only in the
   * test-construction path where `config` isn't supplied.
   *
   */
  @MessagePattern('iac.output')
  async output(@Payload() payload: IacOutputPayload = {}): Promise<StackOutputs | null> {
    logger.debug('IacController: iac.output invoked');
    void payload;
    return this.config ? this.config.getStackOutputs() : this.pulumi.getStackOutputs();
  }

  /**
   * Approves a successful `plan` run for a later apply, delegating the write to
   * `RunRecordService.approveRun` (see issue #109).
   *
   * @remarks
   * The approver identity is never taken from the client — it's resolved server-side via
   * {@link resolveApprover} (the local OS username), so an IPC caller can't spoof who approved
   * a run.
   *
   * Reachable via the Electron IPC transport (`iac.approve`), bridged automatically by the
   * generic `ipcMain.handle` bridge.
   */
  @MessagePattern('iac.approve')
  async approve(@Payload() payload: IacApprovePayload): Promise<IacApproveAck> {
    logger.debug('IacController: iac.approve invoked');
    const validationError = IacController.validateApprovePayload(payload);
    if (validationError) {
      logger.error('approve rejected: invalid payload', { error: validationError });
      return { approved: false, error: validationError };
    }

    if (!this.runRecord) {
      const error = 'iac.approve requires a configured RunRecordService';
      logger.error('approve rejected: no RunRecordService available', { planRunId: payload.planRunId });
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
      logger.error('approve error', { err, planRunId: payload.planRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { approved: false, error };
    }
  }

  /**
   * Previews the rollback flow's (#112) target configuration version for
   * `payload.applyRunId`, without writing anything — delegates to
   * `PulumiService.resolveRollbackTarget`. Called when the operator clicks
   * "Rollback" on an apply row in history, so the confirmation dialog can
   * name the version it would restore before the operator commits to it.
   *
   * Reachable via the Electron IPC transport (`iac.rollback.resolve`),
   * bridged automatically by the generic `ipcMain.handle` bridge since it
   * resolves a single value rather than streaming progress.
   *
   * Once the target version is identified, also asks
   * `PulumiService.computeRollbackDiff` to summarize how it
   * differs from the current configuration head, so the confirmation
   * dialog isn't opaque. That call is wrapped in its own `try`/`catch` here
   * ON TOP OF `computeRollbackDiff`'s own internal best-effort handling —
   * belt-and-braces, so an unexpected throw from the diff step can NEVER
   * regress this method's already-working, spec-MUST "identify the target
   * version" behavior into a `resolved: false` failure; only the `diff`
   * field is omitted.
   */
  @MessagePattern('iac.rollback.resolve')
  async resolveRollback(@Payload() payload: IacRollbackPayload): Promise<IacRollbackResolveAck> {
    logger.debug('IacController: iac.rollback.resolve invoked');
    const validationError = IacController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('rollback resolve rejected: invalid payload', { error: validationError });
      return { resolved: false, error: validationError };
    }

    try {
      const target = await this.pulumi.resolveRollbackTarget(payload.applyRunId);

      let diff: DeploymentConfigDiff | undefined;
      try {
        diff = await this.pulumi.computeRollbackDiff(target.versionId);
      } catch (err) {
        logger.warn('rollback resolve: diff computation failed — continuing without it', {
          err,
          applyRunId: payload.applyRunId,
        });
      }

      return {
        resolved: true,
        versionId: target.versionId,
        lastModified: target.lastModified.toISOString(),
        ...(diff ? { diff } : {}),
      };
    } catch (err) {
      logger.error('rollback resolve error', { err, applyRunId: payload.applyRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { resolved: false, error };
    }
  }

  /**
   * Confirms the rollback flow (#112) for `payload.applyRunId`. `PulumiService.confirmRollback`
   * fuses a historic-configuration restore write and its follow-up plan into one guarded
   * `AsyncGenerator`, driven here via a manual `.next()` loop (mirrors {@link plan}) so the
   * generator's return value is reachable; every intermediate chunk is also forwarded on
   * {@link ROLLBACK_CONFIRM_CHUNK_CHANNEL}.
   *
   * @remarks
   * **Accepted consequence, not a bug**: the renderer submits a separate `iac.plan` call after a
   * successful ack, so a confirmed rollback produces TWO `PulumiRunRecord`s tagged
   * `rolledBackFrom: applyRunId` — this method's own internal plan run (never surfaced to the
   * renderer) and the renderer's own subsequent one (which is what the operator actually sees
   * and can approve/apply).
   *
   * The restored configuration version id the renderer needs (`IacRollbackConfirmAck.versionId`)
   * is not a field of `PulumiPreviewResult` — it's recovered via
   * `PulumiService.readRunRecord(result.runId).configVersionId`, which `previewCore` always
   * persists for a successful plan run before returning.
   *
   * Reachable via the Electron IPC transport (`iac.rollback.confirm`); bridged manually by
   * {@link onModuleInit} (undecorated `ctx: { evt }` parameter), not the generic bridge.
   */
  @MessagePattern('iac.rollback.confirm')
  async confirmRollback(
    @Payload() payload: IacRollbackPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<IacRollbackConfirmAck> {
    logger.debug('IacController: iac.rollback.confirm invoked');
    const validationError = IacController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('rollback confirm rejected: invalid payload', { error: validationError });
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
          const chunkMessage: IacRollbackConfirmChunkMessage = {
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
        // only reachable if `signal` aborted mid-run. The only abort source
        // wired here is the WebContents-destroyed listener above, at which
        // point nothing is listening for this ack anyway — return a
        // well-formed "not confirmed" ack defensively rather than treating
        // an `undefined` result as success.
        return { confirmed: false, error: 'Rollback confirmation was aborted before it could complete.' };
      }

      const record = this.pulumi.readRunRecord(result.runId);
      const versionId = record?.configVersionId;
      if (!versionId) {
        // Should not happen — previewCore always writes configVersionId for
        // a successful plan run before returning (see this method's own
        // TSDoc). Defensive fallback so a genuinely unexpected gap surfaces
        // as a clear ack error rather than a "confirmed" ack the renderer
        // can't actually act on (it has nowhere to plan against next).
        logger.error('rollback confirm: missing persisted configVersionId after a successful rollback plan', {
          applyRunId: payload.applyRunId,
          runId: result.runId,
        });
        return { confirmed: false, error: 'Rollback plan completed but its restored version id could not be recovered.' };
      }

      // Best-effort: AuditService.record() never throws (failures are
      // logged and swallowed internally), mirroring the audit entry
      // recorded by plan()/apply()/approve() for their own accepted
      // submissions — restoring a version as a new head is the most
      // consequential of these writes, so it shouldn't be the one exempt
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
      logger.error('rollback confirm error', { err, applyRunId: payload.applyRunId });
      if (err instanceof PulumiRollbackPlanFailedError) {
        // The restore write DID succeed — err.restoredVersionId is now the
        // new head — only the follow-up plan failed. Surface it
        // programmatically (not just in err.message's prose) so a caller can
        // act on it, e.g. offer "plan against the restored version" as a
        // next step, per this ack field's own TSDoc.
        return { confirmed: false, versionId: err.restoredVersionId, error: err.message };
      }
      const error = err instanceof Error ? err.message : String(err);
      return { confirmed: false, error };
    } finally {
      sender.removeListener('destroyed', onDestroyed);
    }
  }

  /**
   * Clears an unrecognized Pulumi backend lock after the operator has
   * explicitly confirmed it via the renderer's stale-lock recovery UI —
   * delegates entirely to `PulumiService.clearStaleLock()`; see that
   * method's own TSDoc for the
   * full safety reasoning (why it refuses while another operation is already
   * in flight, why it never re-derives or re-checks whether the lock is
   * actually stale — that judgment call was already made by the operator
   * before this channel is ever invoked — and why it never retries the
   * original plan/apply/destroy itself).
   *
   * Gated behind `payload.confirmationToken` (minted via
   * {@link mintLockClearToken}) — mirrors {@link destroy}'s token-gate
   * validation, thin as it is here since this channel isn't a streaming
   * operation.
   *
   * Reachable via the Electron IPC transport (`iac.lock.clear`), resolved by
   * the generic `ipcMain.handle` bridge in `../ipc-main-bridge.ts` — a plain
   * one-shot request/response (no streaming side channel), exactly like
   * `iac.rollback.resolve`.
   */
  @MessagePattern('iac.lock.clear')
  async clearStaleLock(@Payload() payload: IacLockClearPayload): Promise<IacLockClearAck> {
    logger.debug('IacController: iac.lock.clear invoked');
    const validationError = IacController.validateLockClearPayload(payload);
    if (validationError) {
      logger.error('iac lock clear rejected: invalid payload', { error: validationError });
      return { cleared: false, error: validationError };
    }

    try {
      await this.pulumi.clearStaleLock(payload.confirmationToken);
      return { cleared: true };
    } catch (err) {
      logger.error('iac lock clear error', { err });
      const error = err instanceof Error ? err.message : String(err);
      return { cleared: false, error };
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
   * Validates that `payload.planRunId` is a non-empty string. Returns a
   * descriptive error message when validation fails, or `null` when
   * `payload` is valid.
   */
  private static validateApprovePayload(payload: IacApprovePayload): string | null {
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
  private static validateDestroyPayload(payload: IacDestroyPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.confirmationToken)) {
      return 'iac.destroy requires a non-empty confirmationToken string';
    }
    return null;
  }

  /**
   * Validates that `payload.confirmationToken` is a non-empty string.
   * Mirrors {@link validateDestroyPayload} exactly, for the lock-clear
   * confirmation gate.
   */
  private static validateLockClearPayload(payload: IacLockClearPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.confirmationToken)) {
      return 'iac.lock.clear requires a non-empty confirmationToken string';
    }
    return null;
  }

  /**
   * Validates that `payload.applyRunId` is a non-empty string. Returns a
   * descriptive error message when validation fails, or `null` when
   * `payload` is valid. Shared by {@link resolveRollback} and
   * {@link confirmRollback} — both key off the same field.
   */
  private static validateRollbackPayload(payload: IacRollbackPayload): string | null {
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
  private static validateApplyPayload(payload: IacApplyPayload): string | null {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;

    if (!isNonEmptyString(payload?.planRunId) || !isNonEmptyString(payload?.planHash)) {
      return 'iac.apply requires non-empty planRunId and planHash strings';
    }
    return null;
  }
}
