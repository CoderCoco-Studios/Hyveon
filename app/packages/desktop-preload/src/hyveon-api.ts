/**
 * Typed shape of the `window.hyveon` object exposed by the Electron preload script.
 *
 * Import this interface in the renderer process to get fully-typed access to the
 * IPC bridge without importing anything from `electron` or Node.js.
 *
 * Keep this file in sync with the `contextBridge.exposeInMainWorld('hyveon', {...})`
 * call in `src/preload.ts` — the two must always agree on method signatures and
 * namespace names.
 */

import type {
  AutoUpdateSettingGetResult,
  AutoUpdateSettingUpdatePayload,
  AutoUpdateSettingWriteResult,
  ChangeSummary,
  DeploymentConfigDiff,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  CostEstimates,
  ExportDiagnosticsBundleResult,
  GameEstimate,
  GameServerHealthCheckAuth,
  GameServerPort,
  GameServerEnvironmentVariable,
  GameServerVolume,
  GameServerFileSeed,
  GameServerHealthCheckAuthWriteInput,
  GameServerHealthCheckCondition,
  GameServerHealthCheck,
  RedactedGameServerHealthCheck,
  GameServerHealthCheckWriteInput,
  GameServer,
  RedactedGameServer,
  GameServerWriteConfig,
  GameListEntry,
  GameServerValidationIssue,
  GameWriteSuccess,
  GameWriteConflict,
  GameWriteValidationFailure,
  GameWriteNotFound,
  GameWriteSetupIncomplete,
  GameWriteFailure,
  GameWriteResult,
  CreateGamePayload,
  UpdateGamePayload,
  DeleteGamePayload,
  GameWizardDraft,
  StoredGameWizardDraft,
  StoredResolvedGameWizardDraft,
  GameStatus,
  LambdaFunctionKey,
  ManualUpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateInstallResult,
  OpType,
  RedactedDiscordConfig as SharedRedactedDiscordConfig,
  PulumiEngineVersionResult,
  RendererConsoleLevel,
  RendererLogEntry,
  RunLock,
  StackOutputs,
  StartResult,
  TopLevelDeploymentSettings,
  UpdateDeploymentSettingsPayload,
  DiscordAdmins,
  DiscordGamePermission,
  DriftKind,
  DriftChangedField,
  DriftEntry,
  DriftReport,
  AuditAction,
  AuditEntry,
  AuditPageResult,
  RunDetailStatus,
  RunStatus as RunHistoryStatus,
  RunRecord as RunHistoryRecord,
  RunPageResult as RunHistoryPageResult,
  RunKind as IacRunKind,
  WizardStep as WizardStepName,
} from '@hyveon/shared';
import type {
  FolderOverwriteDecisionResult,
  FolderScanResult,
  FolderUploadProgress,
  FolderUploadRequest,
  FolderUploadStartResult,
  FolderUploadStoredState,
  StrayHelperReport,
} from '@hyveon/shared/folderUpload';
import type {
  VolumeEntryInfo,
  VolumeListing,
  VolumeResult,
  VolumeSessionStatus,
  VolumeTextFile,
  VolumeTransferProgress,
} from '@hyveon/shared/volumeFiles';

/**
 * Re-exported verbatim from `@hyveon/shared` rather than duplicated —
 * deliberately deviating from every other `Iac*` type in this file's
 * usual "duplicate the shape + `Mirrors X — keep in sync` TSDoc" convention.
 * That convention exists to isolate the preload from the `@pulumi/pulumi`
 * Automation API's own types leaking across the IPC boundary — but
 * `ChangeSummary`/`OpType` (`@hyveon/shared/src/changeSummary.ts`) is
 * ALREADY that hand-maintained isolation layer, not a raw SDK re-export
 * (that file's own TSDoc explains it deliberately duplicates rather than
 * imports `@pulumi/pulumi/automation`'s `OpType`/`OpMap` byte-for-byte, for
 * exactly this reason). `@hyveon/web` already depends on `@hyveon/shared`
 * directly elsewhere, so re-exporting here avoids a 15-member `OpType`
 * union silently drifting out of sync between two independently
 * hand-maintained copies. Do not "fix" this back to duplication.
 *
 * Every other type below joins this re-exported group for the same reason: each is a pure data
 * shape with no `@pulumi/pulumi`/Node dependency to isolate the renderer from, so re-exporting
 * avoids the same drift risk as hand-duplicating its fields here.
 */
export type {
  AutoUpdateSettingGetResult,
  AutoUpdateSettingUpdatePayload,
  AutoUpdateSettingWriteResult,
  ChangeSummary,
  DeploymentConfigDiff,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  CostEstimates,
  ExportDiagnosticsBundleResult,
  GameEstimate,
  GameServerHealthCheckAuth,
  GameServerPort,
  GameServerEnvironmentVariable,
  GameServerVolume,
  GameServerFileSeed,
  GameServerHealthCheckAuthWriteInput,
  GameServerHealthCheckCondition,
  GameServerHealthCheck,
  RedactedGameServerHealthCheck,
  GameServerHealthCheckWriteInput,
  GameServer,
  RedactedGameServer,
  GameServerWriteConfig,
  GameListEntry,
  GameServerValidationIssue,
  GameWriteSuccess,
  GameWriteConflict,
  GameWriteValidationFailure,
  GameWriteNotFound,
  GameWriteSetupIncomplete,
  GameWriteFailure,
  GameWriteResult,
  CreateGamePayload,
  UpdateGamePayload,
  DeleteGamePayload,
  GameWizardDraft,
  StoredGameWizardDraft,
  StoredResolvedGameWizardDraft,
  GameStatus,
  LambdaFunctionKey,
  ManualUpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateInstallResult,
  OpType,
  PulumiEngineVersionResult,
  RendererConsoleLevel,
  RendererLogEntry,
  RunLock,
  StartResult,
  TopLevelDeploymentSettings,
  UpdateDeploymentSettingsPayload,
  DiscordAdmins,
  DiscordGamePermission,
  DriftKind,
  DriftChangedField,
  DriftEntry,
  DriftReport,
  AuditAction,
  AuditEntry,
  AuditPageResult,
  RunDetailStatus,
  RunHistoryStatus,
  RunHistoryRecord,
  RunHistoryPageResult,
  IacRunKind,
  WizardStepName,
};

/**
 * One CloudWatch log event line — carries its own timestamp and identity so
 * a caller (`useLogTail`) can always derive its next backward/forward paging
 * boundary from the actual current boundary element of whatever window it
 * has loaded, rather than trusting a separately-tracked scalar that can go
 * stale after client-side eviction.
 *
 * Mirrors `LogEventLine` in `@hyveon/desktop-main/src/services/LogsService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface LogEventLine {
  /** The log line's text. */
  message: string;
  /** CloudWatch event timestamp, epoch ms. */
  timestamp: number;
  /** `${timestamp}:${message}` identity, synthesized because `GetLogEventsCommand` carries no real `eventId`. */
  eventId: string;
}

/** Log lines for a game's ECS task. Each line carries its own CloudWatch timestamp for seeding a subsequent backward backfill call (`lines[0]?.timestamp`). */
export interface GameLogs {
  game: string;
  lines: LogEventLine[];
}

/** A single chunk of streamed log text delivered over IPC. */
export type LogChunk = string;

/**
 * ContextBridge-safe async-iterable handle for a streaming IPC channel
 * (`logs.stream`, `iac.stack.initialize`, `iac.runs.streamLogs`).
 *
 * Electron's `contextBridge` structured-clones every value that crosses the
 * isolated-world boundary. A raw `AsyncGenerator` is not structured-cloneable
 * — a bridged function that returns one throws synchronously with
 * `Uncaught Error: An object could not be cloned.` the moment the renderer
 * calls it, and the generator body never executes. This plain object — an
 * own `next()` function, an own `cancel()` function, and an own
 * `[Symbol.asyncIterator]` function returning itself — was empirically
 * verified to survive the clone boundary intact (functions proxy across the
 * bridge fine; a plain object with own function/symbol-keyed properties
 * clones as a plain object retaining those properties as live proxies to the
 * preload-side functions). It satisfies both `AsyncIterable<T>` and
 * `AsyncIterator<T>`, so it can be consumed directly with
 * `for await (const chunk of handle)`.
 *
 * Cancellation is a `cancel()` method rather than an `AbortSignal` parameter:
 * `AbortSignal` instances also don't survive the `contextBridge` clone —
 * their prototype getters (`aborted`) and methods (`addEventListener`) are
 * stripped, leaving an inert plain object with no own enumerable keys, so a
 * preload-side `signal.addEventListener(...)` call throws
 * `TypeError: signal.addEventListener is not a function` the instant the
 * renderer passes one across. Call `cancel()` from a `useEffect` cleanup /
 * `finally` block instead of aborting a controller and passing its signal in.
 */
export interface HyveonStreamHandle<T> {
  /**
   * Resolves the next chunk, or a result whose `done` is `true` once the
   * stream ends (successfully or via {@link cancel}). Shaped exactly like the
   * lib-standard `AsyncIterator<T>['next']` result — a discriminated union on
   * `done`, carrying `value` only on the non-done branch — so TypeScript
   * narrows the element type of a `for await (const chunk of handle)` loop to
   * `T`, not `T | undefined`. This is deliberately not a single object type
   * with both fields optional, which would lose that narrowing. On the
   * terminal (done) result, `value` is always absent in practice: the bridge
   * clone drops object properties whose value is `undefined` in transit, and
   * these streams never resolve their return value to anything else.
   */
  next: () => Promise<{ done?: false; value: T } | { done: true; value?: undefined }>;
  /**
   * Stops consuming the stream. A per-call log stream (`logs.stream`, `logs.lambda.stream`) also tells the main
   * process to abort its source; a shared side-channel stream (`iac.stack.initialize`, `iac.runs.logs`,
   * `iac.settings.autoUpdate.download`) only stops the local drain, and the main-process work runs to completion.
   * Safe to call more than once and safe to call after the
   * stream has already ended on its own.
   */
  cancel: () => void;
  /** Closes the stream; a `for await` loop calls it when the consumer breaks out early, with the same effect as {@link cancel}. */
  return?: () => Promise<{ done: true; value?: undefined }>;
  /** Returns itself, so the handle is directly usable in a `for await (const chunk of handle)` loop. */
  [Symbol.asyncIterator]: () => HyveonStreamHandle<T>;
}

/**
 * Discord config returned to the renderer: the shared redacted shape (secrets as `botTokenSet` / `publicKeySet`
 * booleans) plus the interactions Function URL the controller reads from Pulumi stack outputs (`null` before apply).
 */
export type RedactedDiscordConfig = SharedRedactedDiscordConfig & {
  interactionsEndpointUrl: string | null;
};

/** Result of a guild allowlist mutation. */
export interface GuildListResult {
  success: boolean;
  guilds: string[];
  baseGuilds: string[];
}

/** Result of registering slash commands for a guild. */
export interface RegisterResult {
  success: boolean;
  message: string;
}

/** Result of updating admin lists. */
export interface AdminsResult {
  success: boolean;
  admins: DiscordAdmins;
  baseAdmins: DiscordAdmins;
}

/** Result of setting or deleting a game permission entry. */
export interface PermissionsResult {
  success: boolean;
  permissions: Record<string, DiscordGamePermission>;
}

