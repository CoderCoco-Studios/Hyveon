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
 * Fixed side-channel {@link IacController.confirmRollback} pushes
 * streamed rollback-plan output on. Added by task 7.10 (`migrate-iac-to-pulumi`):
 * `PulumiService.confirmRollback` (task 7.6) is an `AsyncGenerator` that
 * streams a real plan run internally (the restore-then-plan "one guarded
 * unit" design — see that method's own TSDoc), unlike the pre-migration
 * `TerraformService.confirmRollback`, which only ever did the restore write
 * and resolved a single value. Nothing subscribes to this channel yet — the
 * renderer's `RollbackAction` component (Phase 8/9's job to update) still
 * only awaits `confirmRollback`'s resolved ack (see that method's own TSDoc,
 * "Streaming vs. the renderer's existing one-shot contract") — but the
 * plumbing exists now so a long-running restore+plan isn't a total black box
 * for a future caller that wants to watch it live, mirroring
 * {@link PLAN_CHUNK_CHANNEL}'s shape exactly.
 */
const ROLLBACK_CONFIRM_CHUNK_CHANNEL = 'iac.rollback.confirm.chunk';

/**
 * Backend configuration values the first-run wizard used to pass to
 * `terraform init -backend-config=...` for the S3 remote-state backend.
 * Defined locally (moved out of the now-deleted `TerraformService.ts` by
 * task 7.10) purely to keep {@link IacController.init}'s payload type
 * — and therefore the `iac.init` IPC contract's shape — unchanged
 * while the method body itself becomes an inert rejection (see {@link init}'s
 * own TSDoc for why the channel is kept wired but no longer does anything).
 */
interface TerraformInitConfig {
  bucket: string;
  region: string;
  dynamodbTable: string;
}

/**
 * Immediate acknowledgement `init()` resolves with. `started: true` means the
 * streaming loop was kicked off in the background (chunk/end messages will
 * follow on the side channels, tagged with `streamId`). `started: false`
 * means `config` failed validation, OR — since task 7.10 — that `config`
 * passed validation but `init()` is a no-op under the Pulumi engine (see
 * {@link IacController.init}'s own TSDoc); either way no run was
 * attempted and `streamId` is omitted.
 */
