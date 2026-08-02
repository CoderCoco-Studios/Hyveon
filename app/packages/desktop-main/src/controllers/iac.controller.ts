import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { RunLockHeldError } from '@hyveon/shared';
import type { DeploymentConfigDiff, StackOutputs } from '@hyveon/shared';
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
 * {@link StackInitializeAck.streamId} — mirrors {@link TerraformPlanChunkMessage}.
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
interface TerraformOutputPayload {
  force?: boolean;
}

/**
 * Payload accepted by {@link IacController.plan}. `tfvarsVersionId`,
 * when the configured configuration source is S3-backed, is forwarded
 * verbatim to `PulumiService.preview`'s pre-spawn staleness check against
 * the current head version of the configuration object. `rolledBackFrom`,
 * when supplied by the rollback flow (#112), is stamped onto the resulting
 * plan's `PulumiRunRecord` so history can tag it as a rollback of that
 * `runId`.
 */
interface TerraformPlanPayload {
  tfvarsVersionId?: string;
  rolledBackFrom?: string;
}

/**
 * Message payload sent, in order, on {@link PLAN_CHUNK_CHANNEL} for every
 * chunk `PulumiService.preview` yields. `runId` ties the chunk back to the
 * `plan()` call that produced it — the same id already handed back in
 * {@link TerraformPlanAck.runId} — so the renderer (and a second, rejected
 * concurrent call) can never mix up output from two overlapping runs.
 */