/** Result of updating Discord credentials (put-config). */
export interface PutConfigResult {
  success: boolean;
  config: RedactedDiscordConfig;
}

/** Environment metadata derived from Pulumi stack outputs. */
export interface EnvInfo {
  region: string;
  domain: string;
  environment: string;
}

/**
 * A single line of output from a streamed Pulumi run, tagged with the stream
 * it came from.
 *
 * Structurally identical to `PulumiRunChunk` in
 * `@hyveon/desktop-main/src/services/PulumiService.ts` — that file is the
 * source of truth; keep this copy in sync with it. Named `IacRunChunk` to
 * match this preload's namespace, `hyveon.iac`.
 */
export interface IacRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * One of the three coarse provisioning phases `PulumiService.initializeStack`
 * reports progress for. Mirrors `PulumiProvisioningPhase` in
 * `@hyveon/desktop-main/src/services/PulumiEngineService.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export type StackInitPhase = 'engine' | 'plugins' | 'operation';

/**
 * Whether a {@link StackInitPhase} is beginning or has settled (success or
 * failure alike). Mirrors `PulumiPhaseStatus` in
 * `@hyveon/desktop-main/src/services/PulumiEngineService.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export type StackInitPhaseStatus = 'start' | 'end';

/**
 * One phase-transition event streamed by the `iac.stack.initialize` IPC
 * channel — the element type of {@link HyveonIacStackApi.initialize}'s
 * returned {@link HyveonStreamHandle}.
 */
export interface StackInitPhaseEvent {
  phase: StackInitPhase;
  status: StackInitPhaseStatus;
}

/**
 * Persisted local run record for a finished plan/apply/destroy run — a
 * lightweight run history entry written once the run has settled. Returned
 * on the `record` field of `iac.runs.get`'s result.
 *
 * Mirrors `PulumiRunRecord` in
 * `@hyveon/desktop-main/src/services/PulumiService.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface IacRunRecord {
  /** The `runId` this record describes — matches the directory it's written into. */
  runId: string;
  /** Which subcommand produced this record. */
  kind: IacRunKind;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The configuration version id the applied plan was generated against, if the caller supplied one. */
  configVersionId?: string;
  /**
   * SHA-256 hex digest of the persisted `.tfplan` artifact this record's
   * `plan` run produced. Set only on a successful `plan` record; a failed
   * or aborted `plan` run (and `apply`/`destroy` records generally) leave
   * this unset. The `/iac` page (`IacPage`) passes this straight through to
   * `hyveon.iac.apply`'s `planHash` payload field.
   */
  planHash?: string;
  /** The `runId` of the `apply` run this plan rolled back, if started via the rollback flow. */
  rolledBackFrom?: string;
  /**
   * Structured resource-change summary the Pulumi engine reported for this
   * run, mirroring `PulumiRunRecord.changeSummary`. Absent/`{}` means "the
   * engine's structured summary event was never observed for this run" —
   * NOT "this operation made no changes" (a genuine no-op reports
   * `{ same: N }`). Never collapse the two — see `ChangeSummary`'s own
   * TSDoc (`@hyveon/shared/src/changeSummary.ts`) for the full sharp edge.
   */
  changeSummary?: ChangeSummary;
  /** The Pulumi engine version this run executed against, mirroring `PulumiRunRecord.engineVersion`. */
  engineVersion?: string;
  /**
   * `true` when the run's Pulumi engine settled with some resources having
   * already been mutated before the failure/abort — check this field
   * directly, independent of which non-`'success'` status the run settled
   * with, mirroring `PulumiRunRecord.partialApply`'s own doc comment. This
   * type deliberately does not surface the underlying per-resource step list
   * (`PulumiPartialApplyError.completedSteps`) — this boolean is sufficient
   * to surface partial-apply failures with re-plan guidance; granular step
   * detail is a future UI decision.
   */
  partialApply?: boolean;
}

/**
 * Result of the `iac.runs.get` IPC channel: `found: false` when the
 * requested `runId` is neither the currently in-flight run nor a persisted
 * {@link IacRunRecord} on disk. `found: true` always carries the
 * derived {@link RunDetailStatus}; `record` is present only once the run has
 * produced a persisted {@link IacRunRecord} (i.e. every status except
 * `running`, since a run in flight hasn't closed its process yet).
 *
 * Mirrors `IacRunsGetResult` in
 * `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export type IacRunsGetResult =
  | { found: false }
  | { found: true; status: RunDetailStatus; record?: IacRunRecord };

/**
 * Result of `iac.runs.record`: the persisted history record for the run, when one exists.
 *
 * Mirrors `IacRunsRecordResult` in `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts`, which is the source of
 * truth.
 */
export type IacRunsRecordResult = { found: false } | { found: true; record: RunHistoryRecord };

/** Options accepted by the `iac.runs.list` IPC channel. */
export interface IacRunsListOpts {
  /** Requested page size; the main process clamps to `[1, 100]` and defaults to `25` when omitted or invalid. */
  limit?: number;
  /** Cursor (a {@link RunHistoryRecord.sk} value) to fetch the page older than. */
  before?: string;
  /** When provided, only runs with this status are returned. */
  status?: RunHistoryStatus;
}

/**
 * Payload accepted by the `iac.plan` IPC channel. `configVersionId`,
 * when the configured configuration source is S3-backed, is forwarded
 * verbatim to `PulumiService.preview`'s pre-spawn staleness check against the
 * current head version of the configuration object.
 *
 * Mirrors `IacPlanPayload` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacPlanPayload {
  configVersionId?: string;
  /** The `runId` of the `apply` run being rolled back, if this plan was started via the rollback flow. */
  rolledBackFrom?: string;
}

/**
 * Holder/age evidence for one lock entry parsed off a Pulumi backend lock
 * conflict — the preload-side mirror of the main process's `StaleLockInfo`
 * (`@hyveon/desktop-main/src/controllers/iac.controller.ts`), which itself
 * mirrors `PulumiStackLockInfo`
 * (`@hyveon/desktop-main/src/services/PulumiLockRecovery.ts`) with
 * `lockedAt` serialized to an ISO string rather than a `Date` — a raw `Date`
 * does not survive Electron's IPC structured-clone/contextBridge boundary
 * reliably.
 */
export interface IacStaleLockHolder {
  lockUrl: string;
  username: string;
  hostname: string;
  pid: number;
  lockedAt: string;
}

/**
 * Present on {@link IacPlanAck}/apply/destroy results instead of (or
 * alongside) `error` when the rejection was `PulumiUnrecognizedLockError` —
 * a Pulumi backend lock conflict that couldn't be proven to be this
 * installation's own orphaned run. Carries only the holder/age evidence so
 * the renderer can render it instead of only `error`'s prose; clearing the
 * lock is a separate write path on the `iac.lock.clear` channel (see
 * {@link HyveonIacLockApi.clear}), gated on the operator explicitly
 * confirming the lock is genuinely stale.
 */
export interface IacStaleLockInfo {
  stackName: string;
  locks: IacStaleLockHolder[];
}

/**
 * Immediate acknowledgement the `iac.plan` IPC channel resolves with.
 * `started: true` means a `runId` was minted and the run was kicked off in the background — the
 * streamed progress/final result are delivered separately over the `iac.plan.chunk`/`iac.plan.end`
 * side channels, tagged with this same `runId`; this preload does not currently listen on those
 * (or on `iac.apply.end`/`iac.destroy.end`), so this ack plus the bridged `iac.runs.get`/
 * `iac.runs.list` channels are the only paths to a plan's structured result today.
 *
 * `started: false` means the submission was rejected before any run was attempted (no `runId`):
 * `error` is a human-readable description; `conflict` names the already-running operation
 * (`preview`/`up`/`destroy`/`rollback`) when the workspace was busy; `staleLock` carries
 * holder/age evidence ({@link IacStaleLockInfo}) for an unrecognized Pulumi backend lock conflict
 * (`apply`/`destroy` only); `runLock` is present instead when the rejection was a
 * `RunLockHeldError` — the durable apply lock (`RunService`/`RunLockService`) already held by
 * another run, as opposed to `staleLock`'s Pulumi backend lock. Only `apply`/`destroy` can hit
 * either case; `plan` never acquires the durable lock. Clearing `runLock` is a separate write path
 * on `iac.runs.lock.clear` (see {@link HyveonIacRunsApi.lock}).
 *
 * Mirrors `IacPlanAck` in `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface IacPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
  staleLock?: IacStaleLockInfo;
  runLock?: RunLock;
}

/**
 * Result the `iac.rollback.resolve` IPC channel resolves with.
 * `resolved: true` carries the historic version identified as the rollback
 * target — `versionId`/`lastModified` — for the confirmation dialog to
 * display before anything is written. `resolved: false` means resolution
 * was rejected; `error` is always a human-readable description of why.
 *
 * `diff` is a best-effort addition: a {@link DeploymentConfigDiff}
 * summarizing how the target version differs from the current configuration
 * head, present when `resolved: true` and the backend could compute it.
 * Always treat an absent `diff` as "no diff available" — NOT as an error —
 * `resolved: true` with no `diff` is the normal, fully-successful shape of
 * this ack whenever the best-effort diff computation degrades; the
 * confirmation dialog must render normally without it.
 *
 * Mirrors `IacRollbackResolveAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacRollbackResolveAck {
  resolved: boolean;
  versionId?: string;
  lastModified?: string;
  diff?: DeploymentConfigDiff;
  /** Etag of the configuration head read at preview time; pass it back to `confirm` so the restore is conditional on it. */
  headEtag?: string;
  error?: string;
}

/**
 * Result the `iac.rollback.confirm` IPC channel resolves with.
 * `confirmed: true` means the historic configuration content was restored as
 * a new head version AND the follow-up plan run `PulumiService.confirmRollback`
 * runs internally also completed successfully — `versionId` is the restored
 * version's id. `confirmed: false` means either no write was attempted, or a
 * write was attempted and the restore-then-plan unit failed partway through
 * — `error` is always a human-readable description of why. **`versionId` is
 * ALSO populated on a `confirmed: false` result** specifically when the
 * failure is a `PulumiRollbackPlanFailedError` (the restore write succeeded
 * but the follow-up plan didn't) — it names the version that was actually
 * restored as the new head despite the result reporting failure, so a caller
 * can act on it (e.g. offer "plan against the restored version" as a next
 * step) instead of only reading it out of `error`'s prose.
 * `rollback-action.component.tsx`'s error-handling logic does not yet read
 * `versionId` in the failure branch — that UI improvement is still open.
 *
 * Mirrors `IacRollbackConfirmAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacRollbackConfirmAck {
  confirmed: boolean;
  versionId?: string;
  /** The rollback's single tagged plan run, set when `confirmed` is `true`; the renderer adopts it rather than planning again. */
  planRunId?: string;
  error?: string;
}

/**
 * Result the `iac.lock.clear` IPC channel resolves with, as part of the
 * stale-lock recovery flow. `cleared: true` means
 * `PulumiService.clearStaleLock` successfully called `stack.cancel()`
 * against the Pulumi backend — the operator should now resubmit their
 * original plan/apply/destroy via the normal button; this channel never
 * re-attempts it automatically. `cleared: false` means nothing was cleared
 * (another operation was already running against the shared workspace, the
 * backend isn't configured yet, or the clear attempt itself failed) —
 * `error` is always a human-readable description of why.
 *
 * Mirrors `IacLockClearAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacLockClearAck {
  cleared: boolean;
  error?: string;
}

/**
 * Payload accepted by the `iac.apply` IPC channel. `planRunId`
 * identifies the approved plan run to apply; `planHash` is the caller's
 * expected plan hash, checked against the plan run's stored `planHash` to
 * catch drift between when the plan was approved and when apply runs.
 *
 * Mirrors the request body `IacController.apply` (the `iac.apply` IPC
 * handler; this app has no HTTP transport) accepts — that desktop-main
 * handler is the source of truth; keep this copy in sync with it.
 */