interface TerraformInitAck {
  started: boolean;
  streamId?: string;
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
 * Immediate acknowledgement `plan()` resolves with. `started: true` means a
 * `runId` was pre-minted and the streaming loop was kicked off in the
 * background (chunk/end messages will follow on the side channels, tagged
 * with that same `runId`). `started: false` means the submission was
 * rejected before any `PulumiService.preview` run was attempted and no
 * `runId` is present — `error` is a human-readable description of why, and
 * `conflict` additionally names the already-running operation
 * (`preview`/`up`/`destroy`/`rollback`) when the rejection was specifically
 * because the shared workspace was busy (see
 * `PulumiService.getOperationInFlight()`).
 */
interface TerraformPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
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
 * run's stored `planHash` by `PulumiService.apply`'s own self-contained gate
 * (task 7.2) — this controller no longer re-derives or pre-checks any of
 * that itself; see {@link apply}'s own TSDoc.
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
 * `result` is present only on a successful run.
 */
interface TerraformApplyEndMessage {
  runId: string;
  exitCode: number | null;
  error?: string;
  result?: PulumiUpResult;
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
 * `result` is present only on a successful run.
 */
interface TerraformDestroyEndMessage {
  runId: string;
  exitCode: number | null;
  error?: string;
  result?: PulumiDestroyResult;
}

/**
 * IPC-only Terraform controller. Handles Electron main-process messages via
 * `@MessagePattern` — no HTTP routes are registered here.
 *
 * Task 7.10 (`migrate-iac-to-pulumi`) repointed every orchestration call site
 * in this file from the deleted `TerraformService` onto `PulumiService`
 * (Phase 7's Automation-API-backed replacement). The channel names, payload
 * shapes, and streaming/side-channel bridging pattern below are all
 * unchanged from before that repoint (Phase 8's job, not this one, per the
 * `migrate-iac-to-pulumi` change's own scoping) — what changed is which
 * service backs each handler, and (where the new service's methods are
 * self-contained gates rather than thin CLI wrappers — {@link apply},
 * {@link destroy}) how much pre-flight bookkeeping this controller still
 * needs to do itself. See each method's own TSDoc for the specifics.
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
 * 8-step gate (task 7.2) is entirely self-contained — this controller no
 * longer performs any of the plan-hash/approval/lock pre-checks it used to;
 * it awaits the gate's own outcome (the generator's first `.next()`) before
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
   * own internal plan-record lookup, which no longer goes through this
   * controller at all — task 7.10). `config` backs {@link output}'s preferred
   * `ConfigService.getStackOutputs()` delegate (falling back to
   * `PulumiService.getStackOutputs()` directly when unavailable — see that
   * method's own TSDoc).
   *
   * Unlike the pre-migration version of this controller, there is no
   * `RunService` dependency here any more: `PulumiService.apply`/`.destroy`'s
   * self-contained gates (task 7.2/7.3) acquire and release the durable apply
   * lock entirely internally now, so this controller has nothing left to do
   * with `RunService` directly.
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
   * four channels from the generic bridge for the same reason: each handler
   * pushes follow-up chunk/end messages over side channels for the duration
   * of a long-running run rather than resolving a single value.
   *
   * `iac.init` is deliberately NOT registered here (unlike before task
   * 7.10) — {@link init} no longer streams anything (see its own TSDoc), so
   * it's resolved by the generic `ipcMain.handle` bridge like any other
   * single-value channel; only `iac.plan`/`iac.apply`/
   * `iac.destroy`/`iac.rollback.confirm` still need this manual
   * registration.
   *
   * `iac.rollback.confirm` was added to this set in task 7.10 fix
   * round 1: {@link confirmRollback}'s own `ctx: { evt }` second parameter
   * has no `@Payload()`/etc. decorator, exactly like `plan`/`apply`/`destroy`
   * — so leaving it off the generic bridge meant NestJS's `RpcContextCreator`
   * sized its `initialArgs` array to the one decorated parameter it saw
   * (`@Payload()` at index 0) and silently dropped `ctx`, which arrived as
   * `undefined` at runtime. Every real invocation then threw
   * `TypeError: Cannot read properties of undefined (reading 'evt')` on
   * {@link confirmRollback}'s first line inside its own `try` — a crash the
   * unit tests never caught because they all call
   * `controller.confirmRollback(payload, ctx)` directly, bypassing the
   * transport layer this bridge exists to fix.
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
    // the same reason (task 7.10 fix round 1 — see this method's own TSDoc
    // for the crash this closes).
    ipcMain.removeHandler('iac.rollback.confirm');
    ipcMain.handle('iac.rollback.confirm', (evt, payload: TerraformRollbackPayload) =>
      this.confirmRollback(payload, { evt: evt as IpcMainInvokeEvent }),
    );
  }

  /**
   * `iac.init` under the Pulumi engine — a deliberate, documented
   * no-op rejection, not a real operation (task 7.10 decision).
   *
   * Pulumi has no analogue to `terraform init`: `PulumiEngineService`
   * auto-installs/resolves the Pulumi engine binary on first use, and
   * `PulumiWorkspaceService` constructs the Automation API workspace/backend
   * on demand — neither requires a separate, explicit initialization step an
   * operator triggers from the wizard. Rather than deleting this channel
   * (which would break `ipcRenderer.invoke('iac.init', ...)` for
   * whatever caller still reaches it — the first-run wizard's init-dependent
   * prerequisite step is real, already-shipped code that Phase 8/9 haven't
   * repointed yet) or silently reporting success (which would let the wizard
   * believe a real initialization happened and advance past a step that did
   * nothing), this method now always resolves `{ started: false, error }` —
   * for VALID `config` exactly as much as for invalid `config` — naming the
   * Pulumi engine as the reason no `terraform init` ran. This is an accepted
   * interim state, not this dispatch's job to design a real fix for: the
   * wizard's init-dependent prerequisite flow is "effectively broken"
   * mid-migration and Phase 10 owns replacing it properly (see the
   * `migrate-iac-to-pulumi` change's own notes). `config` validation is kept
   * unchanged ahead of the rejection so a malformed payload is still
   * diagnosed with its own specific message, exactly as it was before.
   *
   * Reachable via the Electron IPC transport (`iac.init`), resolved by
   * the generic `ipcMain.handle` bridge in `../ipc-main-bridge.ts` — this
   * channel no longer self-bridges (see {@link onModuleInit}'s own TSDoc)
   * since nothing is ever streamed any more.
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
   * check-and-set runs synchronously, before its own first `await`, exactly
   * like `TerraformService.plan`'s equivalent guard did before task 7.10's
   * repoint — so driving `.next()` here, with no `await` between the
   * `getOperationInFlight()` check above and this call, closes the same
   * TOCTOU gap that guard existed to close. The `.catch()` below exists
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
   * gate structure underneath it is fundamentally different since task 7.10:
   * `PulumiService.apply`'s 8-step gate (task 7.2) is entirely
   * self-contained — plan-record lookup, approval/expiry checks, plan-hash
   * verification (both the stored-hash comparison and the on-disk artifact
   * re-hash), engine-version check, and the durable apply-lock reservation
   * (`RunLockService.createRun`, task 7.7's atomic compare-and-set) all
   * happen INSIDE `PulumiService.apply` itself, not split across this
   * controller and the service the way `IacController.apply` and
   * `TerraformService.apply` used to split it.
   *
   * This means this controller must NOT reintroduce any of that gate's
   * checks itself (per this dispatch's own scoping ruling — the gate is the
   * single, authoritative place those checks live now) — it only needs to
   * know that the gate is entirely synchronous-relative-to-yielding: every
   * one of `PulumiService.apply`'s 8 steps runs to completion before the
   * generator's first `yield` (the first real chunk of `stack.up()`'s
   * output) ever happens. So the first `.next()` call on the returned
   * generator either REJECTS (any gate-step failure — most importantly
   * `RunLockHeldError`, propagated unwrapped by gate step 8's losing race,
   * mapped below to `conflict: 'up'`; or `PulumiOperationInFlightError`,
   * thrown by the gate's own top-of-function `operationInFlight` busy check,
   * mapped to `conflict: <its own inFlight value>` — I2, fix round 1: this
   * cheaper, earlier in-process mutex check needs the exact same `conflict`
   * treatment as the durable lock race, since the renderer's busy banner
   * reads `ack.conflict` regardless of which guard refused the submission)
   * or RESOLVES with the operation genuinely under way. This method exploits
   * that: it `await`s the first `.next()` call BEFORE acking, so
   * `{ started: true, runId }` is only ever returned once the gate has
   * actually passed — a stronger, more accurate guarantee than the
   * pre-migration controller's ack ever gave (that version's ack could
   * resolve `started: true` before some pre-spawn failures were even known,
   * deferring them to the end channel instead).
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
        // Mirrors plan()'s pre-flight conflict shape (I2, fix round 1): the
        // in-process operationInFlight mutex is a cheaper, earlier-checked
        // guard than the durable RunLockHeldError race above, but a busy
        // refusal from it must populate `conflict` exactly the same way —
        // the renderer's busy banner (terraform.page.tsx) reads ack.conflict
        // regardless of which of the two guards refused the submission.
        logger.error('terraform apply rejected: workspace busy', { planRunId: payload.planRunId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
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
    // `versionId` is attached — unlike before task 7.10, this controller no
    // longer looks up the plan record itself (that's the gate's job now), so
    // it has nothing extra worth a second redundant `getByRunId` call purely
    // for audit metadata.
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
          const message: TerraformApplyEndMessage = { runId, exitCode: null, error: String(err) };
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
   * Like {@link apply}, `PulumiService.destroy`'s gate (task 7.3) is entirely
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
   * mapped to `conflict: <its own inFlight value>` — I2, fix round 1, mirrors
   * {@link apply}'s identical treatment)
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
        // Mirrors apply()'s equivalent branch (I2, fix round 1) — see that
        // catch block's comment for why the in-process mutex needs the same
        // `conflict` treatment as the durable RunLockHeldError race above.
        logger.error('terraform destroy rejected: workspace busy', { runId, inFlight: err.inFlight });
        return { started: false, error: err.message, conflict: err.inFlight };
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
          const message: TerraformDestroyEndMessage = { runId, exitCode: null, error: String(err) };
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
   * ## Return shape change (task 7.10 decision)
   *
   * Before task 7.10, this delegated to `TerraformService.output()`, which
   * ran `terraform output -json` and projected the result through
   * `projectTfOutputs` into the local, Terraform-tfstate-shaped `TfOutputs`
   * type. That entire code path depended on a local `terraform.tfstate` file
   * existing — there is no Pulumi analogue (a Pulumi-orchestrated stack's
   * state lives in the DIY S3 backend, never as a local file this app reads
   * directly), so preserving `TfOutputs`'s exact shape here is not possible
   * without inventing a synthetic mapping with no real backing data. This
   * method now returns `StackOutputs` (`@hyveon/shared`) instead — the type
   * `ConfigService.getStackOutputs()`/`PulumiService.getStackOutputs()`
   * already established as the canonical "what a deployed stack looks like"
   * shape and every OTHER controller in this codebase already returns to the
   * renderer (`GamesController`, `DiscordController`, `CostsController`,
   * `EnvController`, etc. — task 6.x's migration). Verified this is safe:
   * nothing in `@hyveon/web`'s production code reads `iac.output`'s
   * result today (only a screenshot-demo fixture resolves it to `null`), and
   * the preload/renderer contract is otherwise untouched (Phase 8's job) —
   * see the `migrate-iac-to-pulumi` change's task 7.10 report for the full
   * investigation.
   *
   * ## `force` (task 7.10 decision: kept in the payload, ignored)
   *
   * `payload.force` used to bypass `TerraformService.output()`'s own 60s
   * in-memory cache and force a fresh `terraform output -json` spawn — most
   * usefully right after an `apply`/`destroy` completed, where the caller
   * knows the outputs may have changed. That specific need is now handled
   * automatically: `PulumiService.apply`/`.destroy` both call
   * `ConfigService.invalidateCache()` on a successful settlement (task 7.4's
   * carried-forward cache-invalidation requirement — see those methods' own
   * TSDoc, "Cache invalidation"), so the next `getStackOutputs()` call after
   * a real change already misses its cache with no caller-supplied bypass
   * needed. `force` is kept in {@link TerraformOutputPayload} rather than
   * removed — a payload-shape change is Phase 8's job, not this dispatch's
   * (per the `migrate-iac-to-pulumi` change's own scoping), and keeping an
   * already-optional field that's now a no-op is strictly safer than
   * dropping it out from under a caller that still sends it — but is
   * otherwise unused here.
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
   * actual write to `RunRecordService.approveRun` (see issue #109). Entirely
   * unaffected by task 7.10's repoint — this method never called
   * `TerraformService` before and doesn't call `PulumiService` now; it only
   * ever touched `RunRecordService`/`AuditService`.
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
   * `PulumiService.resolveRollbackTarget`, an identical signature and return
   * shape to the pre-migration `TerraformService.resolveRollbackTarget` this
   * replaces (trivial swap, task 7.10). Called when the operator clicks
   * "Rollback" on an apply row in history, so the confirmation dialog can
   * name the version it would restore before the operator commits to it.
   *
   * Reachable via the Electron IPC transport (`iac.rollback.resolve`),
   * bridged automatically by the generic `ipcMain.handle` bridge since it
   * resolves a single value rather than streaming progress.
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
   * Confirms the rollback flow (#112) for `payload.applyRunId` — the one
   * genuinely shape-breaking repoint in task 7.10.
   *
   * ## Streaming vs. the renderer's existing one-shot contract
   *
   * Pre-migration, `TerraformService.confirmRollback` was a plain
   * `Promise`-returning method that only did the historic-configuration
   * restore write and returned `{ versionId }`; the renderer's own
   * `RollbackAction` component then made a SEPARATE, ordinary `iac.plan`
   * call passing that `versionId` (see `@hyveon/web`'s `terraform.page.tsx`,
   * `RollbackNavState`) to actually queue a plan against the restored
   * version. `PulumiService.confirmRollback` (task 7.6) closes exactly the
   * gap that two-call split left open (see that method's own TSDoc, "The old
   * `TerraformService` gap this closes") by fusing the restore AND the
   * follow-up plan into one guarded unit, held under the SAME
   * `operationInFlight` lock for its entire duration — so it's now an
   * `AsyncGenerator` that streams a real plan run internally, exactly like
   * {@link plan} does, not a one-shot `Promise`.
   *
   * This method reconciles that with the renderer's still-unchanged (Phase
   * 8/9's job, not this dispatch's) expectation that `iac.rollback.confirm`
   * resolves a single `TerraformRollbackConfirmAck` and that a SEPARATE
   * `iac.plan` call is still what actually queues the plan the
   * operator watches: it drives `PulumiService.confirmRollback`'s generator
   * to completion INTERNALLY (via a manual `.next()` loop, mirroring
   * {@link plan}'s manual-drive shape so `PulumiPreviewResult` — the
   * generator's return value — is reachable), forwarding every intermediate
   * chunk on the new {@link ROLLBACK_CONFIRM_CHUNK_CHANNEL} purely as a
   * forward-compatible bonus (no current subscriber), and only resolves this
   * method's own `Promise` once the WHOLE restore+plan unit has settled.
   *
   * **Known, accepted consequence, not silently swallowed**: because the
   * renderer's `RollbackAction`/`TerraformPage` still submit a follow-up
   * `iac.plan` call after a successful `confirmRollback` ack (exactly
   * as they did before), and `PulumiService.confirmRollback` now ALSO runs a
   * real plan internally as part of the restore, a successful rollback
   * produces TWO `PulumiRunRecord`s tagged `rolledBackFrom: applyRunId` — the
   * one this method's internal generator just completed (whose `runId`
   * isn't surfaced to the renderer at all today) and the one the renderer's
   * own subsequent `iac.plan` call starts (which IS what the operator
   * actually sees and can approve/apply). This is wasteful (a redundant
   * `pulumi preview` invocation and an orphaned, browsable-but-unreferenced
   * run-history entry) but not incorrect from the renderer's point of view —
   * every existing rollback flow still completes successfully end-to-end.
   * Closing this duplication requires updating the renderer to consume
   * `confirmRollback`'s already-completed plan directly instead of
   * re-submitting one — explicitly Phase 8/9's job (this dispatch's
   * constraints forbid touching the renderer), not solved here.
   *
   * The restored configuration version id the renderer needs
   * (`TerraformRollbackConfirmAck.versionId`) is NOT a field of
   * `PulumiPreviewResult` (which describes the plan artifact, not the
   * configuration version it ran against) — it's recovered via
   * `PulumiService.readRunRecord(result.runId)` (task 7.10's own new
   * accessor) once the generator settles, reading back the
   * `PulumiRunRecord.tfvarsVersionId` that `PulumiService`'s internal
   * `previewCore` call persisted for this exact run (guaranteed present:
   * `previewCore` always records the configuration version id it actually
   * observed for a successful plan before returning).
   *
   * Reachable via the Electron IPC transport (`iac.rollback.confirm`).
   * Despite ultimately resolving a single `TerraformRollbackConfirmAck`, this
   * channel is bridged manually by {@link onModuleInit} (task 7.10 fix round
   * 1), not by the generic `ipcMain.handle` bridge — see that method's own
   * TSDoc and `SELF_BRIDGED_PATTERNS` in `../ipc-main-bridge.ts` for why: the
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