interface TerraformPlanChunkMessage {
  runId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent once on {@link PLAN_END_CHANNEL} when a
 * `iac.plan` run finishes. `exitCode` is `0` on success, or `null` on
 * failure — the Pulumi Automation API has no real process exit code to
 * report (unlike the spawned `terraform` CLI this channel originally
 * bridged), so `null` uniformly represents "this run did not succeed" here,
 * rather than trying to recover a synthetic non-zero number. `result` is
 * present only on a successful run — the structured `changeSummary` and
 * artifact/hash/engine-version fields `PulumiService.preview` resolved.
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
interface TerraformLockClearAck {
  cleared: boolean;
  error?: string;
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
interface TerraformRollbackResolveAck {
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
 * to pass to `iac.plan`'s `tfvarsVersionId` (alongside
 * `rolledBackFrom: applyRunId`) for a renderer that still drives the
 * pre-migration two-call flow (see {@link IacController.confirmRollback}'s
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
 * Payload accepted by {@link IacController.apply}. `planRunId`
 * identifies the approved `plan` run to apply — also reused, unchanged, as
 * the apply run's own `runId` (see `PulumiService.apply`'s TSDoc, "run id").
 * `planHash` is the caller's expected plan hash, checked against the plan
 * run's stored `planHash` by `PulumiService.apply`'s own self-contained
 * gate — this controller does not re-derive or pre-check any of that
 * itself; see {@link apply}'s own TSDoc.
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
 * Message payload sent once on {@link APPLY_END_CHANNEL} when a
 * `iac.apply` run finishes. `exitCode` is `0` on success, or `null` on
 * failure — see {@link TerraformPlanEndMessage}'s doc comment for why there
 * is no real numeric exit code to report under the Pulumi Automation API.
 * `result` is present only on a successful run. `staleLock` is present when
 * the failure was `PulumiUnrecognizedLockError` — see {@link StaleLockInfo}.
 * Unlike {@link TerraformPlanAck}, `PulumiUnrecognizedLockError` can surface
 * here (rather than on the immediate ack) because `stack.up()`'s lock
 * conflict is only discovered once the operation has already been streaming.
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
 * `@MessagePattern` — no HTTP routes are registered here. Every
 * orchestration call site delegates to `PulumiService`, the
 * Automation-API-backed provisioning engine; where its methods are
 * self-contained gates rather than thin CLI wrappers ({@link apply},
 * {@link destroy}), this controller does no extra pre-flight bookkeeping of
 * its own. See each method's own TSDoc for the specifics.
 *
 * {@link plan} bridges `PulumiService.preview`'s async-generator output onto
 * the fixed `iac.plan.chunk` / `iac.plan.end` side channels, plus
 * a pre-flight `PulumiService.getOperationInFlight()` conflict check and a
 * persisted `AuditService.record()` entry for every accepted submission.
 * {@link approve} needs no such bridging — it resolves a single value, so
 * the generic `ipcMain.handle` bridge in `../ipc-main-bridge.ts` wires it
 * automatically — and delegates the actual write to
 * `RunRecordService.approveRun` (see issue #109). {@link apply} mirrors
 * {@link plan}'s streaming/bridging shape, but — since `PulumiService.apply`'s
 * 8-step gate is entirely self-contained — this controller performs none of
 * the plan-hash/approval/lock pre-checks itself; it awaits the gate's own
 * outcome (the generator's first `.next()`) before
 * acking, and only then starts forwarding chunks. {@link destroy} mirrors
 * {@link apply}'s shape a third time, gated behind a short-lived confirmation
 * token minted by {@link mintDestroyToken} (issue #307) instead of a
 * plan/approval lineage — `mintDestroyToken` itself needs no bridging, same
 * as {@link approve}.
 */
@Controller()
export class IacController implements OnModuleInit {
  /**
   * `audit`/`runRecord`/`config` are typed optional (`?`) purely so existing
   * test call sites that construct `new IacController(pulumi)` directly
   * (bypassing Nest's DI container) keep compiling without also stubbing
   * them — every real bootstrap through `AppModule` still resolves concrete
   * `AuditService`/`RunRecordService`/`ConfigService` instances regardless of
   * this TS-level optionality. `runRecord` backs {@link approve}'s
   * `RunRecordService.approveRun` write (unrelated to `PulumiService.apply`'s
   * own internal plan-record lookup, which does not go through this
   * controller at all). `config` backs {@link output}'s preferred
   * `ConfigService.getStackOutputs()` delegate (falling back to
   * `PulumiService.getStackOutputs()` directly when unavailable — see that
   * method's own TSDoc).
   *
   * There is no `RunService` dependency here: `PulumiService.apply`/`.destroy`'s
   * self-contained gates acquire and release the durable apply lock entirely
   * internally, so this controller has nothing left to do with `RunService`
   * directly.
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
   * Registers an `ipcMain.handle` bridge for the `iac.plan` channel
   * (and `iac.apply`/`iac.destroy`) after the Nest module
   * initialises, so that `ipcRenderer.invoke(...)` in the preload actually
   * resolves.
   *
   * `@MessagePattern(...)` only wires the transport's internal dispatcher —
   * it does **not** call `ipcMain.handle`, so `ipcRenderer.invoke` would
   * otherwise hang. This hook bridges the gap, mirroring
   * `LogsController.onModuleInit`'s handling of `logs.stream` — see
   * `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`, which excludes these
   * five channels from the generic bridge for the same reason: each handler
   * pushes follow-up chunk/end messages over side channels for the duration
   * of a long-running run rather than resolving a single value.
   *
   * `iac.stack.initialize` is in this set for the same reason
   * `iac.plan`/`iac.apply`/`iac.destroy` are: {@link initializeStack} pushes
   * phase-event/end messages over its own side channels for the duration of
   * the run rather than resolving a single value.
   *
   * `iac.rollback.confirm` is also in this set: {@link confirmRollback}'s own
   * `ctx: { evt }` second parameter has no `@Payload()`/etc. decorator,
   * exactly like `plan`/`apply`/`destroy` — leaving it off the generic bridge
   * would mean NestJS's `RpcContextCreator` sizes its `initialArgs` array to
   * the one decorated parameter it sees (`@Payload()` at index 0) and
   * silently drops `ctx`, which would arrive as `undefined` at runtime and
   * throw on {@link confirmRollback}'s first line.
   *
   * Only runs inside a real Electron main process. In plain-Node runtimes
   * (integration test server, Docker, CI) `process.versions.electron` is
   * undefined and importing `electron` would throw, so the bridge is skipped
   * entirely rather than guessing which error means "no Electron" from the
   * message.
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
    // `iac.apply` streams chunk/end messages the same way
    // `iac.plan` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason.
    ipcMain.removeHandler('iac.apply');
    ipcMain.handle('iac.apply', (evt, payload: TerraformApplyPayload) =>
      this.apply(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.destroy` streams chunk/end messages the same way
    // `iac.apply` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason. `iac.destroy.mintToken` needs no such bridging
    // (it resolves a single value), so the generic bridge wires it
    // automatically — no entry here.
    ipcMain.removeHandler('iac.destroy');
    ipcMain.handle('iac.destroy', (evt, payload: TerraformDestroyPayload) =>
      this.destroy(payload, { evt: evt as IpcMainInvokeEvent }),
    );
    // `iac.rollback.confirm` streams chunk messages the same way
    // `iac.destroy` does — see `SELF_BRIDGED_PATTERNS` in
    // `../ipc-main-bridge.ts`, which excludes it from the generic bridge for
    // the same reason (see this method's own TSDoc for why the undecorated
    // `ctx` parameter needs manual bridging).
    ipcMain.removeHandler('iac.rollback.confirm');
    ipcMain.handle('iac.rollback.confirm', (evt, payload: TerraformRollbackPayload) =>
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
   * Replacement for the `iac.init` channel — Pulumi has no `terraform init`
   * analogue, so this streams `PulumiService.initializeStack`'s phase-by-phase
   * provisioning instead of a one-shot init call.
   * Kicks off `PulumiService.initializeStack` and streams its `onPhase`
   * progress back to the renderer — structurally the same shape as
   * {@link plan}/{@link apply}/{@link destroy} (a caller starts a
   * long-running operation and wants live progress), but the payload is
   * `{ phase, status }` provisioning-phase events, not `PulumiRunChunk` log
   * lines, and there is no plan-hash/approval/lock gate to await first: the
   * only pre-flight check is `PulumiService.getOperationInFlight()`, exactly
   * like {@link plan}'s.
   *
   * Mints a `streamId` (there is no natural run id here — this operation
   * produces no `PulumiRunRecord`) and pushes every `onPhase` event on
   * {@link STACK_INIT_CHUNK_CHANNEL} tagged with it, mirroring
   * `IacController.init`'s original fixed-side-channel-plus-streamId shape
   * (see `hyveon-api.ts`/`preload.ts` — the same pattern reused for this
   * channel). Checks `getOperationInFlight()` first and, with no
   * `await` between that check and the call to
   * `this.pulumi.initializeStack(...)`, closes the same TOCTOU gap
   * {@link plan}'s own doc comment explains: `initializeStack`'s own busy
   * check (a distinct `stackInitInFlight` flag, see that method's TSDoc) is
   * set synchronously, before its own first `await`.
   *
   * Once accepted, `initializeStack`'s promise is driven to completion in a
   * fire-and-forget block (mirrors {@link plan}'s streaming loop, but there
   * is no per-chunk drive loop to write since `onPhase` already pushes each
   * event as it happens) — a single terminal message is sent on
   * {@link STACK_INIT_END_CHANNEL} once it settles: `{ streamId }` on
   * success, or `{ streamId, error }` on failure. `error` is always a
   * human-readable message — for a `PulumiStackInitializationError`
   * specifically, that message already names the failed phase in prose
   * (see that error class's own TSDoc/message format in `PulumiService.ts`).
   *
   * ## Why no structured `failedPhase` field
   *
   * This message deliberately carries no structured
   * `failedPhase?: PulumiProvisioningPhase` field. `failedPhase` would cross
   * this side channel fine (a plain `sender.send(...)` IPC message — structured
   * data clones reliably), but the renderer only learns about a stream's
   * failure via the preload-internal generator's `throw`, which crosses the
   * **contextBridge** as a rejected promise — and Electron's contextBridge
   * uses the same structured-clone algorithm as Node's `structuredClone()`,
   * which preserves only `name`/`message`/`stack` on an `Error`, not custom
   * own properties like `.phase`. The renderer instead derives the same
   * phase attribution independently and reliably from the
   * {@link STACK_INIT_CHUNK_CHANNEL} event stream itself (plain data, proven
   * to cross correctly) — see `StackInitializationStep`'s own
   * `lastStartedPhase` tracking in `@hyveon/web`.
   *
   * Reachable via the Electron IPC transport (`iac.stack.initialize`) — this
   * channel self-bridges (see {@link onModuleInit}'s own TSDoc and
   * `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts`), the same reason
   * {@link plan}/{@link apply}/{@link destroy} do.
   */
  @MessagePattern('iac.stack.initialize')
  async initializeStack(
    @Payload() _payload: unknown,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<StackInitializeAck> {
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
   * Kicks off a Pulumi preview (`terraform plan`'s successor) and streams its
   * output back to the renderer — pre-mints a `runId` since
   * `PulumiService.preview` already needs one to name its saved plan
   * artifact directory.
   *
   * Checks `PulumiService.getOperationInFlight()` first: if a `preview`,
   * `up`, `destroy`, or `rollback` operation is already running against the
   * shared workspace, no run is attempted — the method resolves immediately
   * with `{ started: false, error, conflict: <in-flight op> }` naming
   * whichever operation is in flight. No chunk/end messages are sent and no
   * audit entry is recorded for a rejected submission.
   *
   * Otherwise a `runId` (`randomUUID()`) is minted up front and handed to
   * `PulumiService.preview` as `preMintedRunId`, and the generator's first
   * step is driven synchronously (before anything is awaited) to reserve the
   * shared workspace — `PulumiService.preview`'s own `operationInFlight`
   * check-and-set runs synchronously, before its own first `await`, so
   * driving `.next()` here, with no `await` between the
   * `getOperationInFlight()` check above and this call, closes the TOCTOU gap
   * a busy-workspace check would otherwise leave open. The `.catch()` below exists
   * solely to mark `firstStep` as "handled" so Node doesn't log an
   * unhandledRejection warning while it sits unawaited during the
   * `audit.record()` call further down — the real handling of whatever it
   * settles to happens in the streaming loop below, the same way every later
   * `.next()` result already is.
   *
   * Only once that reservation has happened is an audit entry
   * (`action: 'plan'`) recorded via `AuditService.record()` for the
   * now-accepted submission, and the streaming loop fired and forgotten
   * (`void (async () => { ... })()`); the method resolves immediately with
   * `{ started: true, runId }`, well before the preview run itself settles.
   * Every chunk/end message is tagged with that same `runId`. Each chunk
   * `PulumiService.preview` yields is forwarded, in order, via `sender.send`
   * on {@link PLAN_CHUNK_CHANNEL} as `{ runId, chunk }`. Once the run settles
   * a single terminal message is sent on {@link PLAN_END_CHANNEL}:
   * `{ runId, exitCode: 0, result }` on success, or
   * `{ runId, exitCode: null, error }` on failure.
   *
   * Drives `PulumiService.preview`'s async generator manually via repeated
   * `.next()` calls (rather than `for await...of`) so the terminal
   * `PulumiPreviewResult` (the generator's return value once it's `done`)
   * can be attached to the end message's `result` field. If the `WebContents`
   * is destroyed mid-stream, the generator is explicitly finalized via
   * `stream.return()` so `PulumiService.preview`'s own force-closed-generator
   * cleanup (persisting a cancelled run record) still runs.
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
    // workspace-wide `plan` action that isn't scoped to a single game. By
    // this point the workspace reservation above has already succeeded, so
    // this audit entry is only ever recorded for a submission that really
    // did start a run.
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
   * back to the renderer — mirrors {@link plan}'s streaming shape, but the
   * gate structure underneath it is different: `PulumiService.apply`'s
   * 8-step gate is entirely self-contained — plan-record lookup,
   * approval/expiry checks, plan-hash verification (both the stored-hash
   * comparison and the on-disk artifact re-hash), engine-version check, and
   * the durable apply-lock reservation (`RunLockService.createRun`'s atomic
   * compare-and-set) all happen INSIDE `PulumiService.apply` itself.
   *
   * This controller must NOT reintroduce any of that gate's checks itself —
   * the gate is the single, authoritative place those checks live — it only
   * needs to know that the gate is entirely synchronous-relative-to-yielding:
   * every one of `PulumiService.apply`'s 8 steps runs to completion before
   * the generator's first `yield` (the first real chunk of `stack.up()`'s
   * output) ever happens. So the first `.next()` call on the returned
   * generator either REJECTS (any gate-step failure — most importantly
   * `RunLockHeldError`, propagated unwrapped by gate step 8's losing race,
   * mapped below to `conflict: 'up'`; or `PulumiOperationInFlightError`,
   * thrown by the gate's own top-of-function `operationInFlight` busy check,
   * mapped to `conflict: <its own inFlight value>` — this cheaper,
   * earlier in-process mutex check needs the same `conflict` treatment as
   * the durable lock race, since the renderer's busy banner reads
   * `ack.conflict` regardless of which guard refused the submission) or
   * RESOLVES with the operation genuinely under way. This method exploits
   * that: it `await`s the first `.next()` call BEFORE acking, so
   * `{ started: true, runId }` is only ever returned once the gate has
   * actually passed.
   *
   * Validates `payload` first (`planRunId`/`planHash` both non-empty
   * strings) — the only validation this controller still performs itself;
   * everything else is the gate's job. A gate failure resolves
   * `{ started: false, error }` (plus `conflict: 'up'` for a lost
   * `RunLockHeldError` race, or `conflict: <inFlight>` for a busy-workspace
   * `PulumiOperationInFlightError`) without ever touching
   * {@link activeApplies} or recording an audit entry.
   *
   * Once the gate has passed, {@link activeApplies} is populated, a
   * `'destroyed'` listener is armed on the `WebContents`, a best-effort audit
   * entry (`action: 'apply'`) is recorded, and the (now partially-drained)
   * generator is driven to completion in a fire-and-forget streaming loop —
   * mirrors {@link plan}'s loop shape exactly, starting from the
   * already-resolved first step rather than an unawaited one. Each
   * subsequent chunk is forwarded via `sender.send` on
   * {@link APPLY_CHUNK_CHANNEL} as `{ runId, chunk }`; once the run settles a
   * single terminal message is sent on {@link APPLY_END_CHANNEL}:
   * `{ runId, exitCode: 0, result }` on success, or
   * `{ runId, exitCode: null, error }` on failure — see
   * {@link TerraformPlanEndMessage}'s doc comment for why `exitCode` is a
   * plain `0`/`null` pair now rather than a recovered process exit code.
   *
   * Unlike the pre-migration version of this method, there is no
   * `RunService.createRun`/`releaseRun` call anywhere in this controller any
   * more, and no redundant "release the lock in this controller's own
   * `finally` too" safety net — `PulumiService.apply`'s own gate acquires the
   * durable lock and its own persistence path (`RunRecordService.persist`'s
   * `finally`) releases it on every settlement path, including a
   * force-closed generator (see that method's TSDoc for the full guarantee).
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
        // the durable RunLockHeldError race above, but a busy refusal from it
        // must populate `conflict` exactly the same way — the renderer's
        // busy banner (terraform.page.tsx) reads ack.conflict regardless of
        // which of the two guards refused the submission.
        logger.error('terraform apply rejected: workspace busy', { planRunId: payload.planRunId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
      }
      if (err instanceof PulumiUnrecognizedLockError) {
        // stack.up() can hit an unrecognized backend lock conflict before
        // ever yielding a chunk (the gate steps above this catch never
        // throw this error — it's raised inside attemptUp() itself, only
        // once operationSettled) — see the streaming loop's identical catch
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
   * checks, the single-use confirmation-token consumption (synchronous, so a
   * same-token race is decided cleanly without ever touching
   * `RunLockService` — see that method's own TSDoc, "Gate structure"), and
   * the durable apply-lock reservation all happen before the generator's
   * first `yield`. This method awaits that first `.next()` call before
   * acking, exactly like {@link apply} — a gate failure (most notably
   * `DestroyNotConfirmedError` for a missing/stale/already-consumed token,
   * `RunLockHeldError` for a lost lock race mapped to `conflict: 'destroy'`,
   * or `PulumiOperationInFlightError` for the top-of-function busy check
   * mapped to `conflict: <its own inFlight value>`, mirroring {@link apply}'s
   * identical treatment)
   * resolves `{ started: false, error }` without ever touching
   * {@link activeDestroys} or recording an audit entry, and — critically —
   * without burning a token that a genuinely concurrent, unrelated rejection
   * (e.g. `RunLockHeldError`) shouldn't have consumed; `PulumiService.destroy`'s
   * own gate ordering (token consumed only once the cheap, synchronous
   * config-presence checks have already passed) protects that, not this
   * controller.
   *
   * Validates only `payload.confirmationToken` is present — everything else
   * is the gate's job, mirroring {@link apply}'s pared-down validation. Once
   * the gate has passed, `runId` is minted fresh (`randomUUID()`, matching
   * `PulumiService.destroy`'s `preMintedRunId` parameter — a destroy has no
   * inherited id to reuse), {@link activeDestroys} is populated, a
   * `'destroyed'` listener is armed, a best-effort audit entry
   * (`action: 'destroy'`) is recorded, and the streaming loop is driven to
   * completion from the already-resolved first step — mirrors {@link apply}'s
   * loop shape exactly. Each chunk is forwarded via `sender.send` on
   * {@link DESTROY_CHUNK_CHANNEL} as `{ runId, chunk }`; once the run settles
   * a single terminal message is sent on {@link DESTROY_END_CHANNEL}, mirroring
   * {@link TerraformApplyEndMessage}'s `exitCode` convention.
   *
   * Unlike the pre-migration version of this method, there is no
   * `RunService.createRun`/`releaseRun` call anywhere in this controller any
   * more — `PulumiService.destroy`'s own gate and persistence path own that
   * entirely, mirroring {@link apply}.
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
        // Mirrors apply()'s equivalent branch — see that catch block's
        // comment for why the in-process mutex needs the same `conflict`
        // treatment as the durable RunLockHeldError race above.
        logger.error('terraform destroy rejected: workspace busy', { runId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
      }
      if (err instanceof PulumiUnrecognizedLockError) {
        // Mirrors apply()'s identical branch — see that catch block's
        // comment for why this can surface here, before any streaming ever
        // started, rather than only on the end-of-stream catch below.
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
   * needs no manual bridging — it resolves a single value rather than
   * streaming progress, so the generic `ipcMain.handle` bridge in
   * `../ipc-main-bridge.ts` wires `ipcRenderer.invoke('iac.output', ...)`
   * to this handler automatically.
   *
   * ## Return shape: `StackOutputs`, not a Terraform-tfstate shape
   *
   * There is no local `terraform.tfstate` file to read — a
   * Pulumi-orchestrated stack's state lives in the DIY S3 backend, never as
   * a local file this app reads directly — so this method returns
   * `StackOutputs` (`@hyveon/shared`), the type
   * `ConfigService.getStackOutputs()`/`PulumiService.getStackOutputs()`
   * establishes as the canonical "what a deployed stack looks like" shape
   * and every OTHER controller in this codebase already returns to the
   * renderer (`GamesController`, `DiscordController`, `CostsController`,
   * `EnvController`, etc.). Nothing in `@hyveon/web`'s production code reads
   * `iac.output`'s result today (only a screenshot-demo fixture resolves it
   * to `null`).
   *
   * ## `force` is accepted but ignored
   *
   * `payload.force` is kept in {@link TerraformOutputPayload} for payload
   * compatibility but is otherwise unused: `PulumiService.apply`/`.destroy`
   * both call `ConfigService.invalidateCache()` on a successful settlement
   * (see those methods' own TSDoc, "Cache invalidation"), so the next
   * `getStackOutputs()` call after a real change already misses its cache
   * with no caller-supplied bypass needed.
   *
   * Prefers `ConfigService.getStackOutputs()` (`this.config`, already wired
   * into this controller for other reasons) over calling
   * `PulumiService.getStackOutputs()` directly, since `ConfigService`'s own
   * delegate adds its own request-coalescing cache on top (see that method's
   * TSDoc) — falls back to `PulumiService.getStackOutputs()` directly only
   * in the test-construction path where `config` isn't supplied (see the
   * constructor's own doc comment).
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
   * actual write to `RunRecordService.approveRun` (see issue #109). This
   * method never calls `PulumiService` — it only ever touches
   * `RunRecordService`/`AuditService`.
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
  async resolveRollback(@Payload() payload: TerraformRollbackPayload): Promise<TerraformRollbackResolveAck> {
    const validationError = IacController.validateRollbackPayload(payload);
    if (validationError) {
      logger.error('terraform rollback resolve rejected: invalid payload', { error: validationError });
      return { resolved: false, error: validationError };
    }

    try {
      const target = await this.pulumi.resolveRollbackTarget(payload.applyRunId);

      let diff: DeploymentConfigDiff | undefined;
      try {
        diff = await this.pulumi.computeRollbackDiff(target.versionId);
      } catch (err) {
        logger.warn('terraform rollback resolve: diff computation failed — continuing without it', {
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
      logger.error('terraform rollback resolve error', { err, applyRunId: payload.applyRunId });
      const error = err instanceof Error ? err.message : String(err);
      return { resolved: false, error };
    }
  }

  /**
   * Confirms the rollback flow (#112) for `payload.applyRunId`.
   *
   * ## Streaming vs. the renderer's existing one-shot contract
   *
   * `PulumiService.confirmRollback` fuses the historic-configuration restore
   * write and its follow-up plan into one guarded unit, held under a single
   * `operationInFlight` lock for its entire duration — it's an
   * `AsyncGenerator` that streams a real plan run internally, exactly like
   * {@link plan} does, not a one-shot `Promise` (see that method's own
   * TSDoc, "The old `TerraformService` gap this closes").
   *
   * The renderer expects `iac.rollback.confirm` to resolve a single
   * `TerraformRollbackConfirmAck`, with a SEPARATE `iac.plan` call still
   * queuing the plan the operator watches (see `@hyveon/web`'s
   * `terraform.page.tsx`, `RollbackNavState`). This method reconciles the
   * two: it drives `PulumiService.confirmRollback`'s generator to completion
   * INTERNALLY (via a manual `.next()` loop, mirroring {@link plan}'s
   * manual-drive shape so `PulumiPreviewResult` — the generator's return
   * value — is reachable), forwarding every intermediate chunk on the new
   * {@link ROLLBACK_CONFIRM_CHUNK_CHANNEL} purely as a forward-compatible
   * bonus (no current subscriber), and only resolves this method's own
   * `Promise` once the WHOLE restore+plan unit has settled.
   *
   * **Known, accepted consequence, not silently swallowed**: because the
   * renderer's `RollbackAction`/`TerraformPage` still submit a follow-up
   * `iac.plan` call after a successful `confirmRollback` ack, and
   * `PulumiService.confirmRollback` also runs a real plan internally as part
   * of the restore, a successful rollback produces TWO `PulumiRunRecord`s
   * tagged `rolledBackFrom: applyRunId` — the one this method's internal
   * generator just completed (whose `runId` isn't surfaced to the renderer
   * at all) and the one the renderer's own subsequent `iac.plan` call starts
   * (which IS what the operator actually sees and can approve/apply). This
   * is wasteful (a redundant `pulumi preview` invocation and an orphaned,
   * browsable-but-unreferenced run-history entry) but not incorrect from the
   * renderer's point of view — every rollback flow still completes
   * successfully end-to-end. Closing this duplication requires updating the
   * renderer to consume `confirmRollback`'s already-completed plan directly
   * instead of re-submitting one.
   *
   * The restored configuration version id the renderer needs
   * (`TerraformRollbackConfirmAck.versionId`) is NOT a field of
   * `PulumiPreviewResult` (which describes the plan artifact, not the
   * configuration version it ran against) — it's recovered via
   * `PulumiService.readRunRecord(result.runId)` once the generator settles,
   * reading back the `PulumiRunRecord.tfvarsVersionId` that `PulumiService`'s
   * internal `previewCore` call persisted for this exact run (guaranteed
   * present: `previewCore` always records the configuration version id it
   * actually observed for a successful plan before returning).
   *
   * Reachable via the Electron IPC transport (`iac.rollback.confirm`).
   * Despite ultimately resolving a single `TerraformRollbackConfirmAck`, this
   * channel is bridged manually by {@link onModuleInit}, not by the generic
   * `ipcMain.handle` bridge — see that method's own TSDoc and
   * `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts` for why: the
   * `ctx: { evt }` second parameter below is undecorated, exactly like
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
        // only reachable if `signal` aborted mid-run. The only abort source
        // wired here is the WebContents-destroyed listener above, at which
        // point nothing is listening for this ack anyway — return a
        // well-formed "not confirmed" ack defensively rather than treating
        // an `undefined` result as success.
        return { confirmed: false, error: 'Rollback confirmation was aborted before it could complete.' };
      }

      const record = this.pulumi.readRunRecord(result.runId);
      const versionId = record?.tfvarsVersionId;
      if (!versionId) {
        // Should not happen — previewCore always writes tfvarsVersionId for
        // a successful plan run before returning (see this method's own
        // TSDoc). Defensive fallback so a genuinely unexpected gap surfaces
        // as a clear ack error rather than a "confirmed" ack the renderer
        // can't actually act on (it has nowhere to plan against next).
        logger.error('terraform rollback confirm: missing persisted tfvarsVersionId after a successful rollback plan', {
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
      logger.error('terraform rollback confirm error', { err, applyRunId: payload.applyRunId });
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
   * Reachable via the Electron IPC transport (`iac.lock.clear`), resolved by
   * the generic `ipcMain.handle` bridge in `../ipc-main-bridge.ts` — a plain
   * one-shot request/response (no streaming side channel), exactly like
   * `iac.rollback.resolve`.
   */
  @MessagePattern('iac.lock.clear')
  async clearStaleLock(): Promise<TerraformLockClearAck> {
    try {
      await this.pulumi.clearStaleLock();
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