export interface IacApplyPayload {
  planRunId: string;
  planHash: string;
}

/**
 * Result the `iac.destroy.mintToken` IPC channel resolves with —
 * `token` must be supplied back on {@link IacDestroyPayload.confirmationToken}
 * within its short expiry window (see `PulumiService.mintDestroyConfirmationToken`).
 *
 * Mirrors `IacDestroyMintAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacDestroyMintAck {
  token: string;
}

/**
 * Payload accepted by the `iac.destroy` IPC channel. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by `iac.destroy.mintToken` — enforced server-side, never
 * trusted from the client beyond this single round-trip.
 *
 * Mirrors `IacDestroyPayload` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacDestroyPayload {
  confirmationToken: string;
}

/**
 * Result the `iac.lock.clear.mintToken` IPC channel resolves with —
 * `token` must be supplied back on {@link IacLockClearPayload.confirmationToken}
 * within its short expiry window (see `PulumiService.mintLockClearConfirmationToken`).
 *
 * Mirrors `IacLockClearMintAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacLockClearMintAck {
  token: string;
}

/**
 * Payload accepted by the `iac.lock.clear` IPC channel. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by `iac.lock.clear.mintToken` — enforced server-side, never
 * trusted from the client beyond this single round-trip.
 *
 * Mirrors `IacLockClearPayload` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacLockClearPayload {
  confirmationToken: string;
}

/**
 * Result the `iac.runs.lock.clear.mintToken` IPC channel resolves with —
 * `token` must be supplied back on
 * {@link IacRunsLockClearPayload.confirmationToken} within its short expiry
 * window.
 *
 * Mirrors `IacRunsLockMintAck` in
 * `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacRunsLockMintAck {
  token: string;
}

/**
 * Payload accepted by the `iac.runs.lock.clear.mintToken` IPC channel.
 * `expectedRunId` must be the `runId` of the {@link RunLock} the caller
 * displayed to the operator (`IacPlanAck.runLock.runId` / the equivalent
 * apply/destroy ack field) — the server refuses to mint a token if the
 * currently held lock's `runId` no longer matches, closing the race where
 * that displayed lock was released and replaced by a different, legitimate
 * lock before the operator confirmed the clear.
 *
 * Mirrors `IacRunsLockMintPayload` in
 * `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface IacRunsLockMintPayload {
  expectedRunId: string;
}

/**
 * Payload accepted by the `iac.runs.lock.clear` IPC channel.
 * `confirmationToken` must be the most recently minted, unexpired,
 * not-yet-consumed value returned by `iac.runs.lock.clear.mintToken` —
 * enforced server-side, never trusted from the client beyond this single
 * round-trip.
 *
 * Mirrors `IacRunsLockClearPayload` in
 * `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts`.
 */
export interface IacRunsLockClearPayload {
  confirmationToken: string;
}

/**
 * Result the `iac.runs.lock.clear` IPC channel resolves with, as part of
 * the durable run-lock recovery flow. `cleared: true` means
 * `RunService.clearLock()` successfully released the in-memory/durable
 * apply lock; `cleared: false` means nothing was cleared (no lock was
 * currently held, or the clear attempt itself failed) — `error` is always
 * a human-readable description of why.
 *
 * Mirrors `IacRunsLockClearAck` in
 * `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts`.
 */
export interface IacRunsLockClearAck {
  cleared: boolean;
  error?: string;
}

/**
 * Immediate acknowledgement the `iac.approve` IPC channel resolves
 * with once the identified plan run has been marked approved. Mirrors
 * `IacApproveAck` in `@hyveon/desktop-main/src/controllers/iac.controller.ts`
 * — that type is the source of truth; keep this copy in sync with it.
 * `approved: true` means `RunRecordService.approveRun` succeeded and
 * `approvedBy`/`approvedAt` mirror the values stamped onto the persisted
 * `RunRecord`. `approved: false` means the request failed (invalid payload,
 * missing service, or a thrown error) — `error` carries a human-readable
 * description and `approvedBy`/`approvedAt` are omitted. Note there is no
 * `runId` field — the controller never returns one.
 */
export interface IacApproveAck {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  error?: string;
}

// Per-namespace sub-interfaces

/** Status of a single Cloud Health check, as surfaced by `cloudHealth.list`. */
export type CloudHealthCheckStatus = 'ok' | 'missing' | 'error';

/** One row's worth of data for the Settings page's Cloud Health checklist. */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

/** Outcome of attempting to fix a single Cloud Health check. */
export type CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed';

/** Result of a `cloudHealth.fix` call. */
export interface CloudHealthFixResult {
  outcome: CloudHealthFixOutcome;
  /** Present when `outcome` is `'needsPolicyUpdate'` — the current `HyveonDeployAll` policy JSON to apply. */
  policyJson?: string;
  /**
   * Present when `outcome` is `'needsPolicyUpdate'` — a direct link to the
   * `HyveonDeployAll` managed policy's edit page in the IAM console. Hand to
   * `cloudHealth.openPolicyConsole`.
   */
  policyConsoleUrl?: string;
  /** Present when `outcome` is `'needsPolicyUpdate'` — `true` when the policy lives in the guided CloudFormation stack and must be updated there. */
  policyManagedByStack?: boolean;
  /** Present when `outcome` is `'failed'` — an actionable, human-readable message. */
  message?: string;
}

/** Cloud Health checklist: lists AWS-account prerequisite checks and attempts one-click fixes. */
export interface HyveonCloudHealthApi {
  /** Runs every registered health check and returns one summary per check. */
  list: () => Promise<CloudHealthCheckSummary[]>;
  /** Attempts to fix the check with the given id. */
  fix: (id: string) => Promise<CloudHealthFixResult>;
  /** Writes `policyJson` to disk and returns the path it was written to. */
  downloadPolicy: (policyJson: string) => Promise<{ path: string }>;
  /** Opens `url` (an IAM console link) in the operator's default browser. */
  openPolicyConsole: (url: string) => Promise<OpenConsoleResult>;
}

/** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
export interface HyveonGamesApi {
  /** Lists games merged from the declared config (`gameServers`) and deployed state (tfstate). */
  list: () => Promise<{ games: GameListEntry[] }>;
  /** Returns ECS status for every game in parallel. */
  status: () => Promise<GameStatus[]>;
  /** Returns ECS status for a single game. */
  getStatus: (game: string) => Promise<GameStatus>;
  /** Launches the `{game}-server` ECS task. */
  start: (game: string) => Promise<StartResult>;
  /** Stops the running ECS task for `game`. */
  stop: (game: string) => Promise<StartResult>;
  /** Adds a new entry to the declared `gameServers` map. */
  create: (payload: CreateGamePayload) => Promise<GameWriteResult>;
  /** Overwrites an existing entry in the declared `gameServers` map. */
  update: (payload: UpdateGamePayload) => Promise<GameWriteResult>;
  /** Removes an entry from the declared `gameServers` map. */
  delete: (payload: DeleteGamePayload) => Promise<GameWriteResult>;
  /** Save/resume/discard endpoints for the single in-progress add-game wizard draft. */
  draft: {
    /**
     * Returns the saved draft, or `null` if none is saved. `environment[].value`
     * and `file_seeds[].content`/`content_base64` are blanked out by
     * `GameWizardDraftService.get()` on the main-process side before this
     * response is sent — those values never cross the IPC boundary, and the
     * operator re-enters them on resume.
     */
    get: () => Promise<StoredResolvedGameWizardDraft | null>;
    /** Saves the current draft and step index. */
    save: (payload: { draft: GameWizardDraft; stepIndex: number }) => Promise<void>;
    /**
     * Updates only the `stepIndex` of an already-saved draft, leaving the
     * stored `draft` fields untouched — used when the operator merely
     * navigates steps on a resumed draft without editing any field, so the
     * redacted (secret-blanked) in-memory copy the renderer holds is never
     * written back over the real, unredacted values still on disk. A no-op
     * if no draft is currently saved.
     */
    updateStepIndex: (stepIndex: number) => Promise<void>;
    /** Clears the saved draft. */
    clear: () => Promise<void>;
  };
}

/** Cost endpoints: forward-looking Fargate estimates. The app makes no AWS Cost Explorer API calls. */
export interface HyveonCostsApi {
  /** Estimates per-game and total hourly Fargate cost. */
  estimate: () => Promise<CostEstimates>;
}

/**
 * One page of CloudWatch events strictly older than the caller-supplied
 * `beforeTimestamp` boundary — the result of the `logs.getOlder` /
 * `logs.lambda.getOlder` IPC channels, backing the "load older logs on
 * scroll-up" backfill flow.
 *
 * Mirrors `OlderLogsPage` in `@hyveon/desktop-main/src/services/LogsService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface OlderLogsPage {
  /** The fetched page's lines, oldest first. Pass `lines[0]?.timestamp` back as the next call's `beforeTimestamp` to keep paging further back. */
  lines: LogEventLine[];
  /**
   * `true` only once every log stream in the group has been scanned and the
   * accumulated result is still empty — a bounded scan that hasn't
   * exhausted every stream reports `false` even on an empty page, since it
   * can't safely claim nothing older exists. See `LogsService.getOlderLogs`'s
   * TSDoc for the full backward-paging behavior this mirrors.
   */
  atOldest: boolean;
}

/**
 * One page of CloudWatch events strictly newer than the caller-supplied
 * `afterTimestamp` boundary — the result of the `logs.getNewer` /
 * `logs.lambda.getNewer` IPC channels, backing the paged forward backfill
 * that runs when the operator scrolls back down through a historical
 * window.
 *
 * Mirrors `NewerLogsPage` in `@hyveon/desktop-main/src/services/LogsService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface NewerLogsPage {
  /**
   * The fetched page's lines, oldest first. The newest line's `timestamp`
   * (`lines[lines.length - 1]?.timestamp`) seeds the next call's
   * `afterTimestamp`; every line sharing that exact timestamp's `eventId`
   * seeds that call's `excludeEventIds` so the boundary event(s) already
   * delivered in this page aren't duplicated by `afterTimestamp`'s inclusive
   * bound in the next one.
   */
  lines: LogEventLine[];
  /**
   * `true` when this page came back full — there could be more events
   * between the last returned event and now, so the caller should keep
   * paging forward.
   */
  hasMore: boolean;
}

/** CloudWatch log endpoints: poll recent lines or open a live IPC stream. */
export interface HyveonLogsApi {
  /** Returns recent log lines for a game's ECS task, plus the oldest line's timestamp. */
  get: (game: string, limit?: number) => Promise<GameLogs>;
  /**
   * Opens a live log stream for `game`, returning a {@link HyveonStreamHandle}
   * of log chunks. Consume it with `for await (const chunk of stream(game))`.
   *
   * Call the returned handle's `cancel()` to stop the stream early: this
   * tells the main process to stop tailing CloudWatch. The iteration
   * completes normally once `cancel()` is called or the stream ends on its
   * own, and throws if it terminated due to an error. Internally this wraps
   * the per-stream chunk/end/cancel IPC channels in a preload-internal async
   * generator, exposed to the renderer via {@link HyveonStreamHandle}.
   */
  stream: (game: string) => HyveonStreamHandle<LogChunk>;
  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp` for a game's ECS task log group — see
   * {@link OlderLogsPage}.
   */
  getOlder: (game: string, beforeTimestamp: number, limit?: number) => Promise<OlderLogsPage>;
  /**
   * Returns up to `limit` CloudWatch events strictly newer than
   * `afterTimestamp` for a game's ECS task log group — see
   * {@link NewerLogsPage}. Pass the `eventId`s of every line in a previous
   * page's `lines` sharing that page's newest timestamp as
   * `excludeEventIds` to avoid re-delivering the boundary event(s).
   */
  getNewer: (
    game: string,
    afterTimestamp: number,
    limit?: number,
    excludeEventIds?: string[],
  ) => Promise<NewerLogsPage>;
  lambda: HyveonLambdaLogsApi;
}

/** Log lines for one of the app's 5 Lambda functions. Each line carries its own CloudWatch timestamp. */
export interface LambdaLogs {
  functionKey: LambdaFunctionKey;
  lines: LogEventLine[];
}

/** CloudWatch log endpoints for the app's 5 Lambda functions — see {@link HyveonLogsApi}. */
export interface HyveonLambdaLogsApi {
  /** Returns recent log lines for `functionKey`'s CloudWatch log group, plus the oldest line's timestamp. */
  get: (functionKey: LambdaFunctionKey, limit?: number) => Promise<LambdaLogs>;
  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp` for `functionKey`'s CloudWatch log group — mirrors
   * {@link HyveonLogsApi.getOlder}.
   */
  getOlder: (functionKey: LambdaFunctionKey, beforeTimestamp: number, limit?: number) => Promise<OlderLogsPage>;
  /**
   * Returns up to `limit` CloudWatch events strictly newer than
   * `afterTimestamp` for `functionKey`'s CloudWatch log group — mirrors
   * {@link HyveonLogsApi.getNewer}.
   */
  getNewer: (
    functionKey: LambdaFunctionKey,
    afterTimestamp: number,
    limit?: number,
    excludeEventIds?: string[],
  ) => Promise<NewerLogsPage>;
  /**
   * Opens a live log stream for `functionKey`, returning a
   * {@link HyveonStreamHandle} of log chunks — mirrors
   * {@link HyveonLogsApi.stream}'s contract, but against
   * `logs.lambda.stream.<id>.*` channels rather than `logs.stream.<id>.*`.
   */
  stream: (functionKey: LambdaFunctionKey) => HyveonStreamHandle<LogChunk>;
}

/** Seeding a game's volume from a local folder: scan, selection, upload control, and progress. */
export interface HyveonFolderUploadApi {
  /** Opens the native folder dialog and scans the choice; `null` when cancelled. */
  pickFolder: () => Promise<FolderScanResult | null>;
  /** Re-scans the folder remembered for `game` so a restored selection has a live scan id; `null` if none stored. */
  rescanSelection: (game: string) => Promise<FolderScanResult | null>;
  /** Persisted selection and last-run status for `game`, or `null`. */
  getSelection: (game: string) => Promise<FolderUploadStoredState | null>;
  /** Persists the selection for a game; the scan is referenced by id and file contents never reach the renderer. */
  setSelection: (request: FolderUploadRequest) => Promise<{ saved: true }>;
  /** Forgets the persisted selection for `game` (a discarded add-game wizard draft). */
  clearSelection: (game: string) => Promise<{ cleared: true }>;
  /** Runs the guards and starts the upload; progress then arrives through {@link HyveonFolderUploadApi.onProgress}. */
  startUpload: (request: FolderUploadRequest) => Promise<FolderUploadStartResult>;
  /** Cancels the upload running for `game`, if any. */
  cancelUpload: (game: string) => Promise<{ cancelled: boolean }>;
  /** Answers the overwrite warning of a run in the `awaiting-confirmation` phase; `proceed: false` cancels the run. */
  confirmOverwrite: (game: string, proceed: boolean) => Promise<FolderOverwriteDecisionResult>;
  /** Latest progress snapshot for `game`'s run in this session, or `null`. */
  getProgress: (game: string) => Promise<FolderUploadProgress | null>;
  /** Stops every file-manager helper no active run owns and reports what was stopped. */
  cleanupStrayHelpers: () => Promise<StrayHelperReport>;
  /** Subscribes to progress snapshots (about every 500 ms during a run); returns the unsubscribe function. */
  onProgress: (cb: (progress: FolderUploadProgress) => void) => () => void;
}

// @spec APP-IPC-SEC-002
/** In-app browsing and editing of a game's volumes through a short-lived file-browser helper session. */
export interface HyveonVolumeFilesApi {
  /**
   * Reads the file-browser session state for `game`.
   *
   * @param game - Game name.
   */
  sessionStatus: (game: string) => Promise<VolumeSessionStatus>;
  /**
   * Starts (or joins) the browse session without waiting for it to become ready.
   *
   * @param game - Game name.
   */
  sessionStart: (game: string) => Promise<VolumeSessionStatus>;
  /**
   * Re-holds the browse session when the page returns.
   *
   * @param game - Game name.
   */
  sessionAttach: (game: string) => Promise<VolumeSessionStatus>;
  /**
   * Releases the browse hold so the session can auto-stop.
   *
   * @param game - Game name.
   */
  sessionDetach: (game: string) => Promise<VolumeSessionStatus>;
  /**
   * Stops the session now.
   *
   * @param game - Game name.
   */
  sessionStop: (game: string) => Promise<VolumeResult<VolumeSessionStatus>>;
  /**
   * Stops the session, then starts a new browse session.
   *
   * @param game - Game name.
   */
  sessionRestart: (game: string) => Promise<VolumeResult<VolumeSessionStatus>>;
  /**
   * Lists a directory of a volume.
   *
   * @param game - Game name.
   * @param volume - Volume name; the legacy unnamed volume is the empty string.
   * @param path - Volume-relative directory path.
   */
  list: (game: string, volume: string, path: string) => Promise<VolumeResult<VolumeListing>>;
  /**
   * Creates a folder.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param parent - Volume-relative path of the directory to create it in.
   * @param name - New folder name.
   */
  mkdir: (game: string, volume: string, parent: string, name: string) => Promise<VolumeResult<VolumeEntryInfo>>;
  /**
   * Renames an entry within its directory.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param path - Volume-relative path of the entry.
   * @param newName - New base name.
   */
  rename: (game: string, volume: string, path: string, newName: string) => Promise<VolumeResult<VolumeEntryInfo>>;
  /**
   * Deletes a file, or a folder with its contents.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param path - Volume-relative path of the entry.
   */
  remove: (game: string, volume: string, path: string) => Promise<VolumeResult<true>>;
  /**
   * Reads a UTF-8 text file for the editor.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param path - Volume-relative file path.
   */
  readText: (game: string, volume: string, path: string) => Promise<VolumeResult<VolumeTextFile>>;
  /**
   * Overwrites a text file if it is unchanged since it was read.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param path - Volume-relative file path.
   * @param content - New file content.
   * @param expectedModifiedMs - Modification time returned by the read; a mismatch fails with `conflict`.
   */
  writeText: (
    game: string,
    volume: string,
    path: string,
    content: string,
    expectedModifiedMs: number,
  ) => Promise<VolumeResult<{ modifiedMs: number }>>;
  /**
   * Saves a file, or a folder as a zip, to a location the operator picks; progress arrives on {@link HyveonVolumeFilesApi.onTransfer}.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param path - Volume-relative path to download.
   * @param isDir - Whether `path` is a folder.
   * @returns The transfer id, or `null` when the operator cancelled the save dialog.
   */
  download: (
    game: string,
    volume: string,
    path: string,
    isDir: boolean,
  ) => Promise<VolumeResult<{ transferId: string } | null>>;
  /**
   * Cancels a running download or upload.
   *
   * @param game - Game name.
   * @param transferId - Id returned when the transfer started.
   */
  cancelTransfer: (game: string, transferId: string) => Promise<{ cancelled: boolean }>;
  /**
   * Uploads files picked in a native file dialog into a volume directory.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param dir - Volume-relative destination directory.
   * @returns The transfer id, or `null` when the operator cancelled the dialog.
   */
  uploadFiles: (game: string, volume: string, dir: string) => Promise<VolumeResult<{ transferId: string } | null>>;
  /**
   * Uploads dragged-in files; the preload resolves each `File` to its local path, so the renderer never handles path strings.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param dir - Volume-relative destination directory.
   * @param files - Files from a drop event.
   */
  uploadDropped: (
    game: string,
    volume: string,
    dir: string,
    files: File[],
  ) => Promise<VolumeResult<{ transferId: string } | null>>;
  /**
   * Uploads a folder picked in a native dialog through the folder-upload flow.
   *
   * @param game - Game name.
   * @param volume - Volume name.
   * @param dir - Volume-relative destination directory.
   * @returns The run start result, or `null` when the operator cancelled the dialog.
   */
  uploadFolder: (game: string, volume: string, dir: string) => Promise<VolumeResult<FolderUploadStartResult | null>>;
  /**
   * Subscribes to session state updates; returns the unsubscribe function.
   *
   * @param cb - Called with each new session status.
   */
  onSession: (cb: (status: VolumeSessionStatus) => void) => () => void;
  /**
   * Subscribes to download and upload progress; returns the unsubscribe function.
   *
   * @param cb - Called with each progress update.
   */
  onTransfer: (cb: (progress: VolumeTransferProgress) => void) => () => void;
}

/** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
export interface HyveonDiscordApi {
  /** Returns the Discord config with secrets redacted to booleans. */
  getConfig: () => Promise<RedactedDiscordConfig>;
  /** Updates bot token, client ID, and/or public key in Secrets Manager. */
  putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) => Promise<PutConfigResult>;
  /** Lists dynamic and deployment-config-base allowed guild IDs. */
  listGuilds: () => Promise<{ guilds: string[]; baseGuilds: string[] }>;
  /** Adds a guild ID to the dynamic allowlist in DynamoDB. */
  addGuild: (guildId: string) => Promise<GuildListResult>;
  /** Removes a guild ID from the dynamic allowlist. */
  removeGuild: (guildId: string) => Promise<GuildListResult>;
  /** Registers slash commands for a guild in the Discord developer portal. */
  registerCommands: (guildId: string) => Promise<RegisterResult>;
  /** Returns the dynamic and deployment-config-base admin user/role lists. */
  getAdmins: () => Promise<DiscordAdmins & { baseAdmins: DiscordAdmins }>;
  /** Replaces the dynamic admin user/role lists. */
  putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) => Promise<AdminsResult>;
  /** Returns the per-game permission map. */
  getPermissions: () => Promise<Record<string, DiscordGamePermission>>;
  /**
   * Sets allowed users/roles/actions for a single game.
   *
   * **Transport note:** the preload binding collapses the two parameters into a
   * single object — `ipcRenderer.invoke('discord.putPermission', { game, body })`
   * — because `nestjs-electron-ipc-transport` only delivers the first argument to
   * `@Payload`. Callers must go through `window.hyveon.discord.putPermission` and
   * must **not** invoke the `discord.putPermission` IPC channel directly with two
   * separate arguments, as the controller would only receive the first one.
   */
  putPermission: (
    game: string,
    body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
  ) => Promise<PermissionsResult>;
  /** Removes the permission entry for a game. */
  deletePermission: (game: string) => Promise<PermissionsResult>;
}

/** Environment metadata: region, domain, and environment label for UI display. */
export interface HyveonEnvApi {
  /** Returns region, domain, and environment label derived from Pulumi stack outputs. */
  get: () => Promise<EnvInfo>;
}

/**
 * Summary of a single AWS CLI profile discovered in `~/.aws/credentials` or
 * `~/.aws/config`. Never carries key material.
 */
export interface AwsProfileSummary {
  profileName: string;
  region?: string;
}

/** Plaintext input to {@link HyveonWizardApi.saveCredentials}. */
export interface SavePastedCredentialsInput {
  /** Defaults to `hyveon-pasted` when omitted. */
  profileName?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/** Payload accepted by {@link HyveonWizardApi.bootstrapStateBucket}. */
export interface BootstrapStateBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link HyveonWizardApi.bootstrapConfigurationBucket}. */
export interface BootstrapConfigurationBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link HyveonWizardApi.bootstrapDeploymentConfig}. */
export interface BootstrapDeploymentConfigInput {
  bucketName: string;
}

/** Outcome of {@link HyveonWizardApi.simulateIamPermissions}. */
export type IamCheckStatus = 'passed' | 'missing' | 'warning';

/**
 * Which credential source produced an {@link IamCheckResult}. Mirrors
 * `IamCheckOrigin` in `IamCheckService.ts` — keep in sync.
 */
export type IamCheckOrigin = 'guided' | 'pasted' | 'profile' | 'none';

/** Result of the wizard's best-effort IAM permission dry-run against the `HyveonDeployAll` action set. */
export interface IamCheckResult {
  status: IamCheckStatus;
  /**
   * Present when `status` is `'missing'` — a minimal pasteable IAM policy
   * JSON document covering exactly the denied actions.
   */
  policyJson?: string;
  /**
   * Present when `status` is `'warning'` — an actionable message explaining
   * why simulation itself could not run.
   */
  message?: string;
  /** Which credential source produced this result. See {@link IamCheckOrigin}. */
  origin: IamCheckOrigin;
  /**
   * `true` only when `status === 'missing'` AND `origin === 'guided'` — see
   * `IamCheckService.ts`'s `IamCheckResult.blocking` for the full rationale.
   * The single source of truth a caller reads to decide whether to gate
   * wizard progression; no other field or method exposes that decision.
   */
  blocking: boolean;
}

/**
 * Sub-state of the guided-IAM step's internal flow. Only meaningful when
 * `step === 'guided-iam'` — a documented convention, not a type-level
 * constraint. Mirrors `GuidedIamSubState` in `FirstRunWizardService.ts` —
 * keep in sync.
 */
export type GuidedIamSubState = 'not-started' | 'template-written' | 'awaiting-key-intake' | 'rotation-pending' | 'complete';

/** Resumable wizard progress persisted to `userData/wizard-state.json`. Mirrors `WizardProgress` in `FirstRunWizardService.ts` — keep in sync. */
export interface WizardProgress {
  step: WizardStepName;
  /** Present only while `step === 'guided-iam'` has ever recorded sub-progress. */
  guidedIam?: {
    subState: GuidedIamSubState;
    /** Whether a bootstrap key was ever submitted this session — never the key itself. */
    hasBootstrapKey: boolean;
  };
}

/** Payload accepted by {@link HyveonWizardApi.saveProgress}. Mirrors `SaveWizardProgressInput` in `wizard.controller.ts` — keep in sync. */
export interface SaveWizardProgressInput {
  step: WizardStepName;
  /** See {@link WizardProgress.guidedIam}. */
  guidedIam?: WizardProgress['guidedIam'];
}

/** Per-resource outcome of a `wizard.bootstrap.*` call. */
export type BootstrapResourceStatus = 'created' | 'exists' | 'failed';

/**
 * Result of a single bootstrap operation (e.g. {@link HyveonWizardApi.bootstrapStateBucket}).
 *
 * @remarks
 * There is no dedicated status/field for the public-access-block hardening
 * every bucket-bootstrap operation also applies: PAB is applied
 * unconditionally after the bucket itself is created/confirmed, so
 * `status: 'created' | 'exists'` already implies PAB succeeded, and a PAB
 * failure surfaces exactly like any other configuration failure on that
 * bucket — `status: 'failed'` with `message` set to the underlying error.
 */
export interface BootstrapResult {
  status: BootstrapResourceStatus;
  /** Present when `status` is `'failed'` — an actionable message for the wizard to display. */
  message?: string;
}

/**
 * Result of {@link HyveonWizardApi.guidedIamPrepareTemplate}. Mirrors
 * `RenderedTemplateResult` in `GuidedIamService.ts` — keep in sync.
 */
export interface RenderedTemplateResult {
  /** Absolute path to the rendered `iam-bootstrap.yaml` copy on disk. */
  path: string;
}

/** Payload accepted by {@link HyveonWizardApi.guidedIamOpenConsole}. Mirrors `OpenGuidedIamConsoleInput` in `wizard.controller.ts` — keep in sync. */
export interface OpenGuidedIamConsoleInput {
  region: string;
}

/**
 * Result of {@link HyveonWizardApi.guidedIamOpenConsole}. On failure, carries
 * the console `url` back so the caller can fall back to displaying it as
 * plain text for the operator to open manually. Mirrors `OpenConsoleResult`
 * in `GuidedIamService.ts` — keep in sync.
 */
export type OpenConsoleResult = { opened: true } | { opened: false; url: string };

/** Input to {@link HyveonWizardApi.guidedIamSubmitBootstrapKey}. Mirrors `BootstrapKeyIntakeInput` in `GuidedIamService.ts` — keep in sync. */
export interface BootstrapKeyIntakeInput {
  /** Access key ID the operator pasted from the CloudFormation stack outputs. */
  accessKeyId: string;
  /** Secret access key the operator pasted from the CloudFormation stack outputs. */
  secretAccessKey: string;
  /** Region to validate the key pair against. */
  region: string;
}

/** Result of {@link HyveonWizardApi.guidedIamSubmitBootstrapKey}. Mirrors `BootstrapKeyIntakeResult` in `GuidedIamService.ts` — keep in sync. */
export interface BootstrapKeyIntakeResult {
  /** AWS account ID resolved from `sts:GetCallerIdentity`. */
  accountId: string;
}

/** Input to {@link HyveonWizardApi.guidedIamRotate}. Mirrors `RotationInput` in `GuidedIamService.ts` — keep in sync. */
export interface RotationInput {
  /** Access key ID of the validated bootstrap key (from {@link HyveonWizardApi.guidedIamSubmitBootstrapKey}). */
  bootstrapAccessKeyId: string;
  /** Secret access key of the validated bootstrap key. */
  bootstrapSecretAccessKey: string;
  /** Region to build every AWS client used during rotation against. */
  region: string;
}

/**
 * Outcome of {@link HyveonWizardApi.guidedIamRotate}. Mirrors `GuidedIamRotateResult`
 * in `wizard.controller.ts` — keep in sync.
 */
export type RotationResult =
  /** The new key pair is active and the bootstrap key has been revoked. */
  | { status: 'complete' }
  /** `sts:GetCallerIdentity` failed for the newly minted key; nothing was activated. */
  | { status: 'verification-failed'; error: string }
  /** The new key pair is already active, but `iam:DeleteAccessKey` failed for the bootstrap key — revoke it manually via `consoleUrl`. */
  | { status: 'delete-failed'; consoleUrl: string }
  /** The OS keychain is unavailable, so rotation was refused before minting or storing any key. */
  | { status: 'keychain-unavailable' };

/** Input to {@link HyveonWizardApi.guidedIamRevokeBootstrapKey}. Mirrors `RevokeBootstrapKeyInput` in `GuidedIamService.ts` — keep in sync. */
export interface RevokeBootstrapKeyInput {
  /** Access key ID of the still-live bootstrap key to revoke. */
  bootstrapAccessKeyId: string;
  /** Region to build the IAM client against. */
  region: string;
}

/** Result of {@link HyveonWizardApi.guidedIamRevokeBootstrapKey}. Mirrors `RevokeBootstrapKeyResult` in `GuidedIamService.ts` — keep in sync. */
export interface RevokeBootstrapKeyResult {
  /** `true` once `iam:DeleteAccessKey` succeeds for the bootstrap key. */
  revoked: boolean;
  /** Present when `revoked` is `false` — a clear, actionable explanation of the refusal or AWS failure. */
  message?: string;
}

/**
 * Outcome of {@link HyveonWizardApi.rotateAwsKey}. Mirrors `AwsKeyRotateResult` in `wizard.controller.ts` — keep in sync.
 */
export type AwsKeyRotateResult =
  /** The new key is stored and active and the old key has been revoked. */
  | { status: 'complete' }
  /** The new key failed verification; the previous key is still stored and active. */
  | { status: 'verification-failed'; error: string }
  /** The new key is active, but the old key could not be deleted — revoke it manually via `consoleUrl`. */
  | { status: 'delete-failed'; consoleUrl: string }
  /** The OS keychain is unavailable, so rotation was refused before any key was minted. */
  | { status: 'keychain-unavailable' }
  /** The active credential source is a `~/.aws` profile or unset, which the app does not rotate. */
  | { status: 'unsupported'; message: string }
  /** An unexpected AWS or store failure. */
  | { status: 'failed'; message: string };

// @spec APP-WIZARD-BOOT-015, APP-WIZARD-CREDS-003
/** First-run wizard endpoints. */
export interface HyveonWizardApi {
  /** Lists AWS CLI profiles discovered in `~/.aws/credentials` and `~/.aws/config`. */
  listAwsProfiles: () => Promise<AwsProfileSummary[]>;
  /**
   * Saves pasted AWS credentials (the wizard's "paste keys instead" flow).
   * Only the resolved profile name comes back — never the values passed in.
   */
  saveCredentials: (input: SavePastedCredentialsInput) => Promise<{ profileName: string }>;
  /** Rotates the active pasted or guided access key in place; every outcome comes back as a modeled result. */
  rotateAwsKey: () => Promise<AwsKeyRotateResult>;
  /** Whether the first-run wizard has completed — used to gate the app router. */
  getState: () => Promise<WizardState>;
  /**
   * Persists wizard-flow answers (currently just `activeCloud`). Returns the
   * same shape as {@link getState} so the caller can update local state
   * directly from the response.
   */
  saveState: (input: SaveWizardStateInput) => Promise<WizardState>;
  /**
   * Idempotently creates/ensures the state backend S3 bucket (versioning +
   * default encryption + public-access-block, applied on both the
   * fresh-create and already-exists paths) using the credentials/region
   * chosen in the credentials step.
   */
  bootstrapStateBucket: (input: BootstrapStateBucketInput) => Promise<BootstrapResult>;
  /**
   * Idempotently creates/ensures the versioned configuration S3 bucket
   * (versioning + 90-day noncurrent-version-expiration lifecycle rule +
   * public-access-block, applied on both the fresh-create and
   * already-exists paths) using the credentials/region chosen in the
   * credentials step.
   */
  bootstrapConfigurationBucket: (input: BootstrapConfigurationBucketInput) => Promise<BootstrapResult>;
  /**
   * Idempotently seeds the initial `deployment-config.json` document in the
   * just-created/confirmed configuration bucket, fixing a Critical bootstrap
   * gap: nothing else ever created that first object, so before this call
   * existed every Settings save, every Games-page add, and every Pulumi
   * preview failed outright on a fresh install (`fetchRawConfig` throws when
   * the object doesn't exist, and every write path calls it first). Takes
   * the same `bucketName` just passed to {@link bootstrapConfigurationBucket}.
   */
  bootstrapDeploymentConfig: (input: BootstrapDeploymentConfigInput) => Promise<BootstrapResult>;
  /**
   * Idempotently creates/ensures the run-history DynamoDB table (`pk`/`sk`
   * keys, `status-index` GSI, point-in-time recovery), fixing a Critical
   * bootstrap deadlock: this table used to be created by the first Pulumi
   * apply, which itself needed the table to already exist to record its own
   * run — see `BootstrapService.ensureRunsTable`'s doc comment for the full
   * story. Takes no payload — the table's name isn't operator-editable at
   * this point in the wizard (no `DeploymentConfig` exists yet to hold an
   * override), so it always uses the project-name default.
   */
  bootstrapRunsTable: () => Promise<BootstrapResult>;
  /**
   * Runs the wizard's best-effort IAM permission dry-run against the
   * `HyveonDeployAll` action set (`sts:GetCallerIdentity` +
   * `iam:SimulatePrincipalPolicy`, batched). Never grants permissions.
   */
  simulateIamPermissions: () => Promise<IamCheckResult>;
  /**
   * Returns the last-recorded resumable step, defaulting to `pick-cloud` if
   * unset/corrupt. `guidedIam`, when present, is the guided-IAM step's own
   * validated sub-progress (see {@link WizardProgress.guidedIam}).
   */
  getProgress: () => Promise<WizardProgress>;
  /**
   * Persists the current step — and, once the guided-IAM step has made
   * progress, its `guidedIam` sub-state — so the wizard resumes here if the
   * app closes before completion.
   */
  saveProgress: (input: SaveWizardProgressInput) => Promise<void>;
  /**
   * Marks the wizard complete (`wizardCompleted: true`), gating the app
   * router past the wizard. Returns the same shape as {@link getState}.
   */
  complete: () => Promise<WizardState>;
  /**
   * Resets the wizard back to its pre-first-run state: clears the resumable
   * step-progress file and every wizard-collected answer (`wizardCompleted`,
   * `activeCloud`, `aws`, `bootstrap`, pasted credentials) from durable
   * storage. Does not touch Pulumi stack state. Returns the same shape as
   * {@link getState}. The operator-facing escape hatch for a wizard stuck in
   * a bad state.
   */
  reset: () => Promise<WizardState>;
  /**
   * Renders the `iam-bootstrap.yaml` CloudFormation template shell to disk
   * (policy documents substituted in) and returns the path to display to the
   * operator.
   */
  guidedIamPrepareTemplate: () => Promise<RenderedTemplateResult>;
  /**
   * Builds the region-scoped CloudFormation "Create stack" console URL and
   * attempts to open it in the operator's default browser. On a failed/
   * unavailable browser launch, the result echoes the same URL back so the
   * caller can display it as plain text.
   */
  guidedIamOpenConsole: (input: OpenGuidedIamConsoleInput) => Promise<OpenConsoleResult>;
  /**
   * Validates the operator-pasted bootstrap access key pair against
   * `sts:GetCallerIdentity`, returning the resolved AWS account ID. The
   * pasted secret is sent as input only — never echoed back in the result.
   */
  guidedIamSubmitBootstrapKey: (input: BootstrapKeyIntakeInput) => Promise<BootstrapKeyIntakeResult>;
  /**
   * Performs the mandatory mint-then-revoke rotation onto a freshly-minted
   * key pair. See {@link RotationResult} for the `complete`/
   * `verification-failed`/`delete-failed` outcome branches.
   */
  guidedIamRotate: (input: RotationInput) => Promise<RotationResult>;
  /**
   * Manual-retry action for a `delete-failed` {@link RotationResult}: revokes
   * the still-live bootstrap access key without re-running the mint/verify
   * sequence. Never rejects — a refusal or AWS failure comes back as
   * `{ revoked: false, message }`.
   */
  guidedIamRevokeBootstrapKey: (input: RevokeBootstrapKeyInput) => Promise<RevokeBootstrapKeyResult>;
}

/**
 * The credentials step's chosen source. `profile` names either a real
 * `~/.aws` profile (the "pick an existing profile" path) or a pasted-
 * credentials profile name (the "paste keys instead" path, e.g. `hyveon-pasted`).
 */
export interface WizardAwsChoice {
  profile?: string;
  region?: string;
}

/**
 * The profile name `GuidedIamService.rotate()` stores in
 * `WizardAwsChoice.profile` once guided IAM provisioning's mint-then-revoke
 * rotation completes. Mirrors `GUIDED_PROFILE_NAME` in `GuidedIamService.ts`
 * — keep in sync. Only reachable from the main process, so `@hyveon/web`
 * compares `WizardState.aws?.profile`/`SaveWizardStateInput.aws?.profile`
 * against this constant (rather than the main-process export it mirrors) to
 * tell guided provisioning apart from a manually picked/pasted profile — a
 * plain CLI profile or paste-flow entry never lands on this exact name.
 */
export const GUIDED_PROFILE_NAME = 'hyveon-guided';

/**
 * The bootstrap step's last-submitted resource names, as persisted to
 * `ElectronStoreService.bootstrap`. Needed so Settings' Reconfigure flow
 * can rehydrate a non-default name — resource names are
 * operator-editable.
 *
 * @remarks
 * Has no `lockTable` field: `iac.stack.initialize` (the wizard's stack-init
 * step) needs no lock-table name, unlike the deleted `iac.init` call it
 * replaced.
 */
export interface WizardBootstrapNames {
  stateBucket: string;
  configurationBucket: string;
}

/** The guided-IAM deploy principal: the account ID and, when the caller is an IAM user, its name. Non-secret. */
export interface WizardDeployPrincipal {
  accountId: string;
  userName?: string;
}

/** Minimal wizard-progress summary the renderer needs to decide whether to show the wizard route. */
export interface WizardState {
  wizardCompleted: boolean;
  /** The cloud chosen in the pick-cloud step. Locked to `'aws'` for v1; `undefined` before that step runs. */
  activeCloud?: 'aws';
  /** The credential source chosen in the credentials step, if any. */
  aws?: WizardAwsChoice;
  /** The bootstrap step's last-submitted resource names, if any. */
  bootstrap?: WizardBootstrapNames;
  /** The deploy principal resolved when the guided-IAM bootstrap key authenticated, if any. */
  deployPrincipal?: WizardDeployPrincipal;
}

/** Payload accepted by {@link HyveonWizardApi.saveState}. */
export interface SaveWizardStateInput {
  activeCloud?: 'aws';
  aws?: WizardAwsChoice;
  bootstrap?: WizardBootstrapNames;
}

/** Drift detection: compares declared (deployment config) against deployed (tfstate) state. */
export interface HyveonDriftApi {
  /** Returns the current drift report — games out of sync between declared and deployed state. */
  get: () => Promise<DriftReport>;
}

/** Local application log diagnostics: tail recent lines or retrieve the log file path. */
export interface HyveonDiagnosticsApi {
  /** Returns the last 500 lines from today's local log file. */
  tail: () => Promise<{ lines: string[] }>;
  /** Returns the absolute path of today's local log file. */
  path: () => Promise<{ path: string }>;
  /**
   * Forwards a renderer-side crash to the main process, where it is written
   * into today's local log file via `DiagnosticsService.logRendererError`.
   */
  reportError: (message: string, stack: string | undefined, source: 'boundary' | 'window-error' | 'unhandled-rejection') => Promise<void>;
  /**
   * Forwards a batch of renderer-side `console.*` calls to the main process,
   * where they are written into today's local log file via
   * `DiagnosticsService.logRendererConsoleBatch`.
   *
   * @param entries - Batched console calls, in the order they were made.
   * @param droppedCount - Entries already dropped client-side by the
   *   caller's own batch cap, if any.
   */
  reportLog: (entries: RendererLogEntry[], droppedCount?: number) => Promise<void>;
  /**
   * Prompts the operator for a save location via a native save dialog, then
   * writes a `.zip` diagnostics bundle (recent logs, a redacted config
   * summary, app/system metadata, and a best-effort AWS resource snapshot)
   * there. Resolves `{ status: 'cancelled' }` — not an error — when the
   * operator cancels the dialog.
   */
  exportBundle: () => Promise<ExportDiagnosticsBundleResult>;
  /** Reveals `path` (a written bundle) in the OS's file manager via `shell.showItemInFolder`. Never rejects. */
  showInFolder: (path: string) => Promise<void>;
}

/** Audit log: paginated history of `game_servers` mutations from DynamoDB. */
export interface HyveonAuditApi {
  /**
   * Returns a page of audit entries, newest-first. `opts.limit` caps the
   * number of entries returned; `opts.before` is a pagination cursor (an
   * {@link AuditEntry.sk} value) from a previous page's `nextBefore`, used
   * to fetch the next, older page.
   */
  list: (opts?: { limit?: number; before?: string }) => Promise<AuditPageResult>;
}

/**
 * Iac run history: look up a single plan/apply/destroy run's current
 * status and stream its live/replayed log output.
 */
export interface HyveonIacRunsApi {
  /**
   * Looks up the run identified by `runId` and returns its current
   * {@link IacRunsGetResult} — `{ found: false }` if `runId` is
   * neither the in-flight run nor a persisted {@link IacRunRecord},
   * otherwise `{ found: true, status, record? }`.
   *
   * Internally this is a plain `invoke('iac.runs.get', { runId })`
   * call — unlike {@link streamLogs}, there is no streaming involved.
   */
  get: (runId: string) => Promise<IacRunsGetResult>;
  /**
   * Opens a live/replayed log stream for the run identified by `runId`,
   * returning a {@link HyveonStreamHandle} of {@link IacRunChunk}.
   * Consume it with `for await (const chunk of iac.runs.streamLogs(runId))`.
   *
   * Mirrors {@link HyveonIacApi.init}'s streaming shape: the
   * `iac.runs.logs` invoke call resolves immediately with an opaque
   * `streamId`, and subsequent chunk/end messages arrive on the fixed
   * `iac.runs.logs.chunk` / `iac.runs.logs.end` side channels,
   * tagged with that `streamId` so overlapping subscriptions to different
   * runs can never cross-terminate one another.
   *
   * Call the returned handle's `cancel()` to stop consuming the stream
   * early: this stops yielding further chunks to the caller. There is no
   * dedicated cancel side channel — the run itself (and its log tailing on
   * the main-process side) keeps going in the background; only this
   * caller's consumption stops.
   *
   * The iteration completes normally once the run's output finishes
   * replaying/streaming, and throws (using the `iac.runs.logs.end`
   * payload's `error` field) if it terminated due to an error.
   */
  streamLogs: (runId: string) => HyveonStreamHandle<IacRunChunk>;
  /**
   * Returns a page of persisted run records, newest-first. `opts.limit` caps
   * the number of records returned; `opts.before` is a pagination cursor (a
   * {@link RunHistoryRecord.sk} value) from a previous page's `nextBefore`,
   * used to fetch the next, older page; `opts.status` filters to a single
   * run status. Each returned {@link RunHistoryRecord} carries
   * `changeSummary`/`engineVersion`/`partialApply` when the Pulumi engine
   * reported them for that run — see {@link RunHistoryRecord.changeSummary}'s
   * doc comment for the `{}`-does-not-mean-"no changes" sharp edge.
   *
   * Internally this is a plain `invoke('iac.runs.list', opts)` call —
   * no streaming involved.
   */
  list: (opts?: IacRunsListOpts) => Promise<RunHistoryPageResult>;
  /**
   * Resolves one persisted run record by its `runId`, however old the run is, or `{ found: false }` when none exists.
   * An apply shares its plan's `runId`, so the newest match for an applied plan is its apply record.
   *
   * Internally this is a plain `invoke('iac.runs.record', { runId })` call.
   */
  record: (runId: string) => Promise<IacRunsRecordResult>;
  /**
   * Resolves a temporary, fetchable URL for a run's log once it has been
   * offloaded to remote storage (i.e. the record's `logS3Key` is set,
   * distinguishing it from a small enough log embedded on `logInline`).
   *
   * Internally this is a plain `invoke` call on the `iac.runs.logUrl`
   * channel, unwrapped from the channel's `url` result field to a bare
   * string for ergonomic `fetch(url)` use at the call site.
   */
  logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string>;
  /** Durable apply-lock recovery: mint/clear a confirmation token to release a stuck RunLock. Mirrors `HyveonIacLockApi`. */
  lock: {
    /**
     * Mints a lock-clear confirmation token bound to `payload.expectedRunId`
     * — pass the `runId` of the {@link RunLock} displayed to the operator
     * (see {@link IacRunsLockMintPayload}'s doc comment). Rejects if the
     * currently held lock no longer matches.
     */
    mintToken: (payload: IacRunsLockMintPayload) => Promise<IacRunsLockMintAck>;
    clear: (payload: IacRunsLockClearPayload) => Promise<IacRunsLockClearAck>;
  };
}

/**
 * Stack-initialization IPC surface — the first-run wizard's replacement for
 * the deleted `iac.init` channel. Pulumi has no direct equivalent of the
 * pre-migration CLI's `init` step.
 */
export interface HyveonIacStackApi {
  /**
   * Initializes (or, on a retry, re-verifies) the one Pulumi stack this app
   * manages, by invoking the `iac.stack.initialize` IPC channel and
   * returning its live progress as a {@link HyveonStreamHandle} of
   * {@link StackInitPhaseEvent}. Consume it with
   * `for await (const event of iac.stack.initialize())`.
   *
   * Takes no arguments — unlike the old `iac.init(config)` call this
   * replaces, `PulumiService.initializeStack` resolves the state bucket/AWS
   * region it needs internally from stored wizard state, the same way every
   * other `PulumiService` method does (see `PulumiService.initializeStack`'s
   * own TSDoc).
   *
   * Yields a `{ phase, status }` event for every `'start'`/`'end'` pair the
   * main process reports, in order: `'engine'`, then `'plugins'`, then
   * `'operation'` — a phase never reached (because an earlier one failed)
   * never yields at all. The iteration completes normally once
   * initialization finishes successfully, and throws once the underlying run
   * fails — using the failed phase's own error message where the main
   * process could attribute the failure to a specific phase, or a generic
   * message otherwise.
   *
   * Internally this wraps the fixed `iac.stack.initialize.chunk` /
   * `iac.stack.initialize.end` side-channel IPC messages
   * `IacController.initializeStack` sends in a preload-internal async
   * generator, tagged with the `streamId` minted for this call — mirrors
   * `iac.runs.streamLogs`'s shape exactly.
   *
   * Call the returned handle's `cancel()` to stop consuming progress early —
   * mirroring every other streaming method's cancellation semantics, this
   * does not stop `PulumiService.initializeStack` itself, which keeps
   * running to completion in the background; only this caller's consumption
   * stops.
   */
  initialize: () => HyveonStreamHandle<StackInitPhaseEvent>;
}

/**
 * Iac orchestration: initializes the Pulumi stack the first-run wizard's
 * final step needs, and submits plan/apply/destroy/rollback operations
 * against the Pulumi-backed engine.
 */
export interface HyveonIacApi {
  /** Stack initialization: the wizard's replacement for the pre-migration CLI's `init` step. */
  stack: HyveonIacStackApi;
  /**
   * Submits a plan (`pulumi preview`) run by invoking the `iac.plan` IPC
   * channel and resolves its immediate {@link IacPlanAck}.
   *
   * `opts.configVersionId`, when supplied, is forwarded to
   * `PulumiService.preview`'s staleness check against the current head
   * version of the configuration object. The resolved ack reports whether the run
   * started (`{ started: true, runId }`) or was rejected before starting —
   * rejection happens when the shared workspace is already busy running
   * `preview`/`up`/`destroy`/`rollback` (`{ started: false, error, conflict }`)
   * or when an unrecognized Pulumi backend lock conflict was hit
   * (`{ started: false, error, staleLock }` — see
   * {@link IacPlanAck.staleLock}).
   *
   * This call only resolves the initial acknowledgement — it does not
   * stream the run's output itself. **Nothing in this preload currently
   * listens on the `iac.plan.chunk` / `iac.plan.end` side channels** (see
   * {@link IacPlanAck}'s doc comment) — for progress and the final
   * structured result, poll `iac.runs.get(runId)` (whose `record` carries
   * `changeSummary`/`engineVersion`/`partialApply` once the run settles) or
   * consume `iac.runs.streamLogs(runId)` for live text output.
   */
  plan: (opts?: IacPlanPayload) => Promise<IacPlanAck>;
  /**
   * Approves a completed plan run (identified by `opts.planRunId`, its
   * `runId`) so `apply` may proceed against it, by invoking the
   * `iac.approve` IPC channel with `opts`.
   *
   * Delegates to `RunRecordService.approveRun` (plan/apply/approve go
   * through Electron IPC handlers — this app has no HTTP
   * transport) — admin-only; records the approver and approved-at timestamp
   * on the plan run and resolves the {@link IacApproveAck}.
   */
  approve: (opts: { planRunId: string }) => Promise<IacApproveAck>;
  /**
   * Submits an apply (`pulumi up`) run gated on plan-hash + approval by
   * invoking the `iac.apply` IPC channel, resolving an ack shaped like
   * {@link IacPlanAck}. `IacController.apply` (the IPC handler
   * this app uses in place of an HTTP route) rejects when the plan run
   * isn't approved, the current configuration has
   * drifted since the plan, the supplied `planHash` doesn't match the plan
   * run's stored hash, another run already holds the shared workspace lock,
   * or an unrecognized Pulumi backend lock conflict was hit (see
   * {@link IacPlanAck.staleLock}).
   */
  apply: (payload: IacApplyPayload) => Promise<IacPlanAck>;
  /**
   * Mints a fresh, short-lived destroy-confirmation token by invoking the
   * `iac.destroy.mintToken` IPC channel — call this the moment the
   * operator's type-to-confirm phrase is accepted, then pass the returned
   * `token` straight through to {@link destroy}'s `confirmationToken` before
   * it expires. Minting a new token supersedes (invalidates) any prior
   * unconsumed one.
   */
  mintDestroyToken: () => Promise<IacDestroyMintAck>;
  /**
   * Submits a destroy (`pulumi destroy`) run gated on
   * `payload.confirmationToken` (minted via {@link mintDestroyToken}) by
   * invoking the `iac.destroy` IPC channel, resolving an ack shaped
   * like {@link IacPlanAck} (including the same `staleLock` case).
   * Mirrors {@link apply}: this call only resolves the initial
   * acknowledgement — it does not itself stream the run's output; consume
   * `hyveon.iac.runs.streamLogs(runId)` (tagged with the returned `runId`)
   * for progress, the same seam every other run's live output flows
   * through.
   */
  destroy: (payload: IacDestroyPayload) => Promise<IacPlanAck>;
  /**
   * Returns the current deployed stack outputs by invoking the `iac.output`
   * IPC channel with `{ force }`. `null` when the stack has never been
   * applied. There is currently zero `window.hyveon.iac.output()` call site
   * anywhere in `@hyveon/web` — only `e2e/screenshots/demo-data.ts` mocks
   * the channel, to `null`.
   */
  output: (force?: boolean) => Promise<StackOutputs | null>;
  /** Iac run history: look up a single run's status and stream its log output. */
  runs: HyveonIacRunsApi;
  /** Rollback flow: preview and restore a prior configuration version from an apply run in history. */
  rollback: HyveonIacRollbackApi;
  /** Stale backend-lock recovery: explicitly clear an unrecognized Pulumi backend lock. */
  lock: HyveonIacLockApi;
  /** Deployment-settings editor: read/write every top-level `DeploymentConfig` field except `gameServers`. */
  settings: HyveonIacSettingsApi;
}

/**
 * Stale backend-lock recovery IPC surface.
 * A `plan`/`apply`/`destroy` ack can carry `staleLock` (see
 * {@link IacPlanAck.staleLock}) when the Pulumi backend is locked by
 * something this installation cannot prove is its own dead process. This
 * namespace's sole method lets the operator, after explicitly confirming via
 * the renderer's confirmation dialog that they believe the lock is genuinely
 * stale, clear it and then manually resubmit their original operation.
 */
export interface HyveonIacLockApi {
  /**
   * Mints a fresh, short-lived lock-clear-confirmation token by invoking the
   * `iac.lock.clear.mintToken` IPC channel — call this the moment the
   * operator confirms via the stale-lock recovery dialog, then pass the
   * returned `token` straight through to {@link clear}'s `confirmationToken`
   * before it expires. Mirrors `HyveonIacApi.mintDestroyToken`.
   */
  mintToken: () => Promise<IacLockClearMintAck>;
  /**
   * Clears the current Pulumi backend lock by invoking the `iac.lock.clear`
   * IPC channel with `payload.confirmationToken` (minted via
   * {@link mintToken}), which delegates to `PulumiService.clearStaleLock()`
   * (`stack.cancel()` under the hood). Only call this after the operator has
   * explicitly confirmed — via the stale-lock recovery dialog — that they
   * believe the listed holder/age evidence describes a genuinely stale lock,
   * not a real concurrent operation. `cleared: false` means nothing was
   * cleared (e.g. another operation is already running against the shared
   * workspace, the token was missing/stale, or the clear attempt itself
   * failed) — `error` describes why. This method never retries the original
   * plan/apply/destroy itself; the caller must resubmit it separately once
   * `cleared: true`.
   */
  clear: (payload: IacLockClearPayload) => Promise<IacLockClearAck>;
}

/**
 * Rollback flow IPC surface. A rollback is two calls: {@link resolve}
 * previews the target version for the confirmation dialog without writing
 * anything, then {@link confirm} restores it as a new configuration head
 * version (and, internally, re-plans against it — see
 * {@link IacRollbackConfirmAck}'s doc comment). A confirmed rollback yields exactly one tagged plan run, returned as
 * `planRunId`; the caller streams and approves that run through the ordinary `iac.runs.*` and `iac.approve` channels
 * and submits no second plan.
 */
export interface HyveonIacRollbackApi {
  /**
   * Resolves the configuration version that was live immediately before the
   * given `apply` run, by invoking the `iac.rollback.resolve` IPC channel.
   * Read-only — performs no write. `resolved: false` means the target
   * couldn't be resolved (no matching apply run, not an apply run, no
   * recorded `configVersionId`, or no earlier version exists) — `error`
   * describes why.
   */
  resolve: (opts: { applyRunId: string }) => Promise<IacRollbackResolveAck>;
  /**
   * Confirms a previewed rollback of `opts.applyRunId`, by invoking the
   * `iac.rollback.confirm` IPC channel — restores the historic configuration
   * content as a new head version, conditional on `opts.headEtag` (from {@link resolve}): an edit made after the
   * preview fails with a "review and retry" message instead of being reverted. `confirmed: false` means no write
   * was attempted — `error` describes why.
   */
  confirm: (opts: { applyRunId: string; headEtag?: string }) => Promise<IacRollbackConfirmAck>;
}

/**
 * Deployment-settings editor IPC surface — the Settings page's form for
 * every top-level `DeploymentConfig` field except `gameServers` (region,
 * hosted zone, watchdog tuning, Discord admin
 * allowlists, etc.). `gameServers` has its own dedicated add-game-wizard/
 * edit-game-form flow (`games.create`/`games.update`/`games.delete`) and is
 * never reachable through this namespace.
 */
export interface HyveonIacSettingsApi {
  /**
   * Reads the current top-level settings plus the etag to round-trip as
   * {@link update}'s `expectedVersionId`, by invoking the `iac.settings.get`
   * IPC channel. `ok: false` covers an unconfigured configuration bucket
   * (`code: 'setup_incomplete'`), a missing configuration object
   * (`code: 'not_found'`) or an unexpected read failure
   * (`code: 'error'`) — see {@link DeploymentSettingsGetResult}.
   */
  get: () => Promise<DeploymentSettingsGetResult>;
  /**
   * Submits a settings patch by invoking the `iac.settings.update` IPC
   * channel. `payload.expectedVersionId` should always be the etag last read
   * via {@link get} — this form requires optimistic locking, so an omitted
   * `expectedVersionId` risks silently clobbering a concurrent edit.
   * `ok: false` discriminates on `code`:
   * `'validation'` (client should re-render the same fields with the
   * reported issues), `'conflict'` (surface a "changed elsewhere — reload
   * and try again" message, mirroring the game-form's own optimistic-lock
   * UX), `'setup_incomplete'`, `'not_found'` (no `deployment-config.json` in the
   * configuration bucket), or the catch-all `'error'` — see
   * {@link DeploymentSettingsWriteResult}.
   */
  update: (payload: UpdateDeploymentSettingsPayload) => Promise<DeploymentSettingsWriteResult>;
  /**
   * Reads the resolved Pulumi engine version by invoking the
   * `iac.settings.engineVersion` IPC channel — backs Settings' Cloud Setup
   * version row. `resolvedVersion: null` is a real, expected
   * "not yet provisioned" state (including a fresh install that hasn't
   * completed first-run setup), never a failure — see
   * {@link PulumiEngineVersionResult}.
   */
  engineVersion: () => Promise<PulumiEngineVersionResult>;
  /**
   * Reads the current `enableAutoUpdate` flag by invoking the
   * `iac.settings.autoUpdate.get` IPC channel — backs Settings' Updates row.
   * Also returns the running app's version (`appVersion`).
   * See {@link AutoUpdateSettingGetResult}.
   */
  autoUpdateGet: () => Promise<AutoUpdateSettingGetResult>;
  /**
   * Writes the `enableAutoUpdate` flag by invoking the
   * `iac.settings.autoUpdate.update` IPC channel. Takes effect on the next
   * app start, not the current session — see {@link AutoUpdateSettingWriteResult}.
   */
  autoUpdateUpdate: (payload: AutoUpdateSettingUpdatePayload) => Promise<AutoUpdateSettingWriteResult>;
  /**
   * Runs an on-demand update check by invoking the
   * `iac.settings.autoUpdate.check` IPC channel, independent of the
   * `enableAutoUpdate` flag — backs Settings' "Check for Updates" button.
   * Never downloads or installs — see {@link ManualUpdateCheckResult}.
   */
  autoUpdateCheck: () => Promise<ManualUpdateCheckResult>;
  /**
   * Downloads the update found by the last check — backs Settings' "Download & Install" button. An explicit
   * operator action; the automatic check never downloads. Invokes `iac.settings.autoUpdate.download` and returns
   * live progress as a {@link HyveonStreamHandle} of {@link UpdateDownloadProgress}. Consume it with
   * `for await (const p of iac.settings.autoUpdateDownload())`: the iteration completes normally once the update
   * is fully downloaded and throws (with the failure message) if the download fails.
   *
   * Internally wraps the fixed `iac.settings.autoUpdate.download.chunk` / `.end` side-channel IPC messages, same
   * shape as {@link HyveonIacStackApi.initialize}. `cancel()` stops consumption only; it does not abort the download.
   */
  autoUpdateDownload: () => HyveonStreamHandle<UpdateDownloadProgress>;
  /**
   * Quits the app and installs the downloaded update by invoking `iac.settings.autoUpdate.install` — backs
   * Settings' "Restart & Install" button. Resolves `{ ok: true }` just before the app quits, or `{ ok: false }`
   * with a message if it could not. See {@link UpdateInstallResult}.
   */
  autoUpdateInstall: () => Promise<UpdateInstallResult>;
}

/**
 * Window-chrome API backing the custom title bar: the current OS platform
 * (read once at preload load time, no IPC round-trip) and typed access to
 * the main window's minimize/maximize/close IPC channels.
 */
export interface HyveonWindowApi {
  /** Current OS platform, read from `process.platform` inside the preload script. Never changes during a session. */
  platform: NodeJS.Platform;
  /** Invokes the `window.minimize` IPC channel. */
  minimize: () => Promise<void>;
  /** Invokes the `window.toggleMaximize` IPC channel. */
  toggleMaximize: () => Promise<void>;
  /** Invokes the `window.close` IPC channel. */
  close: () => Promise<void>;
  /** Invokes the `window.isMaximized` IPC channel and resolves with the current maximized state. */
  isMaximized: () => Promise<boolean>;
  /**
   * Subscribes to `window.maximizedChange` push events from the main process.
   *
   * @param cb - Called with the window's new maximized state whenever it changes.
   * @returns An unsubscribe function that removes the underlying IPC listener.
   */
  onMaximizedChange: (cb: (isMaximized: boolean) => void) => () => void;
}

// Test-only injection surface

/**
 * Mock namespace bag: a partial copy of every `HyveonApi` namespace so test
 * harnesses can supply only the methods they care about.
 *
 * Derived as a mapped type over every `HyveonApi` namespace key (everything
 * except the `__test` injection surface itself) so a namespace added to
 * `HyveonApi` flows in automatically — no hand-maintained property list to drift.
 */
export type HyveonMockNamespaces = {
  [K in Exclude<keyof HyveonApi, '__test'>]?: Partial<HyveonApi[K]>;
};

/**
 * Test-only API surface injected under `window.hyveon.__test`.
 *
 * Present only when the Electron preload runs with `HYVEON_TEST_MODE=1` (set by the Playwright
 * harness): `preload.ts` appends `__test` to the real `window.hyveon` bridge so page scripts can inject IPC
 * mocks without touching the real IPC layer. Vitest/jsdom tests stub the namespace methods with `vi.fn()` instead.
 *
 * Production code must **never** reference this property — guard every access
 * with an `if (window.hyveon?.__test)` check or, better, avoid it entirely outside
 * tests.
 */
export interface HyveonTestApi {
  /**
   * Registers a per-channel mock handler.
   *
   * Call `mock(channel, handler)` before rendering the component under test.
   * When the preload bridge later invokes `ipcRenderer.invoke(channel, ...args)`,
   * the registered handler is called instead and its return value is resolved.
   * Pass a plain value (non-function) to have it returned verbatim.
   *
   * @param channel - The IPC channel name to intercept (e.g. `'games.list'`).
   * @param handler - A function `(...args) => result` or a static return value.
   */
  mock: (channel: string, handler: unknown) => void;
  /**
   * Clears all mock implementations stored in `mock` and resets any recorded
   * call counts on injected `vi.fn()` spies.
   *
   * Intended for use in `afterEach` hooks to prevent state leaking between
   * test cases.
   */
  clearMocks: () => void;
  /**
   * Alias for {@link clearMocks} — provided for symmetry with Vitest's
   * `vi.resetAllMocks()` naming convention.
   */
  reset: () => void;
}

// Top-level interface

// @spec APP-IPC-CONTRACT-001
/**
 * Typed shape of `window.hyveon` as exposed by the Electron preload script.
 *
 * Declare this on `Window` in a renderer-side `.d.ts` file. Mark it optional
 * (`hyveon?`) — the bridge is absent in plain browser/web contexts, so runtime
 * guards like `if (!window.hyveon)` need it to be possibly-undefined:
 * ```ts
 * import type { HyveonApi } from '@hyveon/desktop-preload/hyveon-api';
 * declare global {
 *   interface Window { hyveon?: HyveonApi; }
 * }
 * ```
 */
export interface HyveonApi {
  /** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
  games: HyveonGamesApi;
  /** Cost endpoints: forward-looking Fargate estimates and historical CE data. */
  costs: HyveonCostsApi;
  /** CloudWatch log endpoints (request/response only; the live tail is a separate IPC stream). */
  logs: HyveonLogsApi;
  /** Folder-to-volume upload: scan, selection, start/cancel, progress, and stray-helper cleanup. */
  folderUpload: HyveonFolderUploadApi;
  /** Volume file browser: session control, file operations, transfers, and session/transfer push events. */
  volumeFiles: HyveonVolumeFilesApi;
  /** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
  discord: HyveonDiscordApi;
  /** Environment metadata: region, domain, and environment label for UI display. */
  env: HyveonEnvApi;
  /** First-run wizard endpoints: prerequisite detection, credentials, cloud bootstrap. */
  wizard: HyveonWizardApi;
  /** Drift detection: compares declared (deployment config) against deployed (tfstate) state. */
  drift: HyveonDriftApi;
  /** Local application log diagnostics: tail recent lines or retrieve the log file path. */
  diagnostics: HyveonDiagnosticsApi;
  /** Audit log: paginated history of `game_servers` mutations from DynamoDB. */
  audit: HyveonAuditApi;
  /** AWS account-prerequisite health checklist surfaced on the Settings page. */
  cloudHealth: HyveonCloudHealthApi;
  /**
   * Iac orchestration: stack initialization plus plan/apply/destroy/rollback
   * against the Pulumi-backed engine. The namespace is `iac`, and its
   * payload/ack type names are `Iac*`-prefixed to match, mirroring the
   * main-process types of the same name.
   */
  iac: HyveonIacApi;
  /** Window chrome API: minimize, maximize, close, and maximize-state queries. */
  window: HyveonWindowApi;
  /**
   * Test-only injection surface; `undefined` in production.
   *
   * Present in two scenarios:
   * - **Vitest / jsdom** — the test harness stubs the whole `window.hyveon`
   *   object with a mock that includes this property.
   * - **Electron preload** — appended to the real bridge when the process is
   *   started with `HYVEON_TEST_MODE=1` by the Playwright integration-test
   *   harness.
   *
   * Never reference this in production code paths.
   */
  __test?: HyveonTestApi;
}
