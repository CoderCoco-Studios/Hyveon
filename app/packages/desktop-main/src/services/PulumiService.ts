import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DestroyResult, EngineEvent, OutputMap, PreviewResult, UpResult } from '@pulumi/pulumi/automation/index.js';
import { createInfraProgram } from '@hyveon/infra';
import { CONFIGURATION_OBJECT_KEY, isApprovalExpired } from '@hyveon/shared';
import type {
  ChangeSummary,
  DeploymentConfig,
  OpType,
  RemoteFileStore,
  RunKind,
  RunLock,
  RunRecord,
  StackOutputs,
} from '@hyveon/shared';
import { logger } from '../logger.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { PulumiEngineService } from './PulumiEngineService.js';
import { PULUMI_PROJECT_NAME, PULUMI_STACK_NAME, PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import {
  PulumiOperationAbortedError,
  PulumiOperationEscalatedError,
  PulumiOperationNotStartedError,
  runWithEscalatingCancellation,
} from './PulumiCancellation.js';
import { runTreatingLeakedPromiseAsSuccess } from './PulumiLeakedPromise.js';
import { classifyStackLockConflict, isStackLockConflict, PulumiUnrecognizedLockError } from './PulumiLockRecovery.js';
import type { PersistRunRecordParams } from './RunRecordService.js';

/** Absolute path to the `dist/services/` directory at runtime — mirrors `ConfigService.ts`'s identically-named constant. */
const _dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the app root (`app/` in the repo). Derived by walking 4
 * levels up from `dist/services/` — mirrors `ConfigService.ts`'s
 * identically-named constant (duplicated rather than imported, since
 * `PulumiService` cannot import `ConfigService` — see {@link RUN_RECORD_PERSISTER}).
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/**
 * DI token for {@link RunRecordPersister}, the narrow slice of
 * `RunRecordService`'s public surface {@link PulumiService.preview} depends
 * on. Bound to the real `RunRecordService` singleton via `useExisting` in
 * `run-record.module.ts` and resolved lazily via
 * `ModuleRef.get(RUN_RECORD_PERSISTER, { strict: false })`.
 *
 * This is a runtime lookup, not a constructor dependency, because
 * `RunRecordService.ts` imports `ConfigService.ts`, which imports this file
 * for `getStackOutputs()`. A value-level import of `RunRecordService` here
 * would create a circular `import` between the three files, so `PulumiService`
 * depends only on this `Symbol` and the {@link RunRecordPersister} interface
 * (plus the type-only `PersistRunRecordParams`), never on the class itself.
 */
export const RUN_RECORD_PERSISTER = Symbol('RUN_RECORD_PERSISTER');

/**
 * The slice of `RunRecordService`'s public surface {@link PulumiService.preview}
 * and {@link PulumiService.apply} depend on: persisting a finished run to the
 * run-history store alongside its log transcript, and `getByRunId`, which
 * {@link PulumiService.apply}'s gate uses to look up the plan record being
 * applied. Kept as a separate interface so this file never needs
 * `RunRecordService` as a value — see {@link RUN_RECORD_PERSISTER}.
 */
export interface RunRecordPersister {
  persist(params: PersistRunRecordParams, logFilePath: string | null): Promise<void>;
  getByRunId(runId: string): Promise<RunRecord | undefined>;
}

/**
 * DI token for the narrow slice of `RunService`'s public surface
 * {@link PulumiService.apply} depends on — acquiring the durable apply lock
 * (an atomic compare-and-set) via `createRun`. Bound to the real `RunService`
 * singleton via `useExisting` in `run-record.module.ts` and resolved lazily,
 * for the same circular-import reason as {@link RUN_RECORD_PERSISTER}.
 */
export const RUN_LOCK_SERVICE = Symbol('RUN_LOCK_SERVICE');

/**
 * The slice of `RunService`'s public surface {@link PulumiService.apply}
 * depends on — see {@link RUN_LOCK_SERVICE}. `releaseRun` backstops two
 * paths: the post-`createRun` re-check that closes the apply-vs-preview/destroy
 * local-workspace race (see {@link apply}'s TSDoc), and the outer `finally`'s
 * unconditional release covering a `writeRunRecord` failure that would
 * otherwise skip `persistRunRecord`'s own lock-releasing `finally`.
 */
export interface RunLockService {
  createRun(kind: RunKind, initiator: string, runId?: string): Promise<RunLock>;
  releaseRun(runId: string): Promise<void>;
}

/**
 * DI token for the narrow slice of `ConfigService`'s public surface
 * {@link PulumiService.apply} depends on — invalidating the memoised
 * `getStackOutputs()` cache on a successful apply, without which the
 * dashboard would keep showing "not deployed" after the first real apply.
 * Bound via `useExisting` in `config.module.ts` and resolved lazily, for the
 * same circular-import reason as {@link RUN_RECORD_PERSISTER}
 * (`ConfigService.getStackOutputs()` already depends on `PulumiService`).
 */
export const CONFIG_CACHE_INVALIDATOR = Symbol('CONFIG_CACHE_INVALIDATOR');

/**
 * The slice of `ConfigService`'s public surface {@link PulumiService.apply}
 * depends on — see {@link CONFIG_CACHE_INVALIDATOR}.
 */
export interface ConfigCacheInvalidator {
  invalidateCache(): void;
}

/**
 * DI token for the narrow slice of `TfvarsService`'s public surface
 * {@link PulumiService.confirmRollback} depends on — the byte-for-byte
 * config restore write. Bound via `useExisting` in `tfvars.module.ts` and
 * resolved lazily, for the same circular-import reason as
 * {@link RUN_RECORD_PERSISTER} (`TfvarsService.ts` imports `ConfigService.ts`,
 * which imports this file).
 *
 * A dedicated `Symbol` token is used rather than the `TfvarsService` class
 * itself as the `ModuleRef` key, because referencing the class would still
 * require a value import of `TfvarsService` here — exactly the import this
 * token exists to avoid. This file only needs the {@link TfvarsRestorer}
 * interface and this plain `Symbol`.
 */
export const TFVARS_SERVICE = Symbol('TFVARS_SERVICE');

/**
 * The slice of `TfvarsService`'s public surface {@link PulumiService.confirmRollback}
 * depends on — see {@link TFVARS_SERVICE}.
 */
export interface TfvarsRestorer {
  restoreRawTfvars(rawConfig: string): Promise<{ etag: string; versionId?: string }>;
}

/**
 * Pulumi-backed replacement for `TerraformService.ts`: the typed error
 * classes ported from it (below), {@link getStackOutputs} (replacing
 * `ConfigService.getTfOutputs()`), {@link preview} (replacing
 * `TerraformService.plan()`, including the plan-hash computation), and
 * `up`/`destroy`/rollback methods added on this same class.
 *
 * ## Error-class organization
 *
 * Of `TerraformService.ts`'s 13 error classes: 2 were dropped
 * (`TerraformNotFoundError`, `TerraformInitError` — no Pulumi analogue,
 * since `PulumiEngineService` auto-installs and there is no separate init
 * step); 5 were ported byte-for-byte under their original name
 * (`StalePlanError`, `DestroyNotConfirmedError`, `RollbackTargetNotFoundError`,
 * `RollbackNotApplyRunError`, `RollbackVersionMissingError` — all about S3
 * config-object versioning or the destroy confirmation-token gate, unaffected
 * by the engine swap); `TerraformPlanHashError` was renamed to
 * {@link PulumiPlanHashError}; `RollbackNoTfvarsVersionError` was renamed to
 * {@link RollbackNoConfigVersionError} for terminology (`RunRecord.tfvarsVersionId`
 * itself keeps its name, so the field and class names now intentionally
 * diverge); 4 were reshaped and renamed to the `Pulumi*Error` convention
 * because their shape changed with the engine — `TerraformPlanError`/
 * `TerraformApplyError`/`TerraformDestroyError` lost their `exitCode` field
 * (Automation API throws a `CommandError`, not a process exit code) becoming
 * {@link PulumiPreviewError}/{@link PulumiUpError}/{@link PulumiDestroyError};
 * `TerraformRunPersistError`'s `outcome` union was reshaped for Pulumi
 * outcomes, becoming {@link PulumiRunPersistError}; and 1 is new
 * ({@link PulumiPartialApplyError}, for the clean-failure-vs-partial-apply
 * distinction). `PulumiUnrecognizedLockError` (`PulumiLockRecovery.ts`)
 * already existed and is reused, not recreated, here.
 *
 * Colocated in this one file rather than a separate `pulumiServiceErrors.ts`
 * because every class is thrown by, or describes the outcome of, a method
 * this class owns.
 *
 * **Duplicate class names, temporarily:** the 5 classes ported under their
 * original name exist as two distinct classes with the same name — one in
 * `TerraformService.ts`, one here — until `TerraformService.ts` is deleted.
 * Nothing imports both today, but an `instanceof` check against the wrong
 * module's import would silently never match. Always import these from
 * `PulumiService.ts`, never from `TerraformService.ts`.
 */

/**
 * Matches a bare, single-segment run identifier — mirrors `TerraformService.ts`'s
 * `RUN_ID_PATTERN` exactly (letters, digits, underscores, hyphens only, no
 * path separators or traversal segments). See that constant's doc comment
 * for the full rationale; unchanged by the engine swap since `runId` is
 * still joined directly into filesystem paths under {@link PulumiService.getRunsDir}.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * `OpType`s that represent a genuine applied resource mutation — used by
 * {@link PulumiService.apply} to detect a partial apply from `onEvent`'s
 * `resOutputsEvent` stream (see that method's TSDoc, "Partial-apply
 * detection"). Excludes `'same'` (the resource already matched its desired
 * state — no mutation happened), `'read'`/`'read-replacement'`/`'refresh'`
 * (state reads, not mutations), and the `'discard'`/`'discard-replaced'`/
 * `'remove-pending-replace'` plan-only bookkeeping ops (per
 * `@pulumi/pulumi/automation/stack.d.ts`'s `OpType` doc comments, these
 * describe plan-time bookkeeping, not something a real `stack.up()` ever
 * reports as completed). Includes `'import'`/`'import-replacement'` — an
 * import genuinely brings a resource under management, a real mutation of
 * the stack's desired state even though no cloud API call recreates the
 * resource itself.
 */
const MUTATING_OP_TYPES: ReadonlySet<OpType> = new Set([
  'create',
  'update',
  'delete',
  'replace',
  'create-replacement',
  'delete-replaced',
  'import',
  'import-replacement',
]);

/**
 * How long a token minted by {@link PulumiService.mintDestroyConfirmationToken}
 * stays valid before {@link PulumiService.destroy} rejects it as stale, even
 * if it was never consumed — mirrors `TerraformService.ts`'s
 * `DESTROY_CONFIRMATION_TTL_MS` (5 minutes).
 */
const DESTROY_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * The most recently minted destroy-confirmation token, its expiry, and the
 * destroy TARGET it was bound to — set by
 * {@link PulumiService.mintDestroyConfirmationToken} and consumed (single-use)
 * by {@link PulumiService.assertFreshDestroyConfirmation} the moment a
 * {@link PulumiService.destroy} call validates it.
 *
 * ## Target binding
 *
 * The `iac-destroy-flow` spec requires a minted token to record the
 * workspace/stack it was issued for, and `destroy` to reject a token whose
 * recorded target doesn't match. This app has exactly one stack name
 * ({@link PULUMI_STACK_NAME}, a constant), so binding on stack name alone
 * would never actually fail. What CAN change between minting a token (the
 * renderer opening its destroy-confirmation modal) and consuming it (the
 * operator confirming) is the self-managed backend's state bucket/region —
 * both are writable via the First-Run Wizard's Reconfigure flow while the
 * modal is open. Binding on `stateBucket`/`stateBucketRegion` (plus the
 * always-constant `stackName`/`projectName`, checked for future-proofing)
 * prevents a token minted against one backend from silently authorizing a
 * destroy against a different one an operator switched to mid-confirmation.
 *
 * `null` when no token has been minted, or once the most recently minted one
 * has been consumed or superseded by a newer
 * {@link PulumiService.mintDestroyConfirmationToken} call.
 */
interface PulumiPendingDestroyConfirmation {
  /** The single-use token the renderer must supply back to {@link PulumiService.destroy}. */
  token: string;
  /** `Date.now() + DESTROY_CONFIRMATION_TTL_MS`, captured at mint time. */
  expiresAt: number;
  /** The self-managed backend's configured state bucket at mint time, or `undefined` if unconfigured — see this interface's doc comment, "Target binding". */
  stateBucket: string | undefined;
  /** The state bucket's configured AWS region at mint time. */
  stateBucketRegion: string | undefined;
  /** {@link PULUMI_STACK_NAME} at mint time. */
  stackName: string;
  /** {@link PULUMI_PROJECT_NAME} at mint time. */
  projectName: string;
}

/**
 * A single line of streamed stdout/stderr output from a Pulumi Automation
 * API operation, tagged with the stream it came from. Yielded by
 * `preview`/`up`/`destroy` as the operation produces output, consumed by
 * {@link PulumiService.streamRunOutput}'s subscribers.
 */
export interface PulumiRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * In-memory fan-out buffer for a single in-flight `preview`/`up`/`destroy`
 * run's streamed output, keyed by `runId` in `PulumiService`'s private
 * `activeRuns` map. Populated by {@link PulumiService.recordRunChunk},
 * consumed by {@link PulumiService.streamRunOutput}.
 */
interface PulumiActiveRunBuffer {
  /** Every chunk streamed so far, in production order — replayed in full to a new subscriber before it starts receiving live chunks. */
  chunks: PulumiRunChunk[];
  /** Callbacks invoked synchronously, in registration order, each time a new chunk is recorded. */
  listeners: Set<(chunk: PulumiRunChunk) => void>;
  /** Flips to `true` once the owning run has settled — never flips back. */
  settled: boolean;
  /** Callbacks invoked exactly once, when the run is marked settled. */
  settledListeners: Set<() => void>;
}

/**
 * Outcome of a successful {@link PulumiService.preview} run, resolved via
 * the async generator's return value once `stack.preview()` settles and the
 * run wasn't aborted. Unlike `TerraformService.ts`'s `TerraformPlanResult`:
 * no `varFilePath` (the Pulumi inline program takes the deployment config as
 * an in-memory object, so there's no pulled-var-file artifact on disk); the
 * scraped `add`/`change`/`destroy` counts become a single structured
 * {@link ChangeSummary}; and `engineVersion` is new.
 */
export interface PulumiPreviewResult {
  /** The `runId` minted for this run — the parent directory (`<runsDir>/<runId>/`) of {@link artifactPath}. */
  runId: string;
  /** Absolute path to the persisted Pulumi update-plan JSON artifact (`--save-plan`) — what a future `up()` passes as `UpOptions.plan`. */
  artifactPath: string;
  /**
   * The structured resource-change summary this run's `stack.preview()`
   * reported — see {@link ChangeSummary}'s doc comment for the "`{}` means
   * summary missed, not no changes" edge case.
   */
  changeSummary: ChangeSummary;
  /**
   * SHA-256 hex digest covering both the persisted plan artifact's bytes and
   * the deployment-config object's S3 version id this run ran against — see
   * {@link PulumiService.computePlanHash} for the exact algorithm.
   */
  planHash: string;
  /**
   * The engine version stamped into the saved plan artifact's own
   * `manifest.version` field, with any leading `v` stripped (e.g.
   * `"v3.255.0"` is stored as `"3.255.0"`) so it's directly comparable
   * against `PulumiEngineService.getResolvedVersion()`'s own un-prefixed
   * shape. Stripped in {@link PulumiService.readEngineVersionFromPlanArtifact}.
   * Stored alongside, not folded into, {@link planHash}.
   */
  engineVersion: string;
}

/**
 * Describes what {@link PulumiService.preview} was about to return/throw the
 * moment its operation settled — captured before the run record is
 * persisted so a persistence failure (see {@link PulumiRunPersistError})
 * doesn't discard the real outcome.
 */
export type PulumiPreviewOutcome =
  | { kind: 'success'; result: PulumiPreviewResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: PulumiPreviewError | PulumiPlanHashError };

/**
 * Persisted to `<runsDir>/<runId>/run.json` once a {@link PulumiService.preview}
 * (and, later, `up`/`destroy`) run has settled — the local run-history
 * counterpart to the DynamoDB write {@link PulumiService.persistRunRecord}
 * makes through {@link RunRecordPersister}. `kind` reuses the same `RunKind`
 * union (`'plan'`/`'apply'`/`'destroy'`) as `TerraformService.ts`, so a
 * Pulumi `preview` run is still recorded as a `'plan'` kind.
 */
export interface PulumiRunRecord {
  /** The `runId` this record describes — matches the directory it's written into. */
  runId: string;
  /** Which operation produced this record (`preview` → `'plan'`, `up` → `'apply'`, `destroy` → `'destroy'`). */
  kind: RunKind;
  /** ISO-8601 timestamp captured immediately before `stack.preview()`/`.up()`/`.destroy()` was called. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the operation settled. */
  completedAt: string;
  /** `0` on success, `null` if aborted, `1` on a genuine failure — there is no real process exit code for an Automation API call. */
  exitCode: number | null;
  /** The deployment-config object's S3 version id this run ran against. */
  tfvarsVersionId?: string;
  /** SHA-256 hex digest of the persisted plan artifact plus the config version id — see {@link PulumiService.computePlanHash}. */
  planHash?: string;
  /** The `runId` of the `apply` run this plan rolled back, if this run was started via the rollback flow. */
  rolledBackFrom?: string;
  /** The structured resource-change summary this run's `stack.preview()` reported — see {@link ChangeSummary}'s doc comment. */
  changeSummary?: ChangeSummary;
  /** The engine version stamped into the saved plan artifact — see {@link PulumiPreviewResult.engineVersion}. */
  engineVersion?: string;
  /**
   * `true` only on a `kind: 'apply'` record whose `stack.up()` did not
   * settle as `'success'` (failed OR aborted) after at least one resource
   * step had already been applied. An additive field rather than a fourth
   * `RunStatus` value, because `RunStatus` is the hash key of the
   * `status-index` DynamoDB GSI and widening it is an infra-affecting change.
   *
   * Set independently of which non-`'success'` status the run settled with —
   * `true` just as often on `status: 'aborted'` (operator cancel mid-`up()`)
   * as on `status: 'failed'`. Consumers MUST check `partialApply` directly
   * rather than gating on `status === 'failed'` first, or they'll miss every
   * cancelled-mid-apply partial. Absent (never `false`) on non-partial
   * records, mirroring `changeSummary`/`engineVersion`'s "absence means N/A"
   * convention above.
   */
  partialApply?: boolean;
}

/**
 * Outcome of a successful {@link PulumiService.apply} run, resolved via the
 * async generator's return value once `stack.up()` settles and the run
 * wasn't aborted. Narrower than {@link PulumiPreviewResult}: no
 * `artifactPath`/`planHash`/`engineVersion`, since those describe the plan
 * this apply was constrained by (already on the plan's own
 * {@link PulumiRunRecord}, looked up via `planRunId`), not a fresh artifact
 * this run produces.
 */
export interface PulumiUpResult {
  /** The `runId` of this apply run — always equal to the `planRunId` the gate validated (see {@link PulumiService.apply}'s "run id" doc section). */
  runId: string;
  /**
   * The structured resource-change summary this run's `stack.up()` reported,
   * captured via `onEvent`'s `summaryEvent` — see {@link ChangeSummary}'s
   * doc comment for the "`{}` means summary missed, not no changes" edge case.
   */
  changeSummary: ChangeSummary;
}

/**
 * Describes what {@link PulumiService.apply} was about to return/throw the
 * moment its operation settled — captured before the run record is
 * persisted so a persistence failure (see {@link PulumiRunPersistError})
 * doesn't discard the real outcome. Mirrors {@link PulumiPreviewOutcome},
 * plus `partialApply` on the `'failed'` variant.
 *
 * **This type's own `partialApply` is not what gets persisted** — it's
 * internal bookkeeping for the `'failed'` variant only. The persisted
 * `PulumiRunRecord.partialApply` value {@link apply} writes is computed
 * independently from `completedSteps.length`, gated on
 * `outcome.kind !== 'success'` so it also covers the `'aborted'` variant,
 * which carries no `partialApply` field here.
 */
export type PulumiApplyOutcome =
  | { kind: 'success'; result: PulumiUpResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: Error; partialApply: boolean };

/**
 * Outcome of a successful {@link PulumiService.destroy} run, resolved via the
 * async generator's return value once `stack.destroy()` settles and the run
 * wasn't aborted. As narrow as {@link PulumiUpResult}: no `outputs`, since
 * there is nothing meaningful to report post-destroy.
 */
export interface PulumiDestroyResult {
  /** The `runId` of this destroy run — always equal to the durable-lock `runId` the gate reserved (see {@link PulumiService.destroy}'s "Gate structure" doc section). */
  runId: string;
  /**
   * The structured resource-change summary this run's `stack.destroy()`
   * reported (every entry a deletion), captured via `onEvent`'s `summaryEvent`.
   */
  changeSummary: ChangeSummary;
}

/**
 * Describes what {@link PulumiService.destroy} was about to return/throw the
 * moment its operation settled — captured before the run record is persisted
 * so a persistence failure (see {@link PulumiRunPersistError}) doesn't
 * discard the real outcome. Mirrors {@link PulumiPreviewOutcome}'s plain
 * three-way shape; unlike {@link PulumiApplyOutcome}, there is no
 * partial-destroy concept.
 */
export type PulumiDestroyOutcome =
  | { kind: 'success'; result: PulumiDestroyResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: PulumiDestroyError | PulumiUnrecognizedLockError };

/**
 * Pulumi-backed replacement for `TerraformService.ts` — see this file's
 * top-level doc comment for the error classes, {@link getStackOutputs}, and
 * {@link preview}.
 */
@Injectable()
export class PulumiService {
  /**
   * Name of whichever operation (`preview`, `up`, `destroy`, or `rollback`)
   * is actively running against the shared Pulumi workspace directory, or
   * `null` when none is. Every operation reuses the same `workDir`/
   * `Pulumi.<stack>.yaml`, so two concurrent operations against this one
   * `PulumiService` instance would race on that shared local state —
   * independent of whether the DIY backend's own lock is ever taken.
   *
   * `'rollback'` ({@link confirmRollback}) is a distinct state from
   * `'preview'`, even though the operation it runs under the hood (via
   * {@link previewCore}) is an ordinary plan — a caller refused mid-rollback
   * gets a busy message naming `rollback` specifically. Like `'up'` for
   * `apply()`, this is a short internal diagnostic verb, not required to
   * equal the public method's name.
   */
  private operationInFlight: 'preview' | 'up' | 'destroy' | 'rollback' | null = null;

  /**
   * Fan-out buffers for every currently in-flight `preview`/`up`/`destroy`
   * run, keyed by `runId` — see {@link PulumiActiveRunBuffer}.
   */
  private readonly activeRuns = new Map<string, PulumiActiveRunBuffer>();

  /**
   * The most recently minted destroy-confirmation token, its expiry, and its
   * bound target — see {@link PulumiPendingDestroyConfirmation}.
   */
  private pendingDestroyConfirmation: PulumiPendingDestroyConfirmation | null = null;

  /**
   * `engine` is `apply`'s route to `PulumiEngineService.getResolvedVersion()`
   * for the gate's engine-version check — an ordinary constructor dependency
   * since `PulumiEngineModule` has no dependencies of its own and importing
   * it creates no cycle. `moduleRef` is the lazy-resolution route for
   * `RUN_RECORD_PERSISTER`, `REMOTE_FILE_STORE`, `RUN_LOCK_SERVICE`, and
   * `CONFIG_CACHE_INVALIDATOR` — see {@link getRunRecordPersister}/
   * {@link getRemoteFileStore}/{@link getRunLockService}/
   * {@link getConfigCacheInvalidator} for why those four are resolved via
   * `ModuleRef.get(token, { strict: false })` at call time rather than as
   * ordinary constructor dependencies (a static import cycle through
   * `ConfigService`/`RunRecordService`/`TfvarsService`, all of which import
   * this file). `ModuleRef` itself has no relation to that cycle.
   */
  constructor(
    private readonly workspace: PulumiWorkspaceService,
    private readonly store: ElectronStoreService,
    private readonly moduleRef: ModuleRef,
    private readonly engine: PulumiEngineService,
  ) {}

  /**
   * Read-only accessor for {@link operationInFlight}, mirroring
   * `TerraformService.getWorkspaceInFlight()`'s contract so
   * `TerraformController`'s pre-flight busy checks keep working unchanged.
   */
  getOperationInFlight(): 'preview' | 'up' | 'destroy' | 'rollback' | null {
    return this.operationInFlight;
  }

  /**
   * Lazily resolves the real `RunRecordService` singleton (bound to
   * {@link RUN_RECORD_PERSISTER} by `run-record.module.ts`) from anywhere in
   * the application's provider container. Safe to call from {@link preview}
   * (and `up`/`destroy`): those methods only run once the application has
   * fully bootstrapped. `strict: false` searches the whole container, since
   * `PulumiServiceModule` deliberately does not import whatever module
   * provides this token.
   *
   * Throws a clear, wrapped `Error` naming the missing token and module
   * rather than letting Nest's `UnknownElementException` propagate
   * unexplained — the same failure mode {@link getRemoteFileStore} uses.
   * Callers decide independently what to do with that error: `preview`'s
   * `persistRunRecord` treats any failure of the run-history side-write as
   * best-effort and logs+swallows it.
   */
  private getRunRecordPersister(): RunRecordPersister {
    try {
      return this.moduleRef.get<RunRecordPersister>(RUN_RECORD_PERSISTER, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: RUN_RECORD_PERSISTER is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see run-record.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `RemoteFileStore` implementation bound to
   * {@link REMOTE_FILE_STORE} by `cloud-provider.module.ts` — mirrors
   * {@link getRunRecordPersister}. Unlike that method, nothing in
   * {@link preview} catches a failure from this one: reading the deployment
   * configuration is load-bearing for `preview()`, so a missing binding here
   * is correctly a hard failure of the whole operation.
   */
  private getRemoteFileStore(): RemoteFileStore {
    try {
      return this.moduleRef.get<RemoteFileStore>(REMOTE_FILE_STORE, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: REMOTE_FILE_STORE is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see cloud-provider.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `RunService` singleton (bound to
   * {@link RUN_LOCK_SERVICE} by `run-record.module.ts`) — mirrors
   * {@link getRunRecordPersister}. {@link apply}'s gate (the atomic
   * compare-and-set step) is the only caller; a missing binding here is a
   * wiring bug, not a condition `apply` should degrade past.
   */
  private getRunLockService(): RunLockService {
    try {
      return this.moduleRef.get<RunLockService>(RUN_LOCK_SERVICE, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: RUN_LOCK_SERVICE is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see run-record.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `ConfigService` singleton (bound to
   * {@link CONFIG_CACHE_INVALIDATOR} by `config.module.ts`) — mirrors
   * {@link getRunRecordPersister}. {@link apply} calls this only on a
   * successful apply, to invalidate the memoised `getStackOutputs()` cache;
   * a failure to resolve this token is logged and swallowed at that call
   * site rather than propagated raw the way {@link getRemoteFileStore}'s is.
   */
  private getConfigCacheInvalidator(): ConfigCacheInvalidator {
    try {
      return this.moduleRef.get<ConfigCacheInvalidator>(CONFIG_CACHE_INVALIDATOR, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: CONFIG_CACHE_INVALIDATOR is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see config.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Lazily resolves the real `TfvarsService` singleton (bound to
   * {@link TFVARS_SERVICE} by `tfvars.module.ts`) — mirrors
   * {@link getRemoteFileStore}. {@link confirmRollback} is the only caller;
   * the restore write it makes through {@link TfvarsRestorer.restoreRawTfvars}
   * is as load-bearing to a rollback as reading the configuration object is
   * to {@link previewCore}, so a missing binding here is a hard failure.
   */
  private getTfvarsService(): TfvarsRestorer {
    try {
      return this.moduleRef.get<TfvarsRestorer>(TFVARS_SERVICE, { strict: false });
    } catch (err) {
      throw new Error(
        'PulumiService: TFVARS_SERVICE is not registered anywhere in the application\'s DI ' +
          `container — this is a wiring bug (see tfvars.module.ts), not a runtime condition: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Reads every value the app cares about off the deployed Pulumi stack,
   * replacing `ConfigService.getTfOutputs()`'s parse of `terraform.tfstate`.
   * Never throws — returns `null` on any failure — mirroring
   * `getTfOutputs()`'s contract, which every call site (several inside
   * `finally` blocks or ahead of code that must not be skipped, e.g.
   * `RunService.releaseRun`'s lock release) depends on.
   *
   * ## Never deployed yet: three checks, no Pulumi call
   *
   * A mere outputs read must never create a stack or generate a fresh
   * secrets passphrase — both of which
   * {@link PulumiWorkspaceService.getOrCreateStack} would do for a
   * genuinely-new stack. So this method checks, in order, for evidence a
   * stack could possibly exist before calling into Pulumi, returning `null`
   * immediately if any check fails:
   *
   * 1. `bootstrap.stateBucket` is configured — no backend has been
   *    bootstrapped otherwise.
   * 2. A secrets passphrase is already stored — {@link PulumiWorkspaceService}'s
   *    own definition of "an existing stack" (a passphrase is only persisted
   *    the first time a stack is genuinely created). Its absence means
   *    either nothing was ever deployed, or a stack exists remotely with no
   *    local passphrase record — either way this degrades to "not deployed"
   *    rather than risk generating a passphrase that can't decrypt a real
   *    stack's state.
   * 3. `aws.region` is configured — needed to build the backend URL.
   *
   * These three checks are a proxy for "a stack might exist," not a proof —
   * a destroyed stack, or a passphrase left by a failed create attempt,
   * would leave the store looking like "existing stack" with no real remote
   * stack present. This is a best-effort no-create guarantee, not an
   * airtight one.
   *
   * Only once all three checks pass does this call
   * {@link PulumiWorkspaceService.getOrCreateStack} and `stack.outputs()`
   * inside a catch-all: any failure from either call is logged and degraded
   * to `null`. Callers cannot distinguish "genuinely not deployed" from
   * "deployed, but this read failed" from the return value alone — that
   * trade avoids an unhandled rejection reaching code that assumes this read
   * never throws.
   *
   * ## Why a no-op `program` is safe here
   *
   * `LocalWorkspace.createOrSelectStack`'s `program` option is only invoked
   * by `stack.preview()`/`.up()`/`.refresh()` — `stack.outputs()` reads the
   * already-persisted state and never runs the program. So this read-only
   * method passes a trivial `async () => ({})` rather than the real
   * `createInfraProgram` (which needs a full `DeploymentConfig` this read
   * has no reason to assemble).
   *
   * ## "Empty outputs" also degrades to `null`
   *
   * A stack that exists but has never had a successful `up()` reports
   * `stack.outputs()` as `{}` — treated as "not deployed" here too,
   * mirroring `projectTfOutputs`'s identical rule for `terraform.tfstate`.
   */
  async getStackOutputs(): Promise<StackOutputs | null> {
    const stateBucket = this.store.get('bootstrap')?.stateBucket;
    if (!stateBucket) {
      return null;
    }

    const hasStoredPassphrase = this.store.get('pulumi')?.passphrase !== undefined;
    if (!hasStoredPassphrase) {
      return null;
    }

    const stateBucketRegion = this.store.get('aws')?.region;
    if (!stateBucketRegion) {
      return null;
    }

    let outputs: OutputMap;
    try {
      const stack = await this.workspace.getOrCreateStack({
        program: async () => ({}),
        stateBucket,
        stateBucketRegion,
        backendReady: true,
        stackExists: true,
      });
      outputs = await stack.outputs();
    } catch (err) {
      // Restores `getTfOutputs()`'s never-throw contract in full — see this
      // method's doc comment for why every kind of failure here (not just a
      // missing backend) degrades to `null` rather than propagating.
      logger.warn('PulumiService.getStackOutputs: failed to read stack outputs, treating as not deployed', {
        err,
      });
      return null;
    }

    if (Object.keys(outputs).length === 0) {
      logger.warn('Pulumi stack has no outputs — infra not yet deployed');
      return null;
    }

    return PulumiService.projectStackOutputs(outputs);
  }

  /**
   * Projects a raw Automation API {@link OutputMap} into {@link StackOutputs}.
   * Unlike the retired `projectTfOutputs` (which mapped `snake_case`
   * Terraform output keys onto new `camelCase` field names), NO key
   * translation happens here: `@hyveon/infra`'s `buildStackOutputs` (task
   * 3.11) already returns an object keyed by the exact `StackOutputs` field
   * names, and the Automation API registers whatever the program returns
   * as-is as the stack's output keys — so `outputs[key].value` reads
   * directly for every field. Per-field fallbacks mirror `projectTfOutputs`'s
   * defaults for a key that's absent (e.g. state predates that output).
   */
  private static projectStackOutputs(outputs: OutputMap): StackOutputs {
    const get = <T>(key: keyof StackOutputs, fallback: T): T =>
      key in outputs ? (outputs[key]!.value as T) : fallback;

    return {
      awsRegion: get('awsRegion', 'us-east-1'),
      ecsClusterName: get('ecsClusterName', ''),
      ecsClusterArn: get('ecsClusterArn', ''),
      subnetIds: get('subnetIds', []),
      securityGroupId: get('securityGroupId', ''),
      fileManagerSecurityGroupId: get('fileManagerSecurityGroupId', ''),
      efsFileSystemId: get('efsFileSystemId', ''),
      efsAccessPoints: get('efsAccessPoints', {}),
      domainName: get('domainName', ''),
      gameNames: get('gameNames', []),
      discordTableName: get('discordTableName', ''),
      auditTableName: get('auditTableName', ''),
      runsTableName: get('runsTableName', ''),
      discordBotTokenSecretArn: get('discordBotTokenSecretArn', ''),
      discordPublicKeySecretArn: get('discordPublicKeySecretArn', ''),
      interactionsInvokeUrl: get('interactionsInvokeUrl', null),
      discordInteractionsUrl: get('discordInteractionsUrl', null),
      appliedGameServers: get('appliedGameServers', null),
    };
  }

  /**
   * Runs `pulumi preview` against the current deployment configuration,
   * yielding a {@link PulumiRunChunk} per line of stdout/stderr as the
   * operation produces it, and resolving to a {@link PulumiPreviewResult}
   * once it settles — replacing `TerraformService.plan()`.
   *
   * ## Thin lock-owning wrapper around {@link previewCore}
   *
   * Everything about the actual plan operation (streaming, hashing,
   * persistence, cancellation) lives in {@link previewCore}. This method
   * only refuses if {@link operationInFlight} is already set, then sets it
   * to `'preview'` for the duration of the delegated call. The split exists
   * so {@link confirmRollback} can run the same plan logic under a lock it
   * already holds (`'rollback'`, not `'preview'`) without racing two owners
   * of {@link operationInFlight}.
   *
   * ## `preview` never takes the DIY backend lock
   *
   * Verified against the Pulumi CLI source: `diyBackend.Preview` calls
   * `b.apply` directly with no `b.Lock`/`b.Unlock`, unlike `Update`/`Import`/
   * `Refresh`/`Destroy`, which do. So `preview` can never observe or report a
   * conflicting lock — it reads whatever state snapshot is on disk,
   * unsynchronized with any concurrent `up`/`destroy`. This method
   * deliberately does not wire `PulumiLockRecovery`'s classification; `up`
   * needs it since `Update` genuinely takes the lock.
   *
   * ## Leaked-promise `recoverResult`
   *
   * The SDK's `PreviewResult` shape is `{ stdout, stderr, changeSummary }`.
   * `changeSummary` comes from the same `summaryEvent` this method's own
   * `onEvent` callback already captures, so a leak-recovery throw loses
   * nothing: `recoverResult` synthesizes `{ stdout: '', stderr: '', changeSummary }`
   * from that captured value. The saved plan artifact (`--save-plan`) is
   * already written to disk by the CLI subprocess before it exits, so it's
   * unaffected either way. `stdout`/`stderr` are left empty because this
   * method never reads the SDK's buffered strings — the streaming loop below
   * already yielded every line via `onOutput`/`onError` as it arrived.
   *
   * ## Engine-version stamping
   *
   * The saved plan artifact's `manifest.version` (e.g. `"v3.255.0"`) is read
   * and stripped of its `v` prefix by
   * {@link readEngineVersionFromPlanArtifact}, so
   * {@link PulumiPreviewResult.engineVersion} is directly `===`-comparable
   * against `PulumiEngineService.getResolvedVersion()`'s un-prefixed shape.
   *
   * `engineVersion` is stored separately from {@link planHash} rather than
   * folded into it, so an apply-time mismatch can distinguish "the plan or
   * config changed" (hash mismatch) from "only the engine was upgraded"
   * (hash match, engine version differs) — the two need different error
   * messages per the `iac-plan-apply-page` spec.
   *
   * ## Structured `changeSummary`
   *
   * `onEvent` captures `event.summaryEvent.resourceChanges` the same way the
   * SDK's internal wrapper does, specifically so the leaked-promise recovery
   * path above still has access to it. On every other path this captured
   * value equals `PreviewResult.changeSummary`, so the SDK's own value is
   * used directly for the returned result — see {@link ChangeSummary}'s doc
   * comment for the `{}`-means-"summary missed" edge case.
   *
   * ## Chunk streaming
   *
   * `onOutput`/`onError` deliver unbounded chunks, not lines. The
   * line-splitting logic accumulates a per-stream buffer, splits on
   * `/\r?\n/`, holds back the trailing partial line, and flushes any
   * remainder once the operation settles — fed directly by the Automation
   * API's callbacks rather than a child-process event emitter, with "closed"
   * signalled by the wrapped `stack.preview()` promise settling.
   *
   * ## Cancellation
   *
   * The `stack.preview()` call is wrapped in
   * {@link runWithEscalatingCancellation}, which forwards a signal into
   * `PreviewOptions.signal` and escalates to a forced termination if the
   * operation doesn't settle in time. All three of its settlement shapes
   * ({@link PulumiOperationNotStartedError}/{@link PulumiOperationAbortedError}/
   * {@link PulumiOperationEscalatedError}) are treated as "aborted" here, not
   * a {@link PulumiPreviewError} failure. No `onEscalate` hook is supplied —
   * `preview` holds no backend lock to forcefully clear.
   *
   * The signal forwarded is an internal `AbortController` this method owns
   * (chained one-way from the caller's `signal`), not `signal` itself, so a
   * force-closed generator (`break`/`.return()`/`.throw()` on the generator)
   * still has something to cancel: the outer `finally` aborts this internal
   * controller and awaits its settlement before clearing
   * {@link operationInFlight}, so a torn-down consumer can never leave the
   * CLI subprocess running unsupervised against the shared workspace
   * directory while this instance reports itself free.
   *
   * ## Persistence
   *
   * Once the operation settles (success, failure, or abort), this method
   * writes the accumulated transcript, settles the active-run buffer, writes
   * the local run record, and persists it to the run-history store — on
   * every exit path, including the force-closed-generator path handled by
   * the outer `finally`. A persistence failure is wrapped in
   * {@link PulumiRunPersistError} carrying the already-computed outcome
   * rather than discarding it.
   *
   * @param configVersionId - The deployment-config object's S3 version id
   *   this preview is expected to run against, if any. When supplied and it
   *   no longer matches the configuration object's current head version,
   *   throws before any Pulumi call is made. Ignored when omitted.
   * @param signal - Optional cancellation signal — see "Cancellation" above.
   * @param preMintedRunId - Optional caller-minted `runId`; must match
   *   {@link RUN_ID_PATTERN}.
   * @param rolledBackFrom - The `runId` of the `apply` run this preview is
   *   re-planning after a rollback — passed through to the persisted run
   *   record unchanged.
   * @throws A descriptive `Error` if another `preview`/`up`/`destroy` is
   *   already in flight on this instance, or if `preMintedRunId` doesn't
   *   match {@link RUN_ID_PATTERN} — checked at the top of the method body,
   *   so the throw happens on the generator's first `.next()` call, not when
   *   `preview(...)` is called (which only constructs the generator).
   * @throws A descriptive `Error` if no configuration bucket is configured,
   *   the configuration object doesn't exist, or `configVersionId` is stale.
   * @throws {@link PulumiPreviewError} if `stack.preview()` itself fails (not
   *   an abort).
   * @throws {@link PulumiPlanHashError} if the operation succeeded but the
   *   saved plan artifact couldn't be hashed or its `manifest.version`
   *   couldn't be read afterward.
   * @throws {@link PulumiRunPersistError} if the operation settled but the
   *   run record couldn't be persisted afterward.
   */
  async *preview(
    configVersionId?: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
    rolledBackFrom?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    if (this.operationInFlight) {
      throw new Error(
        `PulumiService.preview() cannot run while ${this.operationInFlight}() is already ` +
          'running; wait for it to finish before calling preview() again.',
      );
    }
    if (preMintedRunId !== undefined) {
      PulumiService.assertValidRunId(preMintedRunId);
    }
    this.operationInFlight = 'preview';
    try {
      return yield* this.previewCore(configVersionId, signal, preMintedRunId, rolledBackFrom);
    } finally {
      this.operationInFlight = null;
    }
  }

  /**
   * The actual `pulumi preview` operation {@link preview} runs — every
   * behavior preview's own TSDoc documents (streaming, plan-hash
   * computation, cancellation, persistence, the force-closed-generator
   * safety net) lives here unchanged. Split out from {@link preview} so
   * {@link confirmRollback} can run this same logic while it, not this
   * method, owns {@link operationInFlight} (acquired as `'rollback'` before
   * the historic configuration is restored, and held across the restore and
   * this call — see {@link confirmRollback}'s TSDoc). This method therefore
   * does not touch {@link operationInFlight} at all — trusting whichever
   * caller invoked it to have already claimed it and to release it once
   * settled. Never call this method without {@link operationInFlight}
   * already set by the caller — it has no guard of its own against two
   * concurrent invocations racing the shared local workspace directory.
   *
   * `preMintedRunId` validation lives in each caller's own top-of-function
   * guard (mirroring `apply()`/`destroy()`), so both {@link preview} and
   * {@link confirmRollback} reject a malformed id before touching
   * {@link operationInFlight} — this method trusts it's already valid.
   */
  private async *previewCore(
    configVersionId?: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
    rolledBackFrom?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    // Hoisted above the try block — mirrors TerraformService.plan()'s
    // identical hoist: a force-closed generator (consumer break/.return()/
    // .throw()) unwinds straight from `yield chunk` below, past the
    // writeRunRecord call further down, to the outer finally, which needs
    // to see these.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // Accumulates every yielded chunk's `line` so the full transcript can be
    // written to `<runsDir>/<runId>/pulumi.log` in a single `writeFileSync`
    // once the operation has settled — mirrors TerraformService.plan()'s
    // `logLines`.
    const logLines: string[] = [];
    // `internalController`/`operationPromise`/`operationSettled` are hoisted
    // (not declared inside the try block) so the outer `finally` can abort
    // AND await a still-running `stack.preview()` call if this generator is
    // force-closed (consumer `break`/`.return()`/`.throw()`) while the
    // operation is in flight — see the outer `finally`'s own comment for why
    // this is required, not optional: `TerraformService.plan()`'s equivalent
    // safety net is its inner `try/finally` around the drive loop, whose
    // `finally` calls `stream.return({ aborted: true })` to force
    // `spawnAndStream`'s OWN finally to run (kill the child, then await its
    // `close` event) before this generator's own outer finally proceeds to
    // clear `workspaceInFlight`. This generator has no inner sub-generator to
    // delegate that to (the Automation API's `onOutput`/`onError` are plain
    // callbacks, not a stream this code owns the lifecycle of) — the
    // `internalController`/`operationPromise` pair below is the equivalent
    // mechanism, built by hand.
    //
    // `internalController` is ALWAYS the signal actually forwarded to
    // `stack.preview()` (via `runWithEscalatingCancellation`) — never the
    // caller-supplied `signal` directly. When `signal` is supplied, this
    // controller mirrors it (aborting the instant `signal` does); when the
    // generator is force-closed, the outer `finally` aborts THIS controller
    // directly, regardless of whether the caller ever supplied a `signal` at
    // all — otherwise a caller that never passes `signal` would have no
    // cancellation path at all on a force-close, leaving the CLI subprocess
    // to run to completion ungoverned while `operationInFlight` is already
    // cleared for a new call.
    const internalController = new AbortController();
    if (signal) {
      if (signal.aborted) {
        internalController.abort();
      } else {
        signal.addEventListener('abort', () => internalController.abort());
      }
    }
    // Set once `stack.preview()` has actually been invoked (via
    // `runWithEscalatingCancellation`) — `undefined` for the whole method if
    // an early guard (bucket not configured, stale config version, etc.)
    // returns/throws before ever reaching that point, in which case the
    // outer `finally` has nothing to abort/await.
    let operationPromise: Promise<PreviewResult> | undefined;
    // Flips to `true` once `operationPromise` has genuinely settled (success,
    // failure, or the bounded escalation timeout `runWithEscalatingCancellation`
    // itself enforces — see that function's own TSDoc for why awaiting
    // `operationPromise` in the outer `finally` below is still a BOUNDED
    // wait, not an indefinite one, even for a wedged engine). Doubles as the
    // chunk-drain loop's own "operation is done" signal further down.
    let operationSettled = false;
    try {
      if (internalController.signal.aborted) {
        // Already aborted before we even started — end the generator
        // cleanly without touching Pulumi at all, mirroring plan()'s
        // identical pre-spawn guard.
        return undefined;
      }

      // Mint (or adopt the pre-minted) runId and register its active-run
      // buffer *here* — before the pre-spawn awaits below (the config
      // fetch, then `getOrCreateStack`'s engine resolution) — mirrors
      // TerraformService.plan()'s identical ordering and rationale: a
      // `streamRunOutput()` subscriber that arrives before those awaits
      // settle still finds the run already in flight.
      runId = preMintedRunId ?? randomUUID();
      this.beginActiveRun(runId);

      const bucket = this.getConfigurationBucket();
      if (!bucket) {
        throw new Error(
          'Cannot read deployment configuration for pulumi preview: no configuration bucket is configured. ' +
            'Finish the setup wizard before previewing.',
        );
      }

      const key = CONFIGURATION_OBJECT_KEY;
      const versions = await this.getRemoteFileStore().listVersions(key);
      const head = versions[0];
      if (!head) {
        throw new Error(`Configuration object "${key}" not found in S3 bucket "${bucket}".`);
      }
      if (configVersionId && head.versionId !== configVersionId) {
        throw new Error(
          `Configuration object "${key}" in S3 bucket "${bucket}" is stale for this preview: expected version ` +
            `"${configVersionId}" to still be the current head, but the head version is now ` +
            `"${head.versionId}". Refresh the configuration before previewing.`,
        );
      }
      const obj = await this.getRemoteFileStore().get(key);
      if (!obj) {
        throw new Error(`Configuration object "${key}" not found in S3 bucket "${bucket}".`);
      }
      // The version this run actually ran against — either the caller's
      // expectation (just confirmed to still be the head above) or, when no
      // expectation was supplied, whatever the head happened to be. Always
      // defined by the time `startedAt` is set below, so it's safe to record
      // on every outcome (success/failure/abort) — mirrors how `pullVarFile`
      // always resolves a var-file path before `plan()`'s own `startedAt` is set.
      const observedConfigVersionId = head.versionId;
      const deploymentConfig = JSON.parse(new TextDecoder().decode(obj.body)) as DeploymentConfig;

      if (internalController.signal.aborted) {
        // Aborted while reading the configuration — end cleanly before ever
        // touching Pulumi.
        return undefined;
      }

      const stateBucket = this.store.get('bootstrap')?.stateBucket;
      const stateBucketRegion = this.store.get('aws')?.region;
      if (!stateBucket || !stateBucketRegion) {
        throw new Error(
          'Cannot run pulumi preview: the state bucket / AWS region has not been configured yet. ' +
            'Complete the bootstrap step before previewing.',
        );
      }
      // Mirrors `PulumiService.getStackOutputs()`'s own proxy for "an
      // existing stack": a passphrase is only ever persisted the first time
      // a stack is genuinely created (see `PulumiWorkspaceService.resolvePassphrase`'s
      // doc comment) — its presence is the best signal this seam has for
      // `stackExists` without an extra backend round-trip.
      const stackExists = this.store.get('pulumi')?.passphrase !== undefined;

      const stack = await this.workspace.getOrCreateStack({
        program: createInfraProgram(deploymentConfig, { lambdaBundlesDir: this.getLambdaBundlesDir() }),
        stateBucket,
        stateBucketRegion,
        backendReady: true,
        stackExists,
      });

      if (internalController.signal.aborted) {
        // Aborted while resolving the workspace/engine — end cleanly before
        // calling stack.preview().
        return undefined;
      }

      const runDir = join(this.getRunsDir(), runId);
      mkdirSync(runDir, { recursive: true });
      const artifactPath = join(runDir, `${runId}.plan.json`);

      // --- Chunk-streaming setup (ported from spawnAndStream's algorithm — see this method's TSDoc) ---
      const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
      const queue: PulumiRunChunk[] = [];
      let wake: (() => void) | null = null;

      const notify = (): void => {
        wake?.();
        wake = null;
      };
      const push = (chunk: PulumiRunChunk): void => {
        queue.push(chunk);
        notify();
      };
      const handleData = (stream: 'stdout' | 'stderr', data: string): void => {
        buffers[stream] += data;
        const lines = buffers[stream].split(/\r?\n/);
        buffers[stream] = lines.pop() ?? '';
        for (const line of lines) {
          push({ stream, line });
        }
      };

      let capturedChangeSummary: ChangeSummary = {};
      const onOutput = (out: string): void => handleData('stdout', out);
      const onError = (err: string): void => handleData('stderr', err);
      const onEvent = (event: EngineEvent): void => {
        if (event.summaryEvent) {
          // See this method's TSDoc "Structured changeSummary" section for
          // why this is captured independently of PreviewResult.changeSummary.
          capturedChangeSummary = event.summaryEvent.resourceChanges;
        }
      };

      // Captured immediately before the operation is invoked, mirroring
      // plan()'s `startedAt = new Date().toISOString()` placement — the
      // active-run buffer was already registered above, ahead of the
      // pre-spawn awaits.
      startedAt = new Date().toISOString();

      operationPromise = runWithEscalatingCancellation(
        (innerSignal) =>
          runTreatingLeakedPromiseAsSuccess(
            () => stack.preview({ plan: artifactPath, onOutput, onError, onEvent, signal: innerSignal }),
            // See this method's TSDoc "Leaked-promise recoverResult" section
            // for why nothing needs re-reading here.
            () => Promise.resolve<PreviewResult>({ stdout: '', stderr: '', changeSummary: capturedChangeSummary }),
          ),
        internalController.signal,
      );

      // Mirrors spawnAndStream's `child.on('close', ...)` handler: flush any
      // trailing partial line from both buffers, then mark settled — done
      // from the SAME handler (attached to both the resolve and reject
      // paths) so the drain loop below needs no special-casing between them.
      // Also the outer `finally`'s signal that a force-close has nothing
      // left to await — see that block's comment.
      const onOperationSettled = (): void => {
        for (const stream of ['stdout', 'stderr'] as const) {
          if (buffers[stream].length > 0) {
            push({ stream, line: buffers[stream] });
            buffers[stream] = '';
          }
        }
        operationSettled = true;
        notify();
      };
      operationPromise.then(onOperationSettled, onOperationSettled);

      // Drain loop — identical shape to spawnAndStream's, driven by
      // `operationSettled` instead of `closed`.
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift()!;
          logLines.push(chunk.line);
          this.recordRunChunk(runId, chunk);
          yield chunk;
          continue;
        }
        if (operationSettled) {
          break;
        }
        await new Promise<void>((resolveWait) => {
          wake = resolveWait;
        });
      }

      let previewResult: PreviewResult | undefined;
      let previewError: unknown;
      try {
        previewResult = await operationPromise;
      } catch (err) {
        previewError = err;
      }

      const wasAborted =
        previewError instanceof PulumiOperationNotStartedError ||
        previewError instanceof PulumiOperationAbortedError ||
        previewError instanceof PulumiOperationEscalatedError;

      // Read the saved plan artifact back off disk once the operation has
      // genuinely succeeded — mirrors plan()'s `computePlanHash` call site
      // exactly, including catching a post-success read failure into a
      // typed error rather than letting it propagate raw.
      let planHash: string | undefined;
      let engineVersion: string | undefined;
      let planHashError: PulumiPlanHashError | undefined;
      if (!wasAborted && !previewError) {
        try {
          engineVersion = this.readEngineVersionFromPlanArtifact(artifactPath);
          planHash = this.computePlanHash(artifactPath, observedConfigVersionId);
        } catch (err) {
          planHashError = new PulumiPlanHashError(runId, artifactPath, err);
        }
      }

      const outcome: PulumiPreviewOutcome = wasAborted
        ? { kind: 'aborted' }
        : previewError
          ? { kind: 'failed', error: new PulumiPreviewError(previewError) }
          : planHashError
            ? { kind: 'failed', error: planHashError }
            : {
                kind: 'success',
                result: {
                  runId,
                  artifactPath,
                  changeSummary: previewResult!.changeSummary,
                  planHash: planHash!,
                  engineVersion: engineVersion!,
                },
              };

      runRecordWritten = true;
      this.writeRunLog(runId, logLines);
      this.endActiveRun(runId);

      const completedAt = new Date().toISOString();
      const exitCode = outcome.kind === 'aborted' ? null : outcome.kind === 'success' ? 0 : 1;
      const resultChangeSummary = outcome.kind === 'success' ? outcome.result.changeSummary : undefined;
      const resultPlanHash = outcome.kind === 'success' ? outcome.result.planHash : undefined;
      const resultEngineVersion = outcome.kind === 'success' ? outcome.result.engineVersion : undefined;

      try {
        this.writeRunRecord(
          runId,
          'plan',
          startedAt,
          completedAt,
          exitCode,
          observedConfigVersionId,
          resultPlanHash,
          rolledBackFrom,
          resultChangeSummary,
          resultEngineVersion,
        );
      } catch (err) {
        throw new PulumiRunPersistError(runId, PulumiService.toOperationOutcome(outcome), err);
      }
      await this.persistRunRecord(
        runId,
        'plan',
        startedAt,
        completedAt,
        exitCode,
        observedConfigVersionId,
        resultPlanHash,
        rolledBackFrom,
        resultChangeSummary,
        resultEngineVersion,
      );

      if (outcome.kind === 'aborted') {
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Covers the force-closed generator case (consumer `break`/`.return()`/
      // `.throw()`): if `stack.preview()` was actually invoked and hasn't
      // settled yet, this generator was torn down while the CLI subprocess
      // was still genuinely running. Abort it — `internalController.abort()`
      // fires the SAME signal already forwarded into `stack.preview({ signal })`,
      // triggering the SDK's own `SIGINT` handling — and AWAIT the resulting
      // settlement before doing anything else, most importantly before
      // `this.operationInFlight = null` below. Without this await,
      // `operationInFlight` would be cleared while the subprocess (and the
      // shared `workDir`/`Pulumi.<stack>.yaml` it's still writing to) is
      // still live, letting a new `preview()`/`up()`/`destroy()` call start
      // immediately and race against it on that shared local state — exactly
      // what `operationInFlight`'s own doc comment says this guard exists to
      // prevent. Mirrors `TerraformService.plan()`'s inner
      // `stream.return({ aborted: true })` call, which drives
      // `spawnAndStream`'s own `finally` (kill the child, await its `close`
      // event) before that generator's outer `finally` proceeds — this
      // generator has no inner sub-generator to delegate to (the Automation
      // API's `onOutput`/`onError` are plain callbacks, not a stream), so the
      // `internalController`/`operationPromise` pair is the hand-built
      // equivalent. The wait is still BOUNDED, not indefinite:
      // `runWithEscalatingCancellation` (already wrapping `operationPromise`)
      // gives up waiting on a genuinely wedged operation after its own
      // escalation timeout and settles anyway — see that function's TSDoc.
      if (operationPromise && !operationSettled) {
        internalController.abort();
        await operationPromise.catch(() => {
          // Only here to observe settlement — the actual outcome (success,
          // `PulumiOperationAbortedError`, `PulumiOperationEscalatedError`,
          // or a genuine failure) is irrelevant to a generator that's
          // already being torn down for an unrelated reason; the point is
          // only that the underlying call has now genuinely finished.
        });
      }

      if (runId !== undefined) {
        this.endActiveRun(runId);
      }
      if (runId !== undefined && startedAt !== undefined && !runRecordWritten) {
        logger.warn('pulumi preview cancelled — generator force-closed while running', { runId });
        this.writeRunLog(runId, logLines);
        const completedAt = new Date().toISOString();
        // `configVersionId` (the caller's original expectation, in scope
        // from the function signature) is threaded through here rather than
        // `observedConfigVersionId` (the version this run actually resolved
        // to reading the configuration object) — that variable is
        // block-scoped inside the `try` above and unreachable here; this
        // mirrors `TerraformService.plan()`'s identical force-killed
        // fallback, which threads its own caller-supplied `tfvarsVersionId`
        // through for the same reason.
        try {
          this.writeRunRecord(runId, 'plan', startedAt, completedAt, null, configVersionId, undefined, rolledBackFrom);
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
        await this.persistRunRecord(runId, 'plan', startedAt, completedAt, null, configVersionId, undefined, rolledBackFrom);
      }
      // NOTE: `operationInFlight` is deliberately NOT cleared here — this
      // method never sets it either. The caller ({@link preview} or
      // {@link confirmRollback}) owns the full set/clear lifecycle in its own
      // `finally`, which only runs once this generator (including this very
      // `finally` block) has fully completed.
    }
  }

  /**
   * Runs `pulumi up` constrained by a previously approved, unexpired plan —
   * `TerraformService.apply`'s successor, replacing
   * `TerraformController.apply`'s controller-side gate with a
   * self-contained gate this method owns end-to-end. There is no
   * `PulumiController`, so this method resolves everything it needs itself.
   *
   * ## The 8-step gate, in the order the `iac-plan-apply-page` spec requires
   *
   * 1. `RunRecordPersister.getByRunId(planRunId)` — a record exists at all.
   *    Throws {@link PulumiPlanRunNotFoundError} otherwise.
   * 2. `record.kind === 'plan'`. Throws {@link PulumiPlanRunWrongKindError}
   *    otherwise.
   * 3. `record.approvedBy && record.approvedAt` are both set. Throws
   *    {@link PulumiPlanNotApprovedError} otherwise.
   * 4. `!isApprovalExpired(record.approvedAt)` (the fixed 15-minute
   *    `APPROVAL_WINDOW_MS` window, `@hyveon/shared/runs.js`). Throws
   *    {@link PulumiApprovalExpiredError} otherwise.
   * 5. `record.planHash === planHash` — the caller-supplied hash matches the
   *    record's own stored hash. Throws {@link PulumiPlanHashMismatchError}
   *    otherwise (a forged or stale hash can never reach `stack.up()`).
   * 6. Re-verifies the record's hash against reality, in two parts, neither
   *    of which parses the on-disk plan artifact as JSON — the spec
   *    requires the configuration check not depend on the plan file being
   *    parseable:
   *    - 6a. The configuration object's current head version id is compared
   *      directly against `record.tfvarsVersionId`. A mismatch means the
   *      configuration was written again since the plan was reviewed —
   *      throws {@link StalePlanError} (reused from the configuration-object
   *      versioning case it already describes).
   *    - 6b. The on-disk plan artifact is re-hashed
   *      (`computePlanHash(artifactPath, currentConfigVersionId)` — raw
   *      bytes only) and compared against `record.planHash`. Since 6a
   *      already proved the config version is unchanged, a mismatch here
   *      means the artifact's bytes differ from what was hashed at plan
   *      time — swapped or tampered with since review. Throws
   *      {@link PulumiPlanArtifactStaleError} (a byte-tamper case
   *      `StalePlanError` doesn't cover), also wrapping a read/hash failure
   *      as `cause` if the artifact can't be read at all.
   * 7. The plan's stamped `record.engineVersion` (already normalized, no `v`
   *    prefix) is compared against `PulumiEngineService.getResolvedVersion()`
   *    (`this.engine.resolve()` awaited first so the accessor is populated
   *    even on a fresh session; a no-op if already resolved). A mismatch
   *    throws {@link PulumiEngineVersionMismatchError}, naming both versions.
   * 8. **Then, and only then**: `RunLockService.createRun('apply', initiator, planRunId)`
   *    — the final, authoritative step. Steps 1-7 are pure reads; no
   *    "is it free" pre-check is performed anywhere in this method
   *    deliberately, since that's exactly the race condition an atomic gate
   *    exists to eliminate. Two concurrent `apply()` calls for the same plan
   *    race through steps 1-7 harmlessly and only one wins this step's
   *    atomic reservation (`RunService.createRun`'s in-memory check-then-set
   *    is synchronous before its first `await`; its DynamoDB layer is a
   *    genuine conditional `PutItem`). The loser's `createRun` call rejects
   *    with `RunLockHeldError` (`@hyveon/shared`), propagated raw for a
   *    future controller to map onto an ack shaped like
   *    `{ started: false, conflict: 'apply' }`.
   *
   * `operationInFlight` is only ever set once — synchronously, immediately
   * after `createRun` resolves (see "Nothing is reserved before step 8"
   * below) — never before gate step 1. The top-of-function check still
   * exists, but only to refuse an `apply()` call arriving while a
   * `preview`/`destroy` call, or an apply that has already won its lock, is
   * genuinely using the shared local workspace directory — a concern
   * independent of the durable apply lock, since two Automation API
   * invocations against the same `workDir` would corrupt local state
   * regardless of what `RunService` thinks. Two `apply()` calls racing
   * through steps 1-7 can never observe each other via this field; only
   * `createRun`'s own atomicity orders them.
   *
   * `initiator` is resolved internally via {@link resolveInitiator}
   * (`os.userInfo().username`) rather than taken as a parameter, since this
   * method is self-contained and there is no controller to resolve it
   * instead.
   *
   * `runId` is always `planRunId` itself (never a fresh `randomUUID()`), so
   * the plan artifact, the plan's `run.json`, and the apply's `run.json` all
   * live under one `<runsDir>/<planRunId>/` directory, and
   * `RunLockService.createRun`'s `runId` parameter is the same key the gate
   * and the plan/apply lineage need to agree on.
   *
   * ## Nothing is reserved before step 8
   *
   * `this.beginActiveRun(runId)`, `this.operationInFlight = 'up'`, and
   * `this.store.recordPulumiLockAttempt(...)` are all called only after
   * step 8's `createRun` has resolved successfully and the post-`createRun`
   * local-workspace re-check immediately below has itself passed. That
   * re-check re-reads `operationInFlight` to close the residual TOCTOU gap
   * between the top-of-function check and this point (a `preview`/`destroy`
   * call could have started and set the field during gate steps 1-7's
   * awaits). If it finds the field already set, the durable lock this call
   * just won is released (`RunLockService.releaseRun`) and the call is
   * refused — nothing was reserved from the operator's point of view, so
   * this simply undoes gate step 8. In practice this re-check can only ever
   * observe `'preview'`/`'destroy'`, never `'up'` from a sibling apply,
   * since `RunService`'s lock is a single global slot.
   *
   * ## `up()` takes the DIY backend lock (unlike `preview`)
   *
   * `diyBackend.Update` (the path `stack.up()` reaches) wraps its call in
   * `Lock`/`Unlock`, unlike `Preview` (see {@link preview}'s TSDoc). This is
   * why, unlike `preview`, this method wires the lock-recovery primitives
   * below.
   *
   * ## Lock-recovery wiring
   *
   * Immediately before calling `stack.up()` (never earlier — see "Nothing
   * is reserved before step 8"), this method records a lock-ownership
   * attempt via `ElectronStoreService.recordPulumiLockAttempt(PULUMI_STACK_NAME)`.
   * On every settlement of `stack.up()` except
   * {@link PulumiOperationEscalatedError}, the attempt is cleared via
   * `clearPulumiLockAttempt` — a normal CLI exit releases its own DIY lock,
   * so the record is no longer needed as reclaim evidence. An escalated
   * (forceful-termination) settlement is the one case the record is
   * deliberately left behind for — see "Force-close safety net" below.
   *
   * If `stack.up()` rejects with a lock conflict (`isStackLockConflict`),
   * the rejection is classified via
   * `PulumiLockRecovery.classifyStackLockConflict`:
   * - `'reclaimable-own-orphan'` — every lock present is provably this
   *   installation's own dead orphan (identity + liveness + time-consistency).
   *   This method clears the lock via `stack.cancel()` and retries
   *   `stack.up()` once with the same options/signal — no operator
   *   confirmation, per the spec's "the app MAY reclaim it without
   *   prompting".
   * - `'requires-confirmation'` (anything not provably an own orphan) —
   *   throws {@link PulumiUnrecognizedLockError} (holder + age carried on
   *   `locks`) and clears nothing; reclaiming an unrecognized lock needs
   *   explicit operator confirmation.
   *
   * ## Known gap: force-close safety net for a wedged engine
   *
   * `preview()`'s outer `finally` — mirrored here — aborts and awaits its
   * internal operation on a force-closed generator, but that `finally` can
   * only run once the generator's current suspension point resolves. If the
   * generator is parked on its internal drain-loop `await` waiting for
   * `stack.up()` to settle, and `stack.up()` is genuinely wedged (ignores
   * `SIGINT`, or stuck inside a cloud-provider API call),
   * `runWithEscalatingCancellation`'s escalation timer never arms — arming
   * requires `internalController.abort()`, which only this method's own
   * `finally` calls absent a caller-supplied `signal`, and that `finally`
   * can't run until the wedged `await` resolves. This circular dependency
   * means a wedged engine with no caller-supplied `signal` can leave this
   * generator suspended indefinitely with the DIY backend lock still held.
   * Closing it fully (an unconditional watchdog, or a real killable process
   * handle) is a larger change than this method takes on.
   *
   * The lock-ownership record above is a sufficient backstop for this exact
   * gap: it's a synchronous write to `electron-store` made before
   * `stack.up()` is invoked, so it survives regardless of any later hang.
   * Once the wedged CLI process eventually exits by any means, its PID
   * becomes provably dead, and the next `preview`/`up`/`destroy` attempt
   * that hits the same lock conflict will have `classifyStackLockConflict`
   * find this run's record, confirm identity + liveness + time-consistency,
   * and classify it `'reclaimable-own-orphan'` — reclaiming automatically,
   * even though this run couldn't clean up after itself.
   *
   * ## Partial-apply detection
   *
   * `UpResult` carries no "was this partial" signal, so it's inferred from
   * the `onEvent` stream. `resOutputsEvent` fires once per resource that
   * finished being provisioned (distinct from `resourcePreEvent`, which
   * fires before a resource is touched and would over-count in-flight
   * steps). Every `resOutputsEvent` whose `metadata.op` is in
   * {@link MUTATING_OP_TYPES} is accumulated into `completedSteps` as it
   * streams. If `stack.up()` ultimately fails (not aborted, not
   * leak-recovered) and `completedSteps.length > 0`, the failure is wrapped
   * in {@link PulumiPartialApplyError} (carrying `completedSteps`) instead
   * of {@link PulumiUpError} — a clean failure still gets
   * {@link PulumiUpError}. `PulumiUnrecognizedLockError` is a distinct third
   * shape (the update never even started) and is thrown as-is.
   *
   * ## Terminal-state representation
   *
   * `RunRecord.status`/`PulumiRunRecord.exitCode` stay a closed
   * success/failed/aborted triple; `partialApply` is an additive boolean
   * rather than a fourth `RunStatus` value, since `RunStatus` is the
   * `status-index` DynamoDB GSI's hash key.
   *
   * **`partialApply` is independent of which non-`'success'` status the run
   * settled with.** A resource step can have already been applied whether
   * the run subsequently failed or was aborted (e.g. the operator cancelling
   * mid-`up()` — arguably the most likely real-world partial-apply case).
   * `partialApply` is computed from whether `completedSteps` is non-empty,
   * gated only on `outcome.kind !== 'success'` — never on
   * `status === 'failed'` specifically. Any consumer MUST check
   * `partialApply` directly rather than gating behind `status === 'failed'`
   * first, or it will silently miss every aborted-mid-apply partial — the
   * exact case the spec's "re-plan rather than retry blindly after a
   * partial failure" requirement needs to catch.
   *
   * ## Leaked-promise `recoverResult`
   *
   * If `stack.up()` rejects with the SDK's leaked-promise message, the
   * update already succeeded in the backend — only the synthetic `UpResult`
   * is unrecoverable from the rejected promise. `recoverResult` re-reads
   * `stack.outputs()` and `stack.info()` (fresh, independent, read-only
   * calls) to reconstruct a well-typed `UpResult`. `stack.info()`'s `result`
   * field is checked and a mismatch from `'succeeded'` is logged as a
   * sanity-check WARN but doesn't override the recovery. `changeSummary`
   * needs no re-reading — the `capturedChangeSummary` this method's own
   * `onEvent` closure captured lives in local state, untouched by the leak.
   *
   * ## Cache invalidation
   *
   * On a successful apply only — a failed/aborted/partial apply didn't
   * durably change what a fresh `getStackOutputs()` read would report —
   * `ConfigCacheInvalidator.invalidateCache()` is called, resolved lazily
   * via {@link getConfigCacheInvalidator}. Best-effort: a failure to resolve
   * or call it is logged and swallowed rather than masking an otherwise
   * successful apply; without this call nothing in production would
   * invalidate the cache after a deploy, leaving the dashboard showing "not
   * deployed" indefinitely.
   *
   * ## Cancellation and abort-listener leak
   *
   * Mirrors {@link preview}'s `internalController`/`operationPromise`
   * cancellation shape. The `signal.addEventListener('abort', ...)` call
   * below passes `{ once: true }`, so a caller that reuses the same
   * `AbortSignal` across repeated calls never accumulates more than one live
   * listener per `apply()` invocation. The escalation timer arms on every
   * force-close even with no caller-supplied `signal`.
   *
   * ## Persistence
   *
   * Once gate step 8 succeeds, every settlement (success, failure, partial
   * failure, or abort) goes through the same
   * `writeRunLog`/`endActiveRun`/`writeRunRecord`/`persistRunRecord`
   * sequence {@link preview} uses — `kind: 'apply'`, `tfvarsVersionId`/
   * `planHash`/`engineVersion` passed through from the validated plan
   * record (not re-derived), plus the new `partialApply` indicator.
   * `RunRecordService.persist`'s own `finally` releases the durable apply
   * lock gate step 8 acquired — no separate `RunLockService.releaseRun` call
   * is made by this method on any path. A gate failure (steps 1-7) never
   * reaches this point: `runId` is only assigned after step 8 succeeds, so a
   * rejected gate call writes no run record and holds no lock to release.
   *
   * @param planRunId - The `runId` of the approved `plan` run to apply — also
   *   reused, unchanged, as this apply run's own `runId`.
   * @param planHash - The plan hash the caller expects this plan run to
   *   still carry (gate step 5) — normally the value the originating
   *   `preview()` call returned.
   * @param signal - Optional cancellation signal — see "Cancellation" above.
   * @throws {@link PulumiOperationInFlightError} if another `preview`/`up`/
   *   `destroy`/`rollback` is already in flight on this instance (the
   *   top-of-function busy check, before gate step 1).
   * @throws {@link PulumiPlanRunNotFoundError}, {@link PulumiPlanRunWrongKindError},
   *   {@link PulumiPlanNotApprovedError}, {@link PulumiApprovalExpiredError},
   *   {@link PulumiPlanHashMismatchError}, {@link StalePlanError}, or
   *   {@link PulumiPlanArtifactStaleError} if the corresponding gate step
   *   (1-6) fails.
   * @throws {@link PulumiEngineVersionMismatchError} if gate step 7 fails.
   * @throws `RunLockHeldError` (`@hyveon/shared`, unwrapped) if gate step 8
   *   loses the atomic race for the apply lock.
   * @throws {@link PulumiUnrecognizedLockError} if `stack.up()` hits a
   *   backend lock conflict that cannot be proven this installation's own
   *   orphan.
   * @throws {@link PulumiPartialApplyError} if `stack.up()` fails after at
   *   least one resource step already applied.
   * @throws {@link PulumiUpError} if `stack.up()` fails cleanly (no resource
   *   step applied).
   * @throws {@link PulumiRunPersistError} if the operation settled but the
   *   run record couldn't be persisted afterward.
   */
  async *apply(
    planRunId: string,
    planHash: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PulumiRunChunk, PulumiUpResult | undefined> {
    // Checked (never SET here — see "Nothing is reserved before step 8"
    // below) so an `apply()` call arriving while a `preview`/`destroy`/
    // already-lock-won `apply` is genuinely running the engine is refused
    // immediately, without wasting a gate read that would lose anyway.
    // Deliberately does NOT gate two applies racing for the same (or
    // different) plan: those must both reach gate step 8 and be ordered by
    // `RunLockService.createRun`'s own atomicity, never by this observation.
    if (this.operationInFlight) {
      throw new PulumiOperationInFlightError(this.operationInFlight);
    }
    PulumiService.assertValidRunId(planRunId);
    // Hoisted above the try block — mirrors preview()'s identical hoist: a
    // force-closed generator unwinds straight to the outer `finally`, which
    // needs to see these regardless of how far the gate/operation got.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // `true` only once THIS invocation has itself set `operationInFlight`
    // (post gate-step-8, see below) — gates the outer `finally`'s reset so a
    // gate failure that never touched the field can never null out some
    // other concurrently-running operation's own flag.
    let ownsOperationInFlight = false;
    // `true` once a call that genuinely attempted to release the durable
    // apply lock has completed — set after the normal-path `persistRunRecord`
    // call (whose own `RunRecordService.persist` releases the lock in its
    // own `finally`) and after the force-close fallback's equivalent call.
    // Gates the outer `finally`'s unconditional backstop `releaseRun` call so
    // it does not also fire on every ordinary successful apply —
    // `RunService.releaseRun` awaits `ConfigService.getStackOutputs()`, which
    // the just-run `invalidateCache()` call guarantees will miss its cache
    // and re-spawn two more `pulumi` CLI subprocesses on the hot path for no
    // reason (the lock was already released moments earlier). The backstop is
    // only needed on the one path this flag stays `false` for: `writeRunRecord`
    // itself throwing, which skips `persistRunRecord` entirely.
    let lockReleased = false;
    // The gate-validated tfvarsVersionId/engineVersion, hoisted the instant
    // the plan record is fetched (well before the lock is acquired) so the
    // outer `finally`'s force-closed fallback can still thread them through
    // its own best-effort run-record write.
    let tfvarsVersionId: string | undefined;
    let engineVersion: string | undefined;
    // Hoisted so the outer `finally`'s force-closed fallback can persist real
    // changeSummary/partial-apply data instead of nothing — see this method's
    // TSDoc, "Partial-apply detection", for why this must be visible on every
    // settlement path, not only a clean `outcome.kind === 'failed'`.
    let capturedChangeSummary: ChangeSummary = {};
    const completedSteps: PulumiPartialApplyStep[] = [];
    // The id `ElectronStoreService.recordPulumiLockAttempt` returns, kept in
    // scope so both the normal-completion path and the outer `finally`'s
    // force-close path can clear it — see the TSDoc's "Lock-recovery wiring"
    // section for exactly when each does and does not clear it.
    let lockAttemptId: string | undefined;
    const logLines: string[] = [];
    // Same internal-controller pattern as preview() — see that method's
    // TSDoc for the full rationale. Named (rather than inline) `onAbort` so
    // the outer `finally` can unconditionally `removeEventListener` it on
    // every exit path, not only once it fires: `{ once: true }` alone only
    // detaches the listener once `signal` itself aborts, so on the common
    // path (the signal never aborts) the listener would otherwise stay
    // attached for the signal's entire lifetime — a caller reusing one
    // long-lived `AbortSignal` across many `apply()` calls would accumulate
    // one listener per call.
    const internalController = new AbortController();
    const onAbort = (): void => internalController.abort();
    if (signal) {
      if (signal.aborted) {
        internalController.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let operationPromise: Promise<UpResult> | undefined;
    let operationSettled = false;
    try {
      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate steps 1-5: pure record comparisons, no I/O beyond the lookup itself ---
      const record = await this.getRunRecordPersister().getByRunId(planRunId);
      if (!record) {
        throw new PulumiPlanRunNotFoundError(planRunId);
      }
      if (record.kind !== 'plan') {
        throw new PulumiPlanRunWrongKindError(planRunId, record.kind);
      }
      if (!record.approvedBy || !record.approvedAt) {
        throw new PulumiPlanNotApprovedError(planRunId);
      }
      if (isApprovalExpired(record.approvedAt)) {
        throw new PulumiApprovalExpiredError(planRunId, record.approvedAt);
      }
      if (!record.planHash || record.planHash !== planHash) {
        throw new PulumiPlanHashMismatchError(planRunId, record.planHash, planHash);
      }
      tfvarsVersionId = record.tfvarsVersionId;
      engineVersion = record.engineVersion;

      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 6: re-verify against reality — see TSDoc for the 6a/6b split ---
      const bucket = this.getConfigurationBucket();
      if (!bucket) {
        throw new Error(
          'Cannot apply pulumi plan: no configuration bucket is configured. Finish the setup wizard before applying.',
        );
      }
      const key = CONFIGURATION_OBJECT_KEY;
      const versions = await this.getRemoteFileStore().listVersions(key);
      const currentConfigVersionId = versions[0]?.versionId;

      if (tfvarsVersionId !== undefined && currentConfigVersionId !== tfvarsVersionId) {
        throw new StalePlanError(key, bucket, tfvarsVersionId, currentConfigVersionId);
      }

      const artifactPath = join(this.getRunsDir(), planRunId, `${planRunId}.plan.json`);
      let recomputedHash: string;
      try {
        recomputedHash = this.computePlanHash(artifactPath, currentConfigVersionId ?? '');
      } catch (err) {
        throw new PulumiPlanArtifactStaleError(planRunId, artifactPath, err);
      }
      if (recomputedHash !== record.planHash) {
        throw new PulumiPlanArtifactStaleError(planRunId, artifactPath);
      }

      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 7: engine version ---
      await this.engine.resolve();
      const currentEngineVersion = this.engine.getResolvedVersion();
      if (!currentEngineVersion || engineVersion !== currentEngineVersion) {
        throw new PulumiEngineVersionMismatchError(planRunId, engineVersion, currentEngineVersion ?? undefined);
      }

      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 8: the atomic, authoritative reservation ---
      // No "is the workspace free" pre-check precedes this call — see this
      // method's TSDoc for why that would reintroduce a TOCTOU race. A
      // losing race rejects with RunLockHeldError, propagated unwrapped.
      const initiator = PulumiService.resolveInitiator();
      await this.getRunLockService().createRun('apply', initiator, planRunId);

      // Re-check the shared local-workspace guard now that this call has
      // crossed the only genuinely async gap since the top-of-function
      // check — mirrors `TerraformController.apply`'s identical
      // post-`createRun` recheck. Closes the apply-vs-`preview`/`destroy`
      // race: `preview`/`destroy` never touch `RunLockService`, so only this
      // in-process flag can order them against an apply that already won the
      // durable lock. Apply-vs-apply is never decided here — that race is
      // already resolved by `createRun`'s own atomicity above; this check can
      // only ever observe `'preview'`/`'destroy'`, never `'up'` from a
      // sibling apply, since `RunService`'s lock is a single global slot.
      if (this.operationInFlight) {
        const inFlight = this.operationInFlight;
        // Release the durable lock this call just won — nothing has been
        // reserved from the operator's point of view yet (no run record, no
        // active-run buffer, no `startedAt`), so releasing here is the
        // correct undo of gate step 8, not a backstop for a later failure.
        // Wrapped in try/catch, consistent with the outer `finally`'s own
        // backstop `releaseRun` call: `RunService.releaseRun` is documented
        // to never throw, but a rejection here must not replace this
        // method's own descriptive refusal error with whatever `releaseRun`
        // itself rejected with.
        try {
          await this.getRunLockService().releaseRun(planRunId);
        } catch (err) {
          logger.warn('pulumi apply: failed to release the durable apply lock after the local-workspace re-check refused', {
            planRunId,
            inFlight,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw new Error(
          `pulumi apply refused: ${inFlight} is already in flight against the shared workspace; wait for it ` +
            'to finish before retrying. (The durable apply lock this call just acquired has been released.)',
        );
      }
      // Only THIS invocation may ever clear `operationInFlight` back to
      // `null` (see `ownsOperationInFlight`'s own doc comment) — set
      // together, synchronously, with no `await` between them and the
      // re-check above, so no concurrent `preview`/`destroy`/`apply` call
      // can observe a window where the recheck passed but the field is not
      // yet set.
      this.operationInFlight = 'up';
      ownsOperationInFlight = true;

      // Lock genuinely held from here on — this run owns planRunId. Nothing
      // above this line has reserved anything.
      runId = planRunId;
      this.beginActiveRun(runId);
      // Captured here (immediately after the lock is acquired), NOT right
      // before `stack.up()` the way `preview()` captures its own
      // `startedAt` right before `stack.preview()` — unlike `preview()`,
      // ANY failure from this point on (config read, workspace construction,
      // or the update itself) must still produce a persisted run record to
      // release the just-acquired lock (see the comment below), so
      // `startedAt` must already be set before any of that fallible work
      // begins, not only once `stack.up()` is actually about to be called.
      startedAt = new Date().toISOString();

      // Everything from here through `operationPromise` settling is wrapped
      // in one try/catch so ANY failure after the lock is acquired —
      // reading the configuration, constructing the workspace, or the
      // update itself — still flows through the SAME persistence path
      // below (which is what actually releases the just-acquired lock, via
      // RunRecordService.persist's own finally). Letting a config-read
      // failure propagate raw here would leak the lock for the full
      // DEFAULT_LOCK_TTL_MS TTL instead of releasing it immediately.
      // Unlike `preview()`, the resolved `UpResult` itself is never read —
      // `capturedChangeSummary` (this method's own `onEvent` capture, below)
      // is used directly for the returned result on every path, INCLUDING
      // the normal-completion path, so the leaked-promise-recovery path and
      // the normal path can never disagree about where `changeSummary` came
      // from (mirrors `preview()`'s design intent — see that method's TSDoc
      // "Structured changeSummary" — applied slightly differently here since
      // `UpResult.summary.resourceChanges` is optional and its exact
      // population semantics from the CLI were not independently verified,
      // unlike `PreviewResult.changeSummary`).
      // `completedSteps`/`capturedChangeSummary` themselves are hoisted
      // above the outer `try` (see there for why) — only `upError` is local
      // to this inner try/catch.
      let upError: unknown;

      try {
        const obj = await this.getRemoteFileStore().get(key);
        if (!obj) {
          throw new Error(`Configuration object "${key}" not found in S3 bucket "${bucket}".`);
        }
        const deploymentConfig = JSON.parse(new TextDecoder().decode(obj.body)) as DeploymentConfig;

        const stateBucket = this.store.get('bootstrap')?.stateBucket;
        const stateBucketRegion = this.store.get('aws')?.region;
        if (!stateBucket || !stateBucketRegion) {
          throw new Error(
            'Cannot run pulumi apply: the state bucket / AWS region has not been configured yet. ' +
              'Complete the bootstrap step before applying.',
          );
        }
        // Mirrors preview()'s identical "an existing stack" proxy.
        const stackExists = this.store.get('pulumi')?.passphrase !== undefined;

        const stack = await this.workspace.getOrCreateStack({
          program: createInfraProgram(deploymentConfig, { lambdaBundlesDir: this.getLambdaBundlesDir() }),
          stateBucket,
          stateBucketRegion,
          backendReady: true,
          stackExists,
        });

        // --- Chunk-streaming setup — identical algorithm to preview() (see that method's TSDoc) ---
        const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
        const queue: PulumiRunChunk[] = [];
        let wake: (() => void) | null = null;
        const notify = (): void => {
          wake?.();
          wake = null;
        };
        const push = (chunk: PulumiRunChunk): void => {
          queue.push(chunk);
          notify();
        };
        const handleData = (stream: 'stdout' | 'stderr', data: string): void => {
          buffers[stream] += data;
          const lines = buffers[stream].split(/\r?\n/);
          buffers[stream] = lines.pop() ?? '';
          for (const line of lines) {
            push({ stream, line });
          }
        };
        const onOutput = (out: string): void => handleData('stdout', out);
        const onError = (err: string): void => handleData('stderr', err);
        const onEvent = (event: EngineEvent): void => {
          if (event.summaryEvent) {
            capturedChangeSummary = event.summaryEvent.resourceChanges;
          }
          if (event.resOutputsEvent && MUTATING_OP_TYPES.has(event.resOutputsEvent.metadata.op)) {
            const { urn, type, op } = event.resOutputsEvent.metadata;
            completedSteps.push({ urn, type, op });
          }
        };

        // Lock-recovery wiring — recorded immediately before the call that
        // can actually take the DIY backend lock, never earlier. See TSDoc
        // "Lock-recovery wiring" / "Force-close safety net" sections.
        lockAttemptId = this.store.recordPulumiLockAttempt(PULUMI_STACK_NAME);

        const attemptUp = async (innerSignal: AbortSignal): Promise<UpResult> => {
          try {
            return await stack.up({ plan: artifactPath, onOutput, onError, onEvent, signal: innerSignal });
          } catch (err) {
            if (!isStackLockConflict(err)) {
              throw err;
            }
            const classification = classifyStackLockConflict(err, this.store, PULUMI_STACK_NAME);
            if (classification.kind === 'reclaimable-own-orphan') {
              logger.warn(
                'pulumi apply: backend lock is a provable orphan of this installation\'s own prior run — ' +
                  'clearing it via stack.cancel() and retrying the update once',
                { planRunId, runId, locks: classification.locks },
              );
              await stack.cancel();
              return await stack.up({ plan: artifactPath, onOutput, onError, onEvent, signal: innerSignal });
            }
            throw new PulumiUnrecognizedLockError(
              PULUMI_STACK_NAME,
              classification.kind === 'requires-confirmation' ? classification.locks : [],
            );
          }
        };

        const recoverResult = async (): Promise<UpResult> => {
          const [outputs, summary] = await Promise.all([stack.outputs(), stack.info()]);
          if (summary && summary.result !== 'succeeded') {
            logger.warn(
              'pulumi apply leaked-promise recovery: stack.info() does not report "succeeded" — trusting the ' +
                'SDK-verified leak-check proof anyway (see PulumiLeakedPromise.ts, "provably sufficient")',
              { planRunId, runId, result: summary.result },
            );
          }
          return {
            stdout: '',
            stderr: '',
            outputs,
            summary: summary ?? {
              kind: 'update',
              startTime: new Date(),
              endTime: new Date(),
              message: '',
              environment: {},
              config: {},
              result: 'succeeded',
              version: 0,
            },
          };
        };

        operationPromise = runWithEscalatingCancellation(
          (innerSignal) => runTreatingLeakedPromiseAsSuccess(() => attemptUp(innerSignal), recoverResult),
          internalController.signal,
        );

        const onOperationSettled = (): void => {
          for (const stream of ['stdout', 'stderr'] as const) {
            if (buffers[stream].length > 0) {
              push({ stream, line: buffers[stream] });
              buffers[stream] = '';
            }
          }
          operationSettled = true;
          notify();
        };
        operationPromise.then(onOperationSettled, onOperationSettled);

        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            logLines.push(chunk.line);
            this.recordRunChunk(runId, chunk);
            yield chunk;
            continue;
          }
          if (operationSettled) {
            break;
          }
          await new Promise<void>((resolveWait) => {
            wake = resolveWait;
          });
        }

        await operationPromise;
      } catch (err) {
        upError = err;
      }

      // Clear the lock-ownership record on every settlement EXCEPT a
      // forceful escalation — see TSDoc "Force-close safety net" for why an
      // escalated (possibly still-running) operation must leave its record
      // behind as reclaim evidence for a later run.
      if (lockAttemptId !== undefined && !(upError instanceof PulumiOperationEscalatedError)) {
        this.store.clearPulumiLockAttempt(lockAttemptId);
        lockAttemptId = undefined;
      }

      const wasAborted =
        upError instanceof PulumiOperationNotStartedError ||
        upError instanceof PulumiOperationAbortedError ||
        upError instanceof PulumiOperationEscalatedError;

      const outcome: PulumiApplyOutcome = wasAborted
        ? { kind: 'aborted' }
        : upError
          ? upError instanceof PulumiUnrecognizedLockError
            ? { kind: 'failed', error: upError, partialApply: false }
            : completedSteps.length > 0
              ? { kind: 'failed', error: new PulumiPartialApplyError(completedSteps, upError), partialApply: true }
              : { kind: 'failed', error: new PulumiUpError(upError), partialApply: false }
          : { kind: 'success', result: { runId, changeSummary: capturedChangeSummary } };

      runRecordWritten = true;
      this.writeRunLog(runId, logLines);
      this.endActiveRun(runId);

      const completedAt = new Date().toISOString();
      const exitCode = outcome.kind === 'aborted' ? null : outcome.kind === 'success' ? 0 : 1;
      const resultChangeSummary = outcome.kind === 'success' ? outcome.result.changeSummary : capturedChangeSummary;
      // Fix round 1: computed directly from `completedSteps`, independent of
      // `outcome.kind === 'failed'` specifically — the original formula only
      // ever consulted `outcome.partialApply` (itself only ever set on the
      // `'failed'` variant), so an ABORTED apply (the operator pressing
      // Cancel mid-`up()` — arguably the single most likely real-world way
      // this system ends up partway through) silently lost the signal
      // entirely. `outcome.kind === 'success'` is excluded deliberately, not
      // an oversight: a fully successful apply that created/updated real
      // resources also has `completedSteps.length > 0`, but that is
      // completion, not partial-ness — `PulumiRunRecord.partialApply`'s own
      // doc comment defines it only in terms of a failed/aborted engine
      // invocation, and marking every ordinary successful apply as "partial"
      // would defeat the whole distinction the spec's "re-plan, don't retry
      // blindly" requirement exists to carry.
      const resultPartialApply = outcome.kind !== 'success' && completedSteps.length > 0 ? true : undefined;

      try {
        this.writeRunRecord(
          runId,
          'apply',
          startedAt,
          completedAt,
          exitCode,
          tfvarsVersionId,
          record.planHash,
          undefined,
          resultChangeSummary,
          engineVersion,
          resultPartialApply,
        );
      } catch (err) {
        throw new PulumiRunPersistError(runId, PulumiService.toApplyOperationOutcome(outcome), err);
      }
      await this.persistRunRecord(
        runId,
        'apply',
        startedAt,
        completedAt,
        exitCode,
        tfvarsVersionId,
        record.planHash,
        undefined,
        resultChangeSummary,
        engineVersion,
        resultPartialApply,
      );
      // `persistRunRecord` (via `RunRecordService.persist`'s own `finally`)
      // has now attempted to release the durable apply lock — the outer
      // `finally`'s backstop below must not redundantly do it again on
      // every ordinary successful apply. See `lockReleased`'s own doc
      // comment for the liveness issue this avoids.
      lockReleased = true;

      if (outcome.kind === 'success') {
        // Cache invalidation — see TSDoc. Best-effort: never let this mask
        // an otherwise-successful apply.
        try {
          this.getConfigCacheInvalidator().invalidateCache();
        } catch (err) {
          logger.warn('pulumi apply: failed to invalidate the stack-outputs cache after a successful apply', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (outcome.kind === 'aborted') {
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Unconditionally detach the internal-controller abort listener —
      // `{ once: true }` alone only removes it once `signal` itself fires;
      // on the common path (the signal never aborts across a normal
      // completion), it would otherwise stay attached for the signal's whole
      // lifetime, so a caller reusing one long-lived `AbortSignal` across
      // many `apply()` calls would accumulate one listener per call.
      // Safe/idempotent to call even when the listener already detached
      // itself (a `{ once: true }` listener that already fired).
      signal?.removeEventListener('abort', onAbort);

      // Covers the force-closed generator case — see preview()'s identical
      // block for the full rationale; mirrored here verbatim except for the
      // added lock-attempt-clearing decision below.
      if (operationPromise && !operationSettled) {
        internalController.abort();
        let forceCloseSettlement: unknown;
        await operationPromise.then(
          () => {
            forceCloseSettlement = undefined;
          },
          (err: unknown) => {
            forceCloseSettlement = err;
          },
        );
        if (lockAttemptId !== undefined && !(forceCloseSettlement instanceof PulumiOperationEscalatedError)) {
          this.store.clearPulumiLockAttempt(lockAttemptId);
          lockAttemptId = undefined;
        }
      }

      if (runId !== undefined) {
        this.endActiveRun(runId);
      }
      if (runId !== undefined && startedAt !== undefined && !runRecordWritten) {
        logger.warn('pulumi apply cancelled — generator force-closed while running', { runId });
        this.writeRunLog(runId, logLines);
        const completedAt = new Date().toISOString();
        // Threads `capturedChangeSummary`/a `completedSteps`-derived
        // `partialApply` through this fallback write too (both hoisted above
        // the outer `try` for exactly this reason) — a force-closed apply
        // that had already applied a mutating resource step is just as much
        // a partial apply as one that settled through the normal path below.
        // `planHash` (the parameter, not `record.planHash` — `record` is
        // block-scoped to the gate above and unreachable here) is threaded
        // too since it costs nothing and completes the record.
        const forceCloseResultPartialApply = completedSteps.length > 0 ? true : undefined;
        try {
          this.writeRunRecord(
            runId,
            'apply',
            startedAt,
            completedAt,
            null,
            tfvarsVersionId,
            planHash,
            undefined,
            capturedChangeSummary,
            engineVersion,
            forceCloseResultPartialApply,
          );
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
        await this.persistRunRecord(
          runId,
          'apply',
          startedAt,
          completedAt,
          null,
          tfvarsVersionId,
          planHash,
          undefined,
          capturedChangeSummary,
          engineVersion,
          forceCloseResultPartialApply,
        );
        // See `lockReleased`'s own doc comment — this fallback's own
        // `persistRunRecord` call has now attempted the release too.
        lockReleased = true;
      }

      // Reset the local in-process mutex before the (rare, best-effort)
      // durable-lock backstop below, not after: the backstop's own `await`
      // (a real network round-trip through `RunService.releaseRun` →
      // `ConfigService.getStackOutputs()`) has no bearing on the shared
      // workspace directory this flag actually guards (nothing further
      // touches `workDir` after this point on any path), so a slow or
      // wedged backstop call should not also block a brand-new
      // `preview`/`apply`/`destroy` call on this instance from starting.
      // Gated on `ownsOperationInFlight` rather than unconditional — see
      // that variable's own doc comment for why an unconditional reset here
      // would risk nulling out a concurrently running, unrelated
      // `preview`/`destroy` call's own flag on a path where this `apply()`
      // call's gate failed before ever touching the field.
      if (ownsOperationInFlight) {
        this.operationInFlight = null;
      }

      // Skipped entirely once `lockReleased` is already `true` — the common
      // case, since every ordinary successful or cleanly-failed apply
      // already released the lock via `persistRunRecord` (or its
      // force-close-fallback equivalent) moments earlier. Firing this
      // unconditionally on every apply would be a regression:
      // `RunService.releaseRun` awaits `ConfigService.getStackOutputs()`,
      // and on the success path the `invalidateCache()` call above
      // guarantees that read misses its cache and re-invokes
      // `PulumiService.getStackOutputs()` — two more real `pulumi` CLI
      // subprocess spawns delaying the generator's final settlement on
      // every successful apply, for a release that already happened.
      // Reserved for the one path it's actually needed — `writeRunRecord`
      // itself throwing, which skips `persistRunRecord` on the normal
      // (non-force-closed) path entirely (`runRecordWritten` is set `true`
      // right before that call, so a throw there also skips this block's own
      // force-close fallback above, which is gated on `!runRecordWritten`) —
      // and would otherwise leak the durable lock for the full
      // `DEFAULT_LOCK_TTL_MS` (1 hour) with nothing in-app to clear it.
      // `TerraformController.apply`'s own streaming-loop `finally` has an
      // identical unconditional `RunService.releaseRun` backstop one layer
      // up; `apply` is self-contained per this task's ruling, so it inherits
      // that obligation itself rather than leaving it to a controller that
      // doesn't exist yet. Wrapped in try/catch (matching the re-check's own
      // `releaseRun` call above) even though `RunService.releaseRun` is
      // documented to never throw — defensive, since this method depends on
      // it only through the narrower `RunLockService` interface.
      if (runId !== undefined && !lockReleased) {
        try {
          await this.getRunLockService().releaseRun(runId);
        } catch (err) {
          logger.warn('pulumi apply: failed to release the durable apply lock as a backstop', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Mints a fresh, single-use confirmation token for a subsequent
   * {@link destroy} call, valid for {@link DESTROY_CONFIRMATION_TTL_MS},
   * bound to the current destroy target — see
   * {@link PulumiPendingDestroyConfirmation}'s doc comment for the
   * target-binding design. Intended to be called the moment the renderer
   * shows its destroy-confirmation modal, so the token's lifetime brackets
   * the window the operator actually has that modal open.
   *
   * Minting a new token immediately supersedes any previously minted (and not
   * yet consumed) token — only the most recently minted token is ever
   * accepted by {@link destroy}. A token is consumed (and can never be
   * reused) the moment a `destroy()` call validates it, whether or not that
   * run ultimately succeeds — a second destroy attempt requires minting a new
   * token.
   */
  mintDestroyConfirmationToken(): string {
    this.pendingDestroyConfirmation = {
      token: randomUUID(),
      expiresAt: Date.now() + DESTROY_CONFIRMATION_TTL_MS,
      stateBucket: this.store.get('bootstrap')?.stateBucket,
      stateBucketRegion: this.store.get('aws')?.region,
      stackName: PULUMI_STACK_NAME,
      projectName: PULUMI_PROJECT_NAME,
    };
    return this.pendingDestroyConfirmation.token;
  }

  /**
   * Runs `pulumi destroy` against the deployed stack, yielding a
   * {@link PulumiRunChunk} per line of stdout/stderr as the operation
   * produces it, and resolving to a {@link PulumiDestroyResult} once it
   * settles — `TerraformService.destroy`'s successor, gated behind the same
   * confirmation-token mechanism, now genuinely target-bound (see
   * {@link PulumiPendingDestroyConfirmation}'s doc comment).
   *
   * ## No plan-hash gate — the token is the gate
   *
   * Unlike {@link apply}, `destroy` has no preceding `preview()` plan to
   * validate against: no saved artifact, no `planHash`, no approval lineage.
   * The destroy path relies entirely on the confirmation-token gate for its
   * safety, with no plan artifact behind it — the token check is the
   * safety-critical step of this method, not one of several redundant checks.
   *
   * ## Gate structure — simpler than `apply`'s, and ordered differently
   *
   * `apply`'s 8-step gate exists because two independent things must be true
   * before `stack.up()` runs: the plan is still valid (idempotent reads, safe
   * to repeat) and no other run is allowed to start (the atomic reservation,
   * placed last). `destroy` has no plan to re-validate. What it has instead
   * is the confirmation token — a single-use credential, not an idempotent
   * read. The `orchestrator-integration-coverage` spec requires the loser of
   * a same-token race to observe {@link DestroyNotConfirmedError}
   * specifically, not `RunLockHeldError` or a generic "busy" refusal.
   *
   * Only one ordering constraint is actually forced by that requirement:
   * - **Forced**: the token must be consumed before
   *   {@link RunLockService.createRun} (step 4) — `createRun` is this
   *   method's first genuine `await` boundary, so reaching it before the
   *   token is consumed would let a same-token race be decided by
   *   `createRun`'s own atomicity instead, and the loser would observe
   *   `RunLockHeldError` instead of `DestroyNotConfirmedError`.
   * - **Not forced**: whether the synchronous config-presence checks (step
   *   2) run before or after the token. Both orderings are equally
   *   synchronous, so either decides a same-token race identically. They run
   *   before the token here so a call that was always going to fail an
   *   "is anything even deployed yet" check doesn't also burn the operator's
   *   single-use confirmation.
   *
   * 1. {@link operationInFlight} busy check — refuses immediately if
   *    `preview`/`up`/an already-running `destroy` is using the shared local
   *    workspace, before the token is ever read.
   * 2. Synchronous config-presence checks — state bucket/region configured,
   *    a stack has actually been created. Not forced to precede the token —
   *    a deliberate ordering choice, not a spec requirement.
   * 3. **The authoritative safety gate**, consumed here still synchronously:
   *    {@link assertFreshDestroyConfirmation}. Two calls sharing the same
   *    token are strictly ordered by JS's own run-to-completion semantics —
   *    whichever call's `.next()` executes first runs this whole step,
   *    including the token's synchronous clear, before the other begins. The
   *    loser observes the token already consumed and throws
   *    {@link DestroyNotConfirmedError}, decided without ever touching
   *    `RunLockService`; nothing has been reserved yet, so the rejection is a
   *    clean, zero-side-effect unwind.
   * 4. **Then, and only then** (this ordering is forced):
   *    `RunLockService.createRun()` (`'destroy'`, the resolved initiator,
   *    this run's `runId`) — the same atomic compare-and-set `apply`'s gate
   *    uses. A losing race rejects with `RunLockHeldError`, propagated
   *    unwrapped, exactly like `apply`.
   * 5. The same post-`createRun` {@link operationInFlight} TOCTOU re-check
   *    `apply` performs — on a loss, the just-acquired durable lock is
   *    released and the call refused, mirroring `apply`'s branch exactly.
   * 6. **Commit**: `operationInFlight = 'destroy'`, `beginActiveRun(runId)`,
   *    `startedAt` captured. Nothing above this line has reserved anything
   *    that survives a refusal except the token itself (step 3 — spent
   *    regardless of what happens afterward; there is no "un-consume").
   *
   * **Residual trade-off**: step 4 can still lose its race to a different
   * process already holding the durable lock, so a destroy can spend its
   * token on a call that was always going to be refused with
   * `RunLockHeldError`. There's no synchronous way to know whether
   * `createRun` will win before calling it, so this case can't be moved
   * earlier the way the config checks were. Rare in this single-desktop-app
   * context, and burning a token here is the fail-safe outcome (forces
   * re-confirmation, never a silent no-op) — step 1 fully protects the
   * common conflict case (a second click or IPC submission while this
   * process's own destroy/apply/preview is running) without spending
   * anything, and step 2 protects the "nothing configured yet" case too.
   *
   * `operationInFlight` is, exactly like `apply`, only ever set once —
   * immediately after commit (step 6), never at the top-of-function check —
   * so setting it early wouldn't become the forbidden "preceding
   * workspace-is-free observation" that would stop two genuinely concurrent
   * calls from both reaching the atomic reservation.
   *
   * ## `stack.destroy()` takes the DIY backend lock (like `apply`)
   *
   * `diyBackend.Destroy` wraps its call in `Lock`/deferred `Unlock`,
   * identical to `diyBackend.Update` (`apply`'s path) — this method never
   * sets `DestroyOptions.previewOnly`, so it always takes that real path.
   * The same lock-recording, `ConcurrentUpdateError` classification, and
   * auto-reclaim-of-provable-own-orphan mechanism `apply` established
   * applies here unchanged, wired via the identical
   * `ElectronStoreService.recordPulumiLockAttempt`/`clearPulumiLockAttempt`/
   * `PulumiLockRecovery.classifyStackLockConflict` calls `apply` uses.
   *
   * ## No-op inline program
   *
   * Unlike `preview`/`apply`, this method passes a trivial
   * `async () => ({})` program to
   * {@link PulumiWorkspaceService.getOrCreateStack} — the same no-op
   * {@link getStackOutputs} already uses. A plain `pulumi destroy` (with
   * `DestroyOptions.runProgram` never set) does not run the program; it
   * deletes whatever the existing state checkpoint says exists, using each
   * resource's own provider. The inline program's only role in an
   * Automation API call is to stand up the gRPC language-server handshake
   * `LocalWorkspace.createOrSelectStack` requires, not to redescribe the
   * resources being destroyed. A no-op program also means this method never
   * reads the deployment configuration object from S3 — `destroy` can tear
   * down a stack even if the current configuration object is missing,
   * malformed, or describes a different layout than what's actually
   * deployed, which matters operationally: you must be able to destroy
   * broken infrastructure.
   *
   * ## `changeSummary`
   *
   * `DestroyResult` (`{ stdout, stderr, summary: UpdateSummary }`) is
   * structurally like `UpResult`, not `PreviewResult`'s flatter shape, and
   * `UpdateSummary.resourceChanges` is optional. This method handles it like
   * `apply` does, not `preview` — capturing `capturedChangeSummary` from
   * `onEvent`'s `summaryEvent` and using that value directly for the
   * returned result on every path, never reading
   * `DestroyResult.summary.resourceChanges`. This also means the
   * leaked-promise-recovery path and the normal-completion path can never
   * disagree about where `changeSummary` came from.
   *
   * ## No partial-destroy concept
   *
   * `DestroyResult` carries no partial/complete distinction beyond the
   * generic `summary.result` — nothing analogous to `apply`'s
   * `resOutputsEvent`-derived `completedSteps` tracking exists here.
   * {@link PulumiDestroyOutcome} is a plain three-way success/aborted/failed
   * union with no `partialApply`-style fourth signal, mirroring
   * {@link PulumiPreviewOutcome}'s shape rather than
   * {@link PulumiApplyOutcome}'s.
   *
   * ## Leaked-promise `recoverResult`
   *
   * Mirrors `apply`'s re-reading implementation, not `preview`'s
   * nothing-to-re-read one: `stack.info()` is re-read purely as a
   * sanity-check WARN log if its `result` isn't `'succeeded'`, without
   * gating or overriding the recovery. Unlike `apply`, `stack.outputs()` is
   * not re-read — {@link PulumiDestroyResult} carries no outputs, and a
   * destroyed stack's outputs read would itself race the very teardown this
   * recovery path exists to confirm succeeded.
   *
   * ## Cancellation, chunk streaming, force-close safety net
   *
   * All three mirror `apply`'s shapes: the named `onAbort` handler with
   * unconditional `removeEventListener` in the outer `finally`, the
   * `internalController`/`operationPromise`/`operationSettled` triple for a
   * force-closed generator's bounded abort-and-await, and the identical
   * queue/wake/notify chunk-streaming consumer loop. See {@link apply}'s
   * TSDoc for the full rationale of each.
   *
   * ## Cache invalidation
   *
   * On a successful destroy only, {@link getConfigCacheInvalidator}'s
   * `invalidateCache()` is called, best-effort, mirroring `apply`: a
   * destroyed stack's `getStackOutputs()` must stop reporting stale
   * "deployed" data immediately, not after the next unrelated cache expiry.
   *
   * ## Persistence
   *
   * `kind: 'destroy'`, same `writeRunLog`/`endActiveRun`/`writeRunRecord`/
   * `persistRunRecord` sequence `preview`/`apply` use. No `tfvarsVersionId`,
   * `planHash`, or `engineVersion` is recorded, since there is no
   * configuration version or plan artifact this run ran against (see "No-op
   * inline program" above). `persistRunRecord`'s own
   * `RunRecordService.persist` releases the durable lock step 3 acquired, in
   * its own `finally` — no separate `RunLockService.releaseRun` call is made
   * on that path; the outer `finally`'s `lockReleased`-gated backstop exists
   * for the one path that skips it (`writeRunRecord` itself throwing).
   *
   * @param confirmationToken - The token returned by a prior
   *   {@link mintDestroyConfirmationToken} call. See "Gate structure" above
   *   for exactly when this is validated relative to the durable lock.
   * @param signal - Optional cancellation signal — see "Cancellation, chunk
   *   streaming, force-close safety net" above.
   * @param preMintedRunId - Optional caller-minted `runId`; must match
   *   {@link RUN_ID_PATTERN}.
   * @throws {@link PulumiOperationInFlightError} if another `preview`/`up`/
   *   `destroy`/`rollback` is already in flight on this instance (the
   *   top-of-function busy check).
   * @throws A descriptive `Error` if `preMintedRunId` doesn't match
   *   {@link RUN_ID_PATTERN}, if the state bucket/region aren't configured, or
   *   if no stack has ever been created (no passphrase on record).
   * @throws `RunLockHeldError` (`@hyveon/shared`, unwrapped) if the durable
   *   lock reservation loses its atomic race.
   * @throws {@link DestroyNotConfirmedError} if `confirmationToken` is
   *   missing, unknown, expired, already consumed, or bound to a different
   *   target (see {@link PulumiPendingDestroyConfirmation}'s doc comment,
   *   "Target binding").
   * @throws {@link PulumiUnrecognizedLockError} if `stack.destroy()` hits a
   *   backend lock conflict that cannot be proven this installation's own
   *   orphan.
   * @throws {@link PulumiDestroyError} if `stack.destroy()` fails (not
   *   aborted, not a leaked-promise-recovered success).
   * @throws {@link PulumiRunPersistError} if the operation settled but the
   *   run record couldn't be persisted afterward.
   */
  async *destroy(
    confirmationToken: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult | undefined> {
    if (this.operationInFlight) {
      throw new PulumiOperationInFlightError(this.operationInFlight);
    }
    if (preMintedRunId !== undefined) {
      PulumiService.assertValidRunId(preMintedRunId);
    }

    // Hoisted for the same reason as preview()/apply()'s equivalents — a
    // force-closed generator unwinds straight to the outer finally, which
    // needs to see these.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // `true` only once THIS invocation has itself set operationInFlight
    // (post-commit, see "Gate structure" above) — mirrors apply()'s
    // identically-named, identically-reasoned flag.
    let ownsOperationInFlight = false;
    // `true` once a call that genuinely attempted to release the durable lock
    // has completed — mirrors apply()'s identically-named flag and its exact
    // rationale (avoid a redundant RunService.releaseRun round-trip on the
    // overwhelmingly common already-released-via-persistRunRecord path).
    let lockReleased = false;
    let capturedChangeSummary: ChangeSummary = {};
    // The id ElectronStoreService.recordPulumiLockAttempt returns — mirrors
    // apply()'s identically-named field and its exact clear/leave-behind
    // rules (see this method's TSDoc, "`stack.destroy()` takes the DIY
    // backend lock").
    let lockAttemptId: string | undefined;
    const logLines: string[] = [];

    // Same internal-controller pattern as preview()/apply() — see apply()'s
    // TSDoc for the full rationale, including the named-`onAbort`-with-
    // unconditional-removal handling.
    const internalController = new AbortController();
    const onAbort = (): void => internalController.abort();
    if (signal) {
      if (signal.aborted) {
        internalController.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let operationPromise: Promise<DestroyResult> | undefined;
    let operationSettled = false;

    try {
      // Single abort check for this method's whole synchronous prologue
      // (gate steps 2-3 below — the config-presence checks and the token
      // consumption) — nothing yields between here and the createRun()
      // `await` further down, so a second check partway through that
      // prologue could never observe a state change (nothing else runs on
      // this thread in between) and would be dead code — deliberately not
      // duplicated here, unlike preview()/apply(), where each such check
      // sits after a genuine `await` and is therefore live.
      if (internalController.signal.aborted) {
        return undefined;
      }

      // --- Gate step 2: pure, synchronous config-presence checks — state
      // bucket/region configured, a stack has actually been created. NOT
      // forced to precede the token by the governing spec (unlike gate step
      // 4's ordering relative to step 3, below) — placed here as a
      // deliberate choice so a call that was always going to fail an
      // ordinary "is anything even deployed yet" check doesn't also burn
      // the operator's single-use confirmation token. See this method's
      // TSDoc, "Gate structure", for the full forced-vs-chosen breakdown. ---
      const stateBucket = this.store.get('bootstrap')?.stateBucket;
      const stateBucketRegion = this.store.get('aws')?.region;
      if (!stateBucket || !stateBucketRegion) {
        throw new Error(
          'Cannot run pulumi destroy: the state bucket / AWS region has not been configured yet. ' +
            'Complete the bootstrap step before destroying.',
        );
      }
      const stackExists = this.store.get('pulumi')?.passphrase !== undefined;
      if (!stackExists) {
        throw new Error(
          'Cannot run pulumi destroy: no Pulumi stack has ever been created for this installation ' +
            '(no secrets passphrase on record) — nothing to destroy.',
        );
      }

      // --- Gate step 3: THE authoritative safety gate — still fully
      // synchronous, still with nothing async above it (step 2 above is
      // also synchronous, so this property holds regardless of their
      // relative order), so token consumption remains atomic for two calls
      // racing on the SAME token: JS's own run-to-completion semantics mean
      // whichever call's `.next()` runs first executes this whole line
      // (and the synchronous clear inside assertFreshDestroyConfirmation)
      // to completion before the other call's `.next()` is even invoked.
      // THIS is the check that is genuinely forced to precede gate step 4
      // (createRun) — see this method's TSDoc, "Gate structure". ---
      this.assertFreshDestroyConfirmation(confirmationToken, stateBucket, stateBucketRegion);

      // --- Gate step 4: THE atomic, authoritative durable-lock reservation
      // (mirrors apply()'s gate step 8 exactly) — this is the ordering
      // constraint gate step 3 above is genuinely forced to precede. ---
      const initiator = PulumiService.resolveInitiator();
      const reservedRunId = preMintedRunId ?? randomUUID();
      await this.getRunLockService().createRun('destroy', initiator, reservedRunId);

      if (internalController.signal.aborted) {
        // Aborted while acquiring the durable lock — nothing else was ever
        // reserved (operationInFlight untouched, no active-run buffer), so
        // releasing the lock is the entire undo.
        try {
          await this.getRunLockService().releaseRun(reservedRunId);
        } catch (err) {
          logger.warn('pulumi destroy: failed to release the durable lock after an early abort', {
            reservedRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return undefined;
      }

      // --- Gate step 5: the SAME post-createRun operationInFlight TOCTOU
      // re-check apply() performs — see this method's TSDoc, "Gate structure". ---
      if (this.operationInFlight) {
        const inFlight = this.operationInFlight;
        try {
          await this.getRunLockService().releaseRun(reservedRunId);
        } catch (err) {
          logger.warn(
            'pulumi destroy: failed to release the durable lock after the local-workspace re-check refused',
            {
              reservedRunId,
              inFlight,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        throw new Error(
          `pulumi destroy refused: ${inFlight} is already in flight against the shared workspace; wait for it ` +
            'to finish before retrying. (The durable lock this call just acquired has been released.)',
        );
      }

      // --- Gate step 6: commit. Nothing above this line has left anything
      // reserved that survives a refusal (see "Gate structure" above): the
      // token is the only non-idempotent thing consumed before this point,
      // and it is spec-mandated to be spent regardless of what happens
      // afterward — there is no "un-consume" for a refusal that follows it. ---
      this.operationInFlight = 'destroy';
      ownsOperationInFlight = true;
      runId = reservedRunId;
      this.beginActiveRun(runId);
      startedAt = new Date().toISOString();

      let destroyError: unknown;
      try {
        const stack = await this.workspace.getOrCreateStack({
          // See this method's TSDoc, "No-op inline program", for why destroy
          // never reads the deployment configuration object at all.
          program: async () => ({}),
          stateBucket,
          stateBucketRegion,
          backendReady: true,
          stackExists: true,
        });

        // --- Chunk-streaming setup — identical algorithm to preview()/apply() ---
        const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
        const queue: PulumiRunChunk[] = [];
        let wake: (() => void) | null = null;
        const notify = (): void => {
          wake?.();
          wake = null;
        };
        const push = (chunk: PulumiRunChunk): void => {
          queue.push(chunk);
          notify();
        };
        const handleData = (stream: 'stdout' | 'stderr', data: string): void => {
          buffers[stream] += data;
          const lines = buffers[stream].split(/\r?\n/);
          buffers[stream] = lines.pop() ?? '';
          for (const line of lines) {
            push({ stream, line });
          }
        };
        const onOutput = (out: string): void => handleData('stdout', out);
        const onError = (err: string): void => handleData('stderr', err);
        const onEvent = (event: EngineEvent): void => {
          if (event.summaryEvent) {
            // See this method's TSDoc, "changeSummary", for why this is
            // handled like apply(), not preview().
            capturedChangeSummary = event.summaryEvent.resourceChanges;
          }
        };

        // Lock-recovery wiring — the identical mechanism apply() established,
        // reused verbatim; see this method's TSDoc, "`stack.destroy()` takes
        // the DIY backend lock".
        lockAttemptId = this.store.recordPulumiLockAttempt(PULUMI_STACK_NAME);

        const attemptDestroy = async (innerSignal: AbortSignal): Promise<DestroyResult> => {
          try {
            return await stack.destroy({ onOutput, onError, onEvent, signal: innerSignal });
          } catch (err) {
            if (!isStackLockConflict(err)) {
              throw err;
            }
            const classification = classifyStackLockConflict(err, this.store, PULUMI_STACK_NAME);
            if (classification.kind === 'reclaimable-own-orphan') {
              logger.warn(
                'pulumi destroy: backend lock is a provable orphan of this installation\'s own prior run — ' +
                  'clearing it via stack.cancel() and retrying the destroy once',
                { runId, locks: classification.locks },
              );
              await stack.cancel();
              return await stack.destroy({ onOutput, onError, onEvent, signal: innerSignal });
            }
            throw new PulumiUnrecognizedLockError(
              PULUMI_STACK_NAME,
              classification.kind === 'requires-confirmation' ? classification.locks : [],
            );
          }
        };

        const recoverResult = async (): Promise<DestroyResult> => {
          const summary = await stack.info();
          if (summary && summary.result !== 'succeeded') {
            logger.warn(
              'pulumi destroy leaked-promise recovery: stack.info() does not report "succeeded" — trusting the ' +
                'SDK-verified leak-check proof anyway (see PulumiLeakedPromise.ts, "provably sufficient")',
              { runId, result: summary.result },
            );
          }
          return {
            stdout: '',
            stderr: '',
            summary: summary ?? {
              kind: 'destroy',
              startTime: new Date(),
              endTime: new Date(),
              message: '',
              environment: {},
              config: {},
              result: 'succeeded',
              version: 0,
            },
          };
        };

        operationPromise = runWithEscalatingCancellation(
          (innerSignal) => runTreatingLeakedPromiseAsSuccess(() => attemptDestroy(innerSignal), recoverResult),
          internalController.signal,
        );

        const onOperationSettled = (): void => {
          for (const stream of ['stdout', 'stderr'] as const) {
            if (buffers[stream].length > 0) {
              push({ stream, line: buffers[stream] });
              buffers[stream] = '';
            }
          }
          operationSettled = true;
          notify();
        };
        operationPromise.then(onOperationSettled, onOperationSettled);

        while (true) {
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            logLines.push(chunk.line);
            this.recordRunChunk(runId, chunk);
            yield chunk;
            continue;
          }
          if (operationSettled) {
            break;
          }
          await new Promise<void>((resolveWait) => {
            wake = resolveWait;
          });
        }

        await operationPromise;
      } catch (err) {
        destroyError = err;
      }

      // Clear the lock-ownership record on every settlement EXCEPT a forceful
      // escalation — mirrors apply()'s identical rationale ("Force-close
      // safety net").
      if (lockAttemptId !== undefined && !(destroyError instanceof PulumiOperationEscalatedError)) {
        this.store.clearPulumiLockAttempt(lockAttemptId);
        lockAttemptId = undefined;
      }

      const wasAborted =
        destroyError instanceof PulumiOperationNotStartedError ||
        destroyError instanceof PulumiOperationAbortedError ||
        destroyError instanceof PulumiOperationEscalatedError;

      const outcome: PulumiDestroyOutcome = wasAborted
        ? { kind: 'aborted' }
        : destroyError
          ? {
              kind: 'failed',
              error:
                destroyError instanceof PulumiUnrecognizedLockError
                  ? destroyError
                  : new PulumiDestroyError(destroyError),
            }
          : { kind: 'success', result: { runId, changeSummary: capturedChangeSummary } };

      runRecordWritten = true;
      this.writeRunLog(runId, logLines);
      this.endActiveRun(runId);

      const completedAt = new Date().toISOString();
      const exitCode = outcome.kind === 'aborted' ? null : outcome.kind === 'success' ? 0 : 1;
      const resultChangeSummary = outcome.kind === 'success' ? outcome.result.changeSummary : capturedChangeSummary;

      try {
        this.writeRunRecord(
          runId,
          'destroy',
          startedAt,
          completedAt,
          exitCode,
          undefined,
          undefined,
          undefined,
          resultChangeSummary,
        );
      } catch (err) {
        throw new PulumiRunPersistError(runId, PulumiService.toDestroyOperationOutcome(outcome), err);
      }
      await this.persistRunRecord(
        runId,
        'destroy',
        startedAt,
        completedAt,
        exitCode,
        undefined,
        undefined,
        undefined,
        resultChangeSummary,
      );
      // See lockReleased's own doc comment — persistRunRecord's own
      // RunRecordService.persist has now attempted the release too.
      lockReleased = true;

      if (outcome.kind === 'success') {
        // Cache invalidation — hard requirement carried forward from task
        // 7.4's review (see this method's TSDoc, "Cache invalidation").
        try {
          this.getConfigCacheInvalidator().invalidateCache();
        } catch (err) {
          logger.warn('pulumi destroy: failed to invalidate the stack-outputs cache after a successful destroy', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (outcome.kind === 'aborted') {
        return undefined;
      }
      if (outcome.kind === 'success') {
        return outcome.result;
      }
      throw outcome.error;
    } finally {
      // Fix round 1's leak fix, copied already-fixed — see apply()'s TSDoc.
      signal?.removeEventListener('abort', onAbort);

      // Covers the force-closed generator case — see apply()'s identical
      // block for the full rationale; mirrored here verbatim except for the
      // Pulumi-operation-specific types.
      if (operationPromise && !operationSettled) {
        internalController.abort();
        let forceCloseSettlement: unknown;
        await operationPromise.then(
          () => {
            forceCloseSettlement = undefined;
          },
          (err: unknown) => {
            forceCloseSettlement = err;
          },
        );
        if (lockAttemptId !== undefined && !(forceCloseSettlement instanceof PulumiOperationEscalatedError)) {
          this.store.clearPulumiLockAttempt(lockAttemptId);
          lockAttemptId = undefined;
        }
      }

      if (runId !== undefined) {
        this.endActiveRun(runId);
      }
      if (runId !== undefined && startedAt !== undefined && !runRecordWritten) {
        logger.warn('pulumi destroy cancelled — generator force-closed while running', { runId });
        this.writeRunLog(runId, logLines);
        const completedAt = new Date().toISOString();
        try {
          this.writeRunRecord(
            runId,
            'destroy',
            startedAt,
            completedAt,
            null,
            undefined,
            undefined,
            undefined,
            capturedChangeSummary,
          );
        } catch {
          // Nothing meaningful to do with a persistence failure while the
          // generator is already tearing down for an unrelated reason.
        }
        await this.persistRunRecord(
          runId,
          'destroy',
          startedAt,
          completedAt,
          null,
          undefined,
          undefined,
          undefined,
          capturedChangeSummary,
        );
        // See lockReleased's own doc comment — this fallback's own
        // persistRunRecord call has now attempted the release too.
        lockReleased = true;
      }

      // Reset the local in-process mutex before the (rare, best-effort)
      // durable-lock backstop below — mirrors apply()'s identical ordering
      // and rationale.
      if (ownsOperationInFlight) {
        this.operationInFlight = null;
      }

      // Fix round 2's backstop, mirrored verbatim — skipped entirely once
      // lockReleased is already true (the overwhelmingly common case); see
      // apply()'s TSDoc for the full rationale of why this exists at all
      // (the one path that skips persistRunRecord entirely: writeRunRecord
      // itself throwing).
      if (runId !== undefined && !lockReleased) {
        try {
          await this.getRunLockService().releaseRun(runId);
        } catch (err) {
          logger.warn('pulumi destroy: failed to release the durable lock as a backstop', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Resolves the configuration-object version that was live immediately
   * before the given `apply` run — the target {@link confirmRollback} would
   * restore. Read-only: performs no write. Ported from
   * `TerraformService.ts`'s `resolveRollbackTarget`, renaming
   * `RollbackNoTfvarsVersionError` to {@link RollbackNoConfigVersionError}.
   * Safe to call twice for the same `applyRunId`: once to preview the
   * rollback target for an operator's confirmation dialog, and again,
   * immediately before the actual restore write, inside
   * {@link confirmRollback} — so a version that expires in the window
   * between the two calls is still caught before anything is written.
   *
   * Looks up `applyRunId` via {@link getRunRecordPersister}, validates it's
   * an `apply` run with a recorded `tfvarsVersionId`, then walks the
   * complete `listVersions` history for the configuration object: since
   * {@link RemoteFileStore.listVersions} returns versions newest-first, the
   * version "live before" the apply run is the entry immediately *after*
   * the apply's own `tfvarsVersionId` in that array (one step further back
   * in time).
   *
   * @param applyRunId - The `runId` of the `apply` run to resolve a rollback target for.
   * @throws {@link RollbackTargetNotFoundError} when no run record exists for `applyRunId`.
   * @throws {@link RollbackNotApplyRunError} when the record isn't an `apply` run.
   * @throws {@link RollbackNoConfigVersionError} when the apply run has no recorded configuration version id.
   * @throws {@link RollbackVersionMissingError} when no earlier configuration version exists in the version history.
   */
  async resolveRollbackTarget(applyRunId: string): Promise<{ versionId: string; lastModified: Date }> {
    const record = await this.getRunRecordPersister().getByRunId(applyRunId);
    if (!record) {
      throw new RollbackTargetNotFoundError(applyRunId);
    }
    if (record.kind !== 'apply') {
      throw new RollbackNotApplyRunError(applyRunId, record.kind);
    }
    if (!record.tfvarsVersionId) {
      throw new RollbackNoConfigVersionError(applyRunId);
    }

    const key = CONFIGURATION_OBJECT_KEY;
    const versions = await this.getRemoteFileStore().listVersions(key);
    const index = versions.findIndex((v) => v.versionId === record.tfvarsVersionId);
    const prior = index === -1 ? undefined : versions[index + 1];
    if (!prior) {
      throw new RollbackVersionMissingError(record.tfvarsVersionId);
    }
    return prior;
  }

  /**
   * Confirms a rollback of `applyRunId`: re-resolves the rollback target
   * (catching a late expiry before any write), restores its exact historic
   * bytes as the configuration object's new head version, then runs a plan
   * against that restored version — tagged `rolledBackFrom: applyRunId` —
   * reusing {@link previewCore} directly rather than duplicating its logic.
   * Replaces `TerraformService.ts`'s `confirmRollback`, which only did the
   * restore write and left starting the follow-up plan to its caller as a
   * separate, unguarded step.
   *
   * ## The old `TerraformService` gap this closes
   *
   * `TerraformService.confirmRollback` wrote the restore and returned,
   * trusting the caller to invoke `plan()` next, with no lock held across
   * those two calls — a `destroy()` (or a second, racing rollback) could
   * interleave between them, and if the caller's follow-up `plan()` call
   * simply never happened, the restored configuration was left as the head
   * with no plan describing it, silently. This method closes that gap:
   * restore and plan-record persistence both happen inside a single
   * `try`/`finally` that owns {@link operationInFlight} for its entire
   * duration, so no other operation can interleave between the two.
   *
   * ## Lock acquisition
   *
   * {@link operationInFlight} is set to `'rollback'` — distinct from
   * `'preview'` — before {@link resolveRollbackTarget} is even re-invoked,
   * before any work this method does, not merely before the restore write.
   * Holding the lock across the re-resolve too closes a race a
   * write-only-guarded lock wouldn't: a concurrent `preview`/`up`/`destroy`
   * starting between the re-resolve and the write could otherwise still
   * change the configuration object's head in that window. The lock is
   * released in this method's own `finally`, covering every exit path —
   * mirroring `apply`/`destroy`'s lock-releasing `finally` discipline.
   *
   * This method never calls `RunLockService.createRun()` — the durable,
   * cross-process lock `apply`/`destroy` take. Neither does the
   * {@link previewCore} call this method delegates into (`preview` never
   * takes the DIY backend lock). The shared operation lock here is this
   * file's existing in-process {@link operationInFlight} guard, not the
   * durable one — consistent with every other plan-shaped operation in this
   * class.
   *
   * ## Why `previewCore`, not `preview()`
   *
   * `preview()` itself checks and sets {@link operationInFlight} — calling
   * it here would either throw immediately (seeing the `'rollback'` state
   * this method already set) or race this method's own clear of the field
   * in its `finally`. {@link previewCore} is `preview()`'s method body with
   * that concern removed entirely, letting this method reuse the identical
   * streaming/hashing/persistence/cancellation logic while keeping sole
   * ownership of the lock for the combined restore+plan unit.
   *
   * ## Compensating semantics: record-and-surface, not restore-previous-head
   *
   * Once {@link TfvarsRestorer.restoreRawTfvars} has resolved successfully,
   * anything that fails afterward — a missing `versionId` in its result, or
   * {@link previewCore} itself throwing — is caught by the inner
   * `try`/`catch` below and handled by:
   *
   * 1. `ElectronStoreService.recordOrphanedRollback` — a durable marker
   *    (survives an app restart) naming `applyRunId`, the now-orphaned
   *    `restoredVersionId`, and the underlying failure, so a future
   *    controller/UI can discover and present it even if the operator closed
   *    the app before seeing this call's own error.
   * 2. Throwing {@link PulumiRollbackPlanFailedError} — surfacing the same
   *    failure synchronously to whatever is driving this generator, so a
   *    caller doesn't have to separately poll the store to learn the
   *    rollback didn't fully complete.
   *
   * Restoring the previous head as a second corrective write was rejected as
   * the alternative: that write can also fail, compounding the problem into
   * a state that's not just orphaned but has an unverified "undo" attempt
   * layered on top. Record-and-surface never risks a second failure — it
   * only writes a plain-object marker to a local file and throws, both
   * effectively infallible compared to a second remote write. There is no
   * controller/renderer wiring yet, so "surfaces it to the operator"
   * concretely means the durable store marker plus the thrown, richly-typed
   * error — no polling mechanism, IPC channel, or auto-retry beyond that.
   *
   * Failures before `restoreRawTfvars` resolves (a stale/missing rollback
   * target, a missing historic version, or `restoreRawTfvars` itself
   * throwing) are not treated as compensating-semantics cases — nothing was
   * written, so the current head is untouched and the pre-existing typed
   * errors ({@link RollbackTargetNotFoundError} etc.) propagate unwrapped,
   * like {@link resolveRollbackTarget}'s own contract.
   *
   * ## Return shape: a generator, mirroring `preview()`
   *
   * `confirmRollback`'s effect — restore, then start a plan against the
   * restored version — produces a plan run that streams output exactly like
   * an ordinary `preview()` call. Returning the same `AsyncGenerator` shape
   * `preview()` returns (rather than a `Promise` that drives a preview to
   * completion internally and discards the stream) lets a caller watch that
   * queued plan's output directly, the same way it would for a plan started
   * via `preview()`.
   *
   * @param applyRunId - The `runId` of the `apply` run to roll back.
   * @param signal - Optional cancellation signal, forwarded to
   *   {@link previewCore} — see `preview()`'s own "Cancellation" doc section.
   * @param preMintedRunId - Optional caller-minted `runId` for the resulting
   *   plan run (mirrors `preview()`'s identically-named parameter) — must
   *   match {@link RUN_ID_PATTERN}, validated here before this method
   *   touches {@link operationInFlight}, mirroring `preview()`/`apply()`/
   *   `destroy()`'s identical top-of-function pattern.
   * @throws A descriptive `Error` if another `preview`/`up`/`destroy`/
   *   rollback is already in flight on this instance, or if `preMintedRunId`
   *   doesn't match {@link RUN_ID_PATTERN}.
   * @throws Same as {@link resolveRollbackTarget} — thrown before any write.
   * @throws {@link RollbackVersionMissingError} (reused) if the resolved
   *   version's bytes can no longer be read — the write never happens in
   *   that case either.
   * @throws {@link PulumiRollbackPlanFailedError} if the restore succeeded
   *   but the follow-up plan could not be completed — see "Compensating
   *   semantics" above.
   */
  async *confirmRollback(
    applyRunId: string,
    signal?: AbortSignal,
    preMintedRunId?: string,
  ): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    if (this.operationInFlight) {
      throw new Error(
        `PulumiService.confirmRollback() cannot run while ${this.operationInFlight}() is already ` +
          'running; wait for it to finish before calling confirmRollback() again.',
      );
    }
    if (preMintedRunId !== undefined) {
      PulumiService.assertValidRunId(preMintedRunId);
    }
    this.operationInFlight = 'rollback';
    try {
      // Re-resolved here (not trusting a caller-cached result from an
      // earlier confirmation-dialog call to resolveRollbackTarget) so a
      // version that expired in the window between the two calls is still
      // caught before anything is written — see this method's TSDoc,
      // "Lock acquisition", for why this happens AFTER the lock is already
      // held rather than before.
      const target = await this.resolveRollbackTarget(applyRunId);
      const key = CONFIGURATION_OBJECT_KEY;
      const historic = await this.getRemoteFileStore().getVersion(key, target.versionId);
      if (!historic) {
        throw new RollbackVersionMissingError(target.versionId);
      }
      const rawConfig = new TextDecoder().decode(historic.body);

      // The restore write itself. Nothing above this line needs
      // compensating semantics on failure — the head is still whatever it
      // was before this call started. Everything below, once this resolves,
      // is inside the compensating-semantics boundary — see this method's
      // TSDoc, "Compensating semantics".
      const restored = await this.getTfvarsService().restoreRawTfvars(rawConfig);

      try {
        if (!restored.versionId) {
          throw new Error(
            'PulumiService.confirmRollback: TfvarsService.restoreRawTfvars did not return a versionId — ' +
              'is the configuration bucket versioned?',
          );
        }
        // Delegates into preview()'s core body directly — see this method's
        // TSDoc, "Why previewCore, not preview()". Passing `restored.versionId`
        // as the expected configVersionId means previewCore's own staleness
        // check doubles as this method's own guard against the head having
        // somehow changed out from under the lock this method is holding.
        return yield* this.previewCore(restored.versionId, signal, preMintedRunId, applyRunId);
      } catch (err) {
        const restoredVersionId = restored.versionId ?? target.versionId;
        this.store.recordOrphanedRollback({
          applyRunId,
          restoredVersionId,
          failedAt: new Date().toISOString(),
          failureMessage: err instanceof Error ? err.message : String(err),
        });
        throw new PulumiRollbackPlanFailedError(applyRunId, restoredVersionId, err);
      }
    } finally {
      this.operationInFlight = null;
    }
  }

  /**
   * Throws {@link DestroyNotConfirmedError} unless `token` matches the most
   * recently minted, not-yet-expired, not-yet-consumed confirmation token AND
   * `currentStateBucket`/`currentStateBucketRegion` match the target the
   * token was minted against — see {@link PulumiPendingDestroyConfirmation}'s
   * doc comment for the full target-binding design. On success, consumes the
   * token (clears {@link pendingDestroyConfirmation}) so it can never be
   * replayed against a second `destroy()` call. Mirrors
   * `TerraformService.assertFreshDestroyConfirmation`'s token/expiry checks
   * exactly, extended with the target-binding comparison that method never
   * had.
   *
   * Fully synchronous — no `await` anywhere in this method — which is what
   * makes token consumption atomic: two "concurrent" calls (interleaved via
   * Promise scheduling, never truly parallel) that both reach this method
   * are strictly ordered by JS's own run-to-completion semantics, exactly
   * like `RunService.createRun`'s in-memory compare-and-set. Whichever
   * call's synchronous body runs first observes
   * {@link pendingDestroyConfirmation} as still set and clears it; the
   * second observes it already `null` (or superseded by a newer mint) and
   * throws.
   *
   * Does not clear {@link pendingDestroyConfirmation} on failure (wrong
   * token, expired, wrong target) — a genuinely correct, still-valid token
   * remains usable by a subsequent call even if an earlier call supplied a
   * wrong one first (e.g. a stale IPC retry racing a fresh one).
   *
   * Logs a `logger.warn` naming the specific rejection reason before
   * throwing on every failure branch — this gate is the only thing standing
   * between an accidental invocation and destroying all managed
   * infrastructure, and `AuditService` only records accepted submissions, so
   * a rejected destroy attempt would otherwise leave no forensic record
   * beyond the bare `DestroyNotConfirmedError` message. This especially
   * matters for the target-mismatch case (a Reconfigure completed between
   * mint and confirm): without a distinguishing log line, that rejection is
   * indistinguishable after the fact from an operator simply re-submitting a
   * stale token.
   */
  private assertFreshDestroyConfirmation(
    token: string,
    currentStateBucket: string | undefined,
    currentStateBucketRegion: string | undefined,
  ): void {
    const pending = this.pendingDestroyConfirmation;
    if (!pending) {
      logger.warn('pulumi destroy confirmation rejected: no confirmation token has ever been minted');
      throw new DestroyNotConfirmedError();
    }
    if (pending.token !== token) {
      logger.warn('pulumi destroy confirmation rejected: supplied token does not match the most recently minted token');
      throw new DestroyNotConfirmedError();
    }
    if (Date.now() > pending.expiresAt) {
      logger.warn('pulumi destroy confirmation rejected: the most recently minted token has expired', {
        expiresAt: pending.expiresAt,
      });
      throw new DestroyNotConfirmedError();
    }
    if (
      pending.stateBucket !== currentStateBucket ||
      pending.stateBucketRegion !== currentStateBucketRegion ||
      pending.stackName !== PULUMI_STACK_NAME ||
      pending.projectName !== PULUMI_PROJECT_NAME
    ) {
      logger.warn(
        'pulumi destroy confirmation rejected: token is bound to a different target — the state bucket/region ' +
          '(or project/stack) changed since the token was minted, most likely via a Reconfigure completing in ' +
          'between',
        {
          mintedStateBucket: pending.stateBucket,
          currentStateBucket,
          mintedStateBucketRegion: pending.stateBucketRegion,
          currentStateBucketRegion,
        },
      );
      throw new DestroyNotConfirmedError();
    }
    this.pendingDestroyConfirmation = null;
  }

  /**
   * Resolves the OS-level identity recorded as {@link RunLock.initiator} for
   * an apply — duplicates `TerraformController.resolveApprover()`'s
   * identical `os.userInfo().username` lookup rather than depending on a
   * controller (none exists yet for Pulumi operations, and {@link apply} is
   * self-contained per this task's ruling — see {@link getConfigurationBucket}'s
   * doc comment for the established precedent of duplicating a small
   * OS-level accessor rather than adding a dependency this class has no
   * other reason for).
   */
  private static resolveInitiator(): string {
    return userInfo().username;
  }

  /**
   * Reduces a {@link PulumiApplyOutcome} to the minimal
   * {@link PulumiOperationOutcome} shape {@link PulumiRunPersistError}
   * carries — mirrors {@link toOperationOutcome} exactly, for `apply`'s own
   * outcome type.
   */
  private static toApplyOperationOutcome(outcome: PulumiApplyOutcome): PulumiOperationOutcome {
    switch (outcome.kind) {
      case 'success':
        return { kind: 'success' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
    }
  }

  /**
   * Reduces a {@link PulumiDestroyOutcome} to the minimal
   * {@link PulumiOperationOutcome} shape {@link PulumiRunPersistError}
   * carries — mirrors {@link toOperationOutcome}/{@link toApplyOperationOutcome}
   * exactly, for `destroy`'s own outcome type.
   */
  private static toDestroyOperationOutcome(outcome: PulumiDestroyOutcome): PulumiOperationOutcome {
    switch (outcome.kind) {
      case 'success':
        return { kind: 'success' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
    }
  }

  /**
   * Reads and parses the persisted plan artifact's top-level `manifest.version`
   * field (e.g. `"v3.255.0"`) and strips a leading `v`, if present, before
   * returning — see {@link preview}'s TSDoc, "Engine-version stamping", for
   * why normalizing here (once, at write time) rather than leaving the
   * caller-facing format mismatch against
   * `PulumiEngineService.getResolvedVersion()`'s own un-prefixed shape.
   */
  private readEngineVersionFromPlanArtifact(artifactPath: string): string {
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8')) as { manifest?: { version?: unknown } };
    const version = parsed.manifest?.version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`Pulumi plan artifact "${artifactPath}" has no readable "manifest.version" field.`);
    }
    return version.replace(/^v/, '');
  }

  /**
   * Computes the SHA-256 hex digest covering both the persisted plan
   * artifact's bytes and the deployment-config object's S3 version id the
   * plan ran against.
   *
   * ## Exact algorithm
   *
   * `sha256(artifactBytes ++ utf8(configVersionId))` — the raw bytes of the
   * plan artifact at `artifactPath`, followed immediately (byte-for-byte
   * concatenation, no separator) by the UTF-8 encoding of `configVersionId`,
   * fed through a single SHA-256 digest pass:
   *
   * ```ts
   * createHash('sha256')
   *   .update(Buffer.concat([readFileSync(artifactPath), Buffer.from(configVersionId, 'utf8')]))
   *   .digest('hex')
   * ```
   *
   * A concatenation (rather than a hash-of-hashes) needs no second hash
   * primitive and is trivially re-derivable at apply time: read the artifact
   * bytes off disk, append the UTF-8 bytes of the config version id the run
   * record has on file, hash once. No separator byte is inserted between the
   * two parts; this is safe because neither input is attacker- or
   * operator-influenced in a way that matters here — the artifact is a JSON
   * file this app itself just wrote, and `configVersionId` is an opaque
   * S3-assigned version id.
   *
   * The engine version does not participate in this hash — see
   * {@link preview}'s TSDoc, "Engine-version stamping", for why it's a
   * separate stored field instead.
   *
   * Public (rather than `private`) so apply-time re-verification can re-read
   * and re-hash the on-disk artifact directly, rather than trusting the
   * stored `planHash` alone to prove the artifact on disk hasn't been
   * swapped or tampered with.
   *
   * @throws Whatever `readFileSync` throws if `artifactPath` can't be read —
   *   wrapped by {@link preview} into {@link PulumiPlanHashError}.
   */
  computePlanHash(artifactPath: string, configVersionId: string): string {
    return createHash('sha256')
      .update(Buffer.concat([readFileSync(artifactPath), Buffer.from(configVersionId, 'utf8')]))
      .digest('hex');
  }

  /**
   * Reads and parses the persisted {@link PulumiRunRecord} for `runId` from
   * `<runsDir>/<runId>/run.json` (see {@link writeRunRecord}) — the
   * run-detail counterpart to {@link streamRunOutput}'s output feed. Returns
   * `null` (rather than throwing) when no `run.json` exists for `runId` yet
   * — e.g. the run is still in flight and hasn't settled, or `runId`
   * doesn't exist at all. Callers that need to distinguish "still running"
   * from "unknown run" should also consult `RunService.getCurrentLock()`
   * (the durable apply lock) or attempt a live {@link streamRunOutput}
   * subscription — exactly like `TerraformRunsController.get()` does.
   *
   * @throws A plain `Error` synchronously if `runId` isn't a bare path
   *   segment matching {@link RUN_ID_PATTERN} (via {@link assertValidRunId}).
   */
  readRunRecord(runId: string): PulumiRunRecord | null {
    PulumiService.assertValidRunId(runId);
    const recordPath = join(this.getRunsDir(), runId, 'run.json');
    if (!existsSync(recordPath)) {
      return null;
    }
    return JSON.parse(readFileSync(recordPath, 'utf8')) as PulumiRunRecord;
  }

  /**
   * Reports whether {@link previewCore}'s persisted plan artifact exists on
   * disk for `runId` — `<runsDir>/<runId>/<runId>.plan.json`, the exact path
   * {@link apply}'s gate step 6 re-hashes (see that method's "Gate structure"
   * doc section). Pulumi's `--save-plan` JSON artifact, not a Terraform
   * binary plan file. Used by `TerraformRunsController.get()` to distinguish
   * a `plan` record that's still applyable from one whose artifact has since
   * been cleaned up.
   *
   * @throws A plain `Error` synchronously if `runId` isn't a bare path
   *   segment matching {@link RUN_ID_PATTERN} (via {@link assertValidRunId}).
   */
  hasPlanArtifact(runId: string): boolean {
    PulumiService.assertValidRunId(runId);
    return existsSync(join(this.getRunsDir(), runId, `${runId}.plan.json`));
  }

  /**
   * Reduces a {@link PulumiPreviewOutcome} (which carries the full
   * {@link PulumiPreviewResult} on success) to the minimal
   * {@link PulumiOperationOutcome} shape {@link PulumiRunPersistError}
   * carries — mirrors `TerraformRunPersistError`'s equivalent narrowing
   * (`TerraformService.plan()` constructs its `TerraformPlanOutcome`
   * directly as the argument; this method exists because `PulumiPreviewOutcome`
   * has richer per-operation shapes than the single cross-operation
   * `PulumiOperationOutcome` union `PulumiRunPersistError` is deliberately
   * kept to — see that type's own doc comment for why).
   */
  private static toOperationOutcome(outcome: PulumiPreviewOutcome): PulumiOperationOutcome {
    switch (outcome.kind) {
      case 'success':
        return { kind: 'success' };
      case 'aborted':
        return { kind: 'aborted' };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
    }
  }

  /**
   * Registers a fresh, empty {@link PulumiActiveRunBuffer} for `runId` —
   * mirrors `TerraformService.beginActiveRun` exactly.
   */
  private beginActiveRun(runId: string): void {
    this.activeRuns.set(runId, {
      chunks: [],
      listeners: new Set(),
      settled: false,
      settledListeners: new Set(),
    });
  }

  /**
   * Appends `chunk` to `runId`'s {@link PulumiActiveRunBuffer} (a no-op if
   * no buffer is registered) and synchronously notifies every subscriber —
   * mirrors `TerraformService.recordRunChunk` exactly.
   */
  private recordRunChunk(runId: string, chunk: PulumiRunChunk): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.chunks.push(chunk);
    for (const listener of active.listeners) {
      listener(chunk);
    }
  }

  /**
   * Marks `runId`'s {@link PulumiActiveRunBuffer} as settled and removes it
   * from {@link activeRuns} — mirrors `TerraformService.endActiveRun`
   * exactly.
   */
  private endActiveRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.settled = true;
    for (const listener of active.settledListeners) {
      listener();
    }
    active.settledListeners.clear();
    this.activeRuns.delete(runId);
  }

  /**
   * Returns the single filesystem path every operation ({@link preview},
   * and later `up`/`destroy`) writes its captured stdout/stderr transcript
   * to — `<runsDir>/<runId>/pulumi.log`. Mirrors `TerraformService.getRunLogPath`,
   * renamed from `terraform.log`.
   */
  private getRunLogPath(runId: string): string {
    return join(this.getRunsDir(), runId, 'pulumi.log');
  }

  /**
   * Writes `lines` to `<runsDir>/<runId>/pulumi.log` in a single
   * `writeFileSync` call — mirrors `TerraformService.writeRunLog` exactly,
   * including its "log a WARN and swallow, never throw" contract.
   */
  private writeRunLog(runId: string, lines: string[]): void {
    const runDir = join(this.getRunsDir(), runId);
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(this.getRunLogPath(runId), lines.map((line) => `${line}\n`).join(''));
    } catch (err) {
      logger.warn('failed to write pulumi run log', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Replays a finished run's persisted `pulumi.log` line-by-line as
   * `stdout`-tagged {@link PulumiRunChunk} values — mirrors
   * `TerraformService.replayRunLog` exactly, the fallback path
   * {@link streamRunOutput} takes once `runId` is no longer in flight.
   *
   * @throws A plain `Error` when no `pulumi.log` exists for `runId`.
   */
  private async *replayRunLog(runId: string): AsyncGenerator<PulumiRunChunk, void> {
    const logPath = this.getRunLogPath(runId);
    if (!existsSync(logPath)) {
      throw new Error(`PulumiService.streamRunOutput(): no run found for runId "${runId}".`);
    }
    const contents = readFileSync(logPath, 'utf8');
    const lines = contents.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    for (const line of lines) {
      yield { stream: 'stdout', line };
    }
  }

  /**
   * Streams a run's output — live if `runId` is still in flight (replaying
   * every chunk buffered so far, then following live chunks until the run
   * settles), or by replaying the persisted `pulumi.log` if it's already
   * finished. Mirrors `TerraformService.streamRunOutput` exactly.
   *
   * @throws A plain `Error` (via {@link replayRunLog}) if `runId` is neither
   *   currently in flight nor has a persisted log on disk.
   */
  async *streamRunOutput(runId: string, signal?: AbortSignal): AsyncGenerator<PulumiRunChunk, void> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      yield* this.replayRunLog(runId);
      return;
    }

    for (const chunk of active.chunks) {
      yield chunk;
    }
    if (active.settled) {
      return;
    }

    const queue: PulumiRunChunk[] = [];
    let wake: (() => void) | null = null;
    let done = false;

    const onChunk = (chunk: PulumiRunChunk): void => {
      queue.push(chunk);
      wake?.();
      wake = null;
    };
    const onSettled = (): void => {
      done = true;
      wake?.();
      wake = null;
    };
    const onAbort = (): void => {
      done = true;
      wake?.();
      wake = null;
    };

    active.listeners.add(onChunk);
    active.settledListeners.add(onSettled);
    signal?.addEventListener('abort', onAbort);

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done || signal?.aborted) {
          return;
        }
        await new Promise<void>((resolveWait) => {
          wake = resolveWait;
        });
      }
    } finally {
      active.listeners.delete(onChunk);
      active.settledListeners.delete(onSettled);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Writes a {@link PulumiRunRecord} to `<runsDir>/<runId>/run.json` once a
   * `preview`/`up`/`destroy` run has settled. Mirrors
   * `TerraformService.writeRunRecord`, plus the `changeSummary`/
   * `engineVersion`/`partialApply` fields — see
   * {@link PulumiRunRecord.partialApply}'s doc comment.
   *
   * @throws A descriptive `Error` (wrapping the underlying filesystem error
   *   as `cause`) if `mkdirSync`/`writeFileSync` fails.
   */
  private writeRunRecord(
    runId: string,
    kind: RunKind,
    startedAt: string,
    completedAt: string,
    exitCode: number | null,
    tfvarsVersionId: string | undefined,
    planHash: string | undefined = undefined,
    rolledBackFrom: string | undefined = undefined,
    changeSummary: ChangeSummary | undefined = undefined,
    engineVersion: string | undefined = undefined,
    partialApply: boolean | undefined = undefined,
  ): void {
    PulumiService.assertValidRunId(runId);
    const runDir = join(this.getRunsDir(), runId);
    const record: PulumiRunRecord = {
      runId,
      kind,
      startedAt,
      completedAt,
      exitCode,
      tfvarsVersionId,
      planHash,
      rolledBackFrom,
      changeSummary,
      engineVersion,
      partialApply,
    };
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'run.json'), JSON.stringify(record, null, 2));
    } catch (err) {
      throw new Error(
        `Failed to write pulumi run record to "${join(runDir, 'run.json')}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * Persists the cloud-agnostic run-history counterpart of
   * {@link writeRunRecord}'s local `run.json` write, via
   * {@link RunRecordPersister} (the real `RunRecordService` singleton,
   * resolved lazily via {@link getRunRecordPersister}). Mirrors
   * `TerraformService.persistRunRecord` exactly, including its "best-effort,
   * never throws, logged and swallowed on failure" contract. As a side
   * effect (via `RunRecordService.persist`'s own `finally`), this also
   * releases the durable apply lock {@link apply}'s gate step 8 acquired for
   * `runId` — see that method's TSDoc for why no separate release call is
   * needed here.
   */
  private async persistRunRecord(
    runId: string,
    kind: RunKind,
    startedAt: string,
    completedAt: string,
    exitCode: number | null,
    tfvarsVersionId: string | undefined,
    planHash: string | undefined = undefined,
    rolledBackFrom: string | undefined = undefined,
    changeSummary: ChangeSummary | undefined = undefined,
    engineVersion: string | undefined = undefined,
    partialApply: boolean | undefined = undefined,
  ): Promise<void> {
    try {
      await this.getRunRecordPersister().persist(
        {
          runId,
          kind,
          startedAt,
          completedAt,
          exitCode,
          tfvarsVersionId,
          planHash,
          rolledBackFrom,
          changeSummary,
          engineVersion,
          partialApply,
        },
        this.getRunLogPath(runId),
      );
    } catch (err) {
      logger.warn('failed to persist pulumi run record to RunRecordStore', {
        runId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve the configured S3 configuration bucket name. Duplicates
   * `ConfigService.getConfigurationBucket()`'s exact resolution order
   * (env override, then `ElectronStoreService`'s
   * `bootstrap.configurationBucket`) rather than injecting `ConfigService` —
   * `PulumiService` cannot depend on `ConfigService` at all:
   * `ConfigService.getStackOutputs()` already depends on `PulumiService`, so
   * the reverse dependency would be a genuine circular import between the
   * two service class files (see {@link RUN_RECORD_PERSISTER}'s doc comment
   * for the same reasoning applied to `RunRecordService`). Duplicating this
   * one small accessor mirrors the precedent `PulumiWorkspaceService`/
   * `PulumiEngineService` already set for `resolveUserDataPath()`.
   */
  private getConfigurationBucket(): string | null {
    const envOverride = process.env['HYVEON_TFVARS_BUCKET'];
    if (envOverride) return envOverride;
    return this.store.get('bootstrap')?.configurationBucket ?? null;
  }

  /**
   * Resolve the absolute path to the directory `preview()` (and later
   * `up`/`destroy`) writes per-run artifacts into — the SAME
   * `<runsDir>/<runId>/...` layout `TerraformService`'s `.tfplan`/`terraform.log`/
   * `run.json` used, just holding a `.plan.json`/`pulumi.log`/`run.json`
   * trio instead. Duplicates `ConfigService.getRunsDir()`'s exact resolution
   * order (env override `RUNS_DIR_PATH`, then `<userData>/runs`, then
   * `<tmpdir>/hyveon-runs`) — see {@link getConfigurationBucket}'s doc
   * comment for why this can't inject `ConfigService` to reuse it directly.
   * Resolving to the SAME path `ConfigService.getRunsDir()` does (identical
   * env var, identical `userData` subdirectory) is deliberate, not
   * incidental — a future run-history reader keyed only on `runId` must find
   * a Pulumi run's directory in the same place a Terraform run's directory
   * would have been.
   */
  private getRunsDir(): string {
    const envOverride = process.env['RUNS_DIR_PATH'];
    if (envOverride) return resolve(envOverride);

    const userData = this.resolveUserDataPath();
    if (userData) {
      return join(userData, 'runs');
    }

    return join(tmpdir(), 'hyveon-runs');
  }

  /**
   * Resolve the directory `preview()`'s `createInfraProgram` call passes as
   * `InfraProgramOptions.lambdaBundlesDir` — `<lambdaBundlesDir>/<lambda-dir-name>/dist/handler.cjs`
   * is where `@hyveon/infra`'s `defineLambdas` expects each `@hyveon/lambda-*`
   * package's prebuilt bundle. Mirrors the three-tier resolution
   * `lambdas.ts`'s own "The lambda-bundle path contract" doc comment
   * prescribes for this exact call site (`app/packages/infra/src/lambdas.ts`,
   * search that phrase):
   *
   *  1. `HYVEON_LAMBDA_BUNDLES_DIR` env var — wins when set (dev/CI
   *     convenience, mirrors `getConfigurationBucket`'s `HYVEON_TFVARS_BUCKET`
   *     override).
   *  2. Electron packaged app (`app.isPackaged`) — `<resourcesPath>/lambda`.
   *  3. Dev/test fallback — `<repo>/app/packages/lambda` (each
   *     `@hyveon/lambda-*` package's own directory, one level below its
   *     `dist/handler.cjs`).
   *
   * **Known gap:** per `lambdas.ts`'s own doc comment, the packaged-app
   * branch above is not actually satisfiable today —
   * `app/packages/lambda/*\/dist/**` is not in `electron-builder.yml`'s
   * `files:`/`extraResources:` list (only `out/**` and the pinned
   * `node_modules/**` closures are). This method resolves the path
   * faithfully either way; making the packaged build actually find a file
   * there is a separate `electron-builder.yml` packaging change, tracked
   * separately from orchestration logic.
   */
  private getLambdaBundlesDir(): string {
    const envOverride = process.env['HYVEON_LAMBDA_BUNDLES_DIR'];
    if (envOverride) return resolve(envOverride);

    if (this.readIsPackaged()) {
      const resourcesPath = this.readResourcesPath();
      if (resourcesPath) return join(resourcesPath, 'lambda');
    }

    return join(_APP_ROOT, 'packages', 'lambda');
  }

  /**
   * Whether the app is running as a packaged Electron build. Duplicates
   * `ConfigService.readIsPackaged()`'s exact seam — see
   * {@link getConfigurationBucket}'s doc comment for why this can't inject
   * `ConfigService` to reuse it directly.
   */
  private readIsPackaged(): boolean {
    if (!process.versions['electron']) return false;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { isPackaged: boolean } };
      return electron.app.isPackaged;
    } catch {
      return false;
    }
  }

  /**
   * `process.resourcesPath` when running inside a packaged Electron app, or
   * `undefined` otherwise. Duplicates `ConfigService.readResourcesPath()`'s
   * exact seam — see {@link getConfigurationBucket}'s doc comment for why.
   */
  private readResourcesPath(): string | undefined {
    return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  }

  /**
   * Returns the Electron `userData` directory when running inside an
   * Electron process, or `null` otherwise. Duplicates
   * `PulumiWorkspaceService.resolveUserDataPath()`'s (itself duplicated from
   * `ConfigService.readUserDataPath()`) exact seam — see
   * {@link getConfigurationBucket}'s doc comment for why `PulumiService`
   * can't inject `ConfigService` to reuse this instead.
   */
  private resolveUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Throws a descriptive `Error` unless `runId` is a bare path segment
   * matching {@link RUN_ID_PATTERN} — mirrors `TerraformService.assertValidRunId`
   * exactly.
   */
  private static assertValidRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`PulumiService: runId "${runId}" is not a valid run id.`);
    }
  }
}

/**
 * Thrown by `PulumiService.apply`/`.destroy`'s top-of-function
 * `operationInFlight` busy check when another operation is already running
 * against the shared workspace. A typed error (rather than a plain `Error`)
 * lets a controller map {@link inFlight} straight onto
 * `TerraformPlanAck.conflict` without parsing a message string, so the
 * renderer's busy-banner UX (`terraform.page.tsx` reads `ack.conflict`) keeps
 * working the same way it does for the durable lock's `RunLockHeldError`.
 */
export class PulumiOperationInFlightError extends Error {
  constructor(public readonly inFlight: 'preview' | 'up' | 'destroy' | 'rollback') {
    super(
      `PulumiService cannot run this operation while ${inFlight}() is already running; wait for ` +
        'it to finish before submitting another.',
    );
    this.name = 'PulumiOperationInFlightError';
  }
}

/**
 * Thrown by `PulumiService.preview` when the Automation
 * API's `stack.preview()` call throws. Ports `TerraformPlanError`'s role
 * (thrown when the spawned `terraform plan` process exited non-zero) but
 * reshaped: Automation API failures are a thrown `CommandError` (or a
 * subclass, e.g. `ConcurrentUpdateError`), not a process exit code, so this
 * carries the SDK's own error as `cause` instead of an `exitCode`.
 */
export class PulumiPreviewError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi preview failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiPreviewError';
  }
}

/**
 * Thrown by `PulumiService.apply` when the Automation API's `stack.up()`
 * call throws and the failure is a clean (non-partial) failure. Ports
 * `TerraformApplyError`'s role, reshaped the same way as
 * {@link PulumiPreviewError} — see its doc comment for why `cause` replaces
 * `exitCode`. Distinct from {@link PulumiPartialApplyError}, thrown instead
 * when the divergence happened partway through applying resources rather
 * than before any resource was touched.
 */
export class PulumiUpError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi up failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiUpError';
  }
}

/**
 * Thrown by `PulumiService.destroy` when the Automation API's
 * `stack.destroy()` call throws. Ports `TerraformDestroyError`'s role,
 * reshaped the same way as {@link PulumiPreviewError} — see its doc comment
 * for why `cause` replaces `exitCode`.
 */
export class PulumiDestroyError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi destroy failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiDestroyError';
  }
}

/**
 * A single resource-level step the Automation API's `onEvent` stream
 * reported completing (via a `ResOutputsEvent`/`ResourcePreEvent` pair, per
 * `@pulumi/pulumi/automation/events.js`'s `StepEventMetadata`) before a
 * `stack.up()` call diverged partway through. Carried on
 * {@link PulumiPartialApplyError} so a caller (or the run-history UI) can
 * show exactly what already changed before the failure, rather than only
 * "the apply failed".
 */
export interface PulumiPartialApplyStep {
  /** The resource's URN, as reported by the engine event. */
  urn: string;
  /** The resource's Pulumi type token (e.g. `aws:ecs/cluster:Cluster`). */
  type: string;
  /** The operation the engine performed on this resource before the divergence. */
  op: OpType;
}

/**
 * Thrown by `PulumiService.apply` when `stack.up()` fails after at least one
 * resource step has already been applied — i.e. the stack is now in a state
 * between its old and new desired states, distinct from a clean failure
 * ({@link PulumiUpError}) where nothing was touched before the divergence.
 * `TerraformService.ts` had no equivalent: a failed `terraform apply`
 * process's partial-resource-state is only ever visible by re-reading
 * `terraform show`, not surfaced as a distinguishable outcome by the CLI
 * itself.
 *
 * `completedSteps` is populated from whatever `StepEventMetadata` the
 * `onEvent` callback observed before the failure (see
 * {@link PulumiPartialApplyStep}) — the full per-resource fidelity the SDK's
 * event stream exposes, so callers are expected to populate it fully rather
 * than falling back to an empty array; an empty array here would still be a
 * truthful (if less useful) "apply failed partway through, no
 * completed-step detail available" signal if a future caller ever
 * constructs one without wiring up the event listener.
 */
export class PulumiPartialApplyError extends Error {
  constructor(
    public readonly completedSteps: PulumiPartialApplyStep[],
    public readonly cause: unknown,
  ) {
    super(
      `pulumi up failed partway through (${completedSteps.length} resource step(s) already applied): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiPartialApplyError';
  }
}

/**
 * Thrown by `TerraformService.apply`'s successor before spawning the update
 * when the caller supplied a config-object version id (the version the
 * saved plan was generated against) and the S3 configuration object's
 * current head version no longer matches it. Ported from `TerraformService.ts`'s
 * `StalePlanError` with its message text re-termed for Pulumi/config-object
 * nouns ("configuration object" for "tfvars object", "preview()" for
 * "plan()") — the shape (`key`/`bucket`/`expectedVersionId`/`actualVersionId`)
 * and the underlying check (S3 config-object head version) are unchanged,
 * entirely unaffected by the engine swap.
 */
export class StalePlanError extends Error {
  constructor(key: string, bucket: string, expectedVersionId: string, actualVersionId: string | undefined) {
    super(
      `configuration object "${key}" in S3 bucket "${bucket}" is stale for this plan: expected version ` +
        `"${expectedVersionId}" to still be the current head, but the head version is now ` +
        `${actualVersionId ? `"${actualVersionId}"` : 'missing'}. Re-run preview() before applying.`,
    );
    this.name = 'StalePlanError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 1) when no run record
 * exists at all for the supplied `planRunId`. `RunRecordService`'s own
 * `RunRecordNotFoundError` exists but is scoped to `approveRun`'s call site,
 * not `apply`'s gate, so a distinct class follows this file's
 * `Pulumi*Error` house style instead.
 */
export class PulumiPlanRunNotFoundError extends Error {
  constructor(public readonly planRunId: string) {
    super(`No plan run found for planRunId "${planRunId}" — cannot apply.`);
    this.name = 'PulumiPlanRunNotFoundError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 2) when the run record
 * found for `planRunId` is not a `'plan'`-kind record — see
 * {@link PulumiPlanRunNotFoundError}'s doc comment for why a new class
 * rather than reusing `RunRecordService`'s `RunRecordNotPlanError`.
 */
export class PulumiPlanRunWrongKindError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly kind: RunKind,
  ) {
    super(`Run "${planRunId}" is a "${kind}" run, not a "plan" run, and cannot be applied.`);
    this.name = 'PulumiPlanRunWrongKindError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 3) when the plan run's
 * `approvedBy`/`approvedAt` are not both set. Mirrors the pre-migration
 * `TerraformController.apply`'s equivalent (previously an untyped string,
 * never a class), now a proper typed error since `apply` is self-contained
 * and has no controller to compose the message at the call site instead.
 */
export class PulumiPlanNotApprovedError extends Error {
  constructor(public readonly planRunId: string) {
    super(`Plan run "${planRunId}" has not been approved — approve it before applying.`);
    this.name = 'PulumiPlanNotApprovedError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 4) when the plan run's
 * approval is no longer within `APPROVAL_WINDOW_MS`
 * (`@hyveon/shared/runs.js`, `isApprovalExpired`) of `approvedAt` — see
 * {@link PulumiPlanNotApprovedError}'s doc comment for why a typed class now
 * exists where the pre-migration controller used a bare string.
 */
export class PulumiApprovalExpiredError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly approvedAt: string,
  ) {
    super(`Approval for plan run "${planRunId}" (approved at ${approvedAt}) has expired; re-approve before applying.`);
    this.name = 'PulumiApprovalExpiredError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 5) when the
 * caller-supplied `planHash` does not match the plan record's own stored
 * `planHash` — stops a forged or stale hash from ever reaching `stack.up()`.
 * See {@link PulumiPlanNotApprovedError}'s doc comment for why a typed class
 * now exists where the pre-migration controller used a bare string.
 */
export class PulumiPlanHashMismatchError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly recordPlanHash: string | undefined,
    public readonly suppliedPlanHash: string,
  ) {
    super(`Plan hash mismatch for run "${planRunId}": the supplied planHash does not match the approved plan's stored hash.`);
    this.name = 'PulumiPlanHashMismatchError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 6b) when the on-disk
 * plan artifact, re-hashed against the current configuration-object version
 * (`PulumiService.computePlanHash`), no longer matches the plan record's
 * stored `planHash` — even though gate step 6a already confirmed the
 * configuration-object version itself has NOT moved (that condition throws
 * {@link StalePlanError} instead, reusing that existing class). Since the
 * config version is provably unchanged by the time this check runs, a
 * mismatch here can only mean the artifact's own bytes differ from what was
 * hashed at plan time — the file was swapped or modified on disk since the
 * plan was reviewed. Also thrown, wrapping the underlying failure as
 * `cause`, if the artifact can't even be read/hashed. {@link StalePlanError}'s
 * shape (`key`/`bucket`/`expectedVersionId`/`actualVersionId`) describes an
 * S3 config-object version mismatch, not an artifact-bytes mismatch, so
 * reusing it here would misdescribe the failure — hence a distinct class.
 */
export class PulumiPlanArtifactStaleError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly artifactPath: string,
    public readonly cause?: unknown,
  ) {
    super(
      cause !== undefined
        ? `Failed to re-verify plan artifact "${artifactPath}" for run "${planRunId}" before apply: ` +
            `${cause instanceof Error ? cause.message : String(cause)}`
        : `Plan artifact "${artifactPath}" for run "${planRunId}" no longer matches its approved hash — it may ` +
            'have been modified since the plan was reviewed. Re-run preview() before applying.',
    );
    this.name = 'PulumiPlanArtifactStaleError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 7) when the plan
 * record's stamped `engineVersion` no longer matches
 * `PulumiEngineService.getResolvedVersion()` — the `iac-plan-apply-page`
 * spec's "Engine upgraded between plan and apply" scenario requires an
 * error that *names the version change*, which is why both versions are
 * carried and included in the message.
 */
export class PulumiEngineVersionMismatchError extends Error {
  constructor(
    public readonly planRunId: string,
    public readonly planEngineVersion: string | undefined,
    public readonly currentEngineVersion: string | undefined,
  ) {
    super(
      `Plan run "${planRunId}" was produced by Pulumi engine version "${planEngineVersion ?? 'unknown'}", but the ` +
        `currently resolved engine is "${currentEngineVersion ?? 'unknown'}" — an engine upgrade between plan and ` +
        'apply invalidates the plan. Re-run preview() before applying.',
    );
    this.name = 'PulumiEngineVersionMismatchError';
  }
}

/**
 * Thrown by `PulumiService.preview` when the saved plan artifact can't be
 * hashed (or its `manifest.version` read — see
 * {@link PulumiService.readEngineVersionFromPlanArtifact}) after a
 * successful `stack.preview()` call. Renamed from `TerraformService.ts`'s
 * `TerraformPlanHashError`. Updated in what it hashes: the saved Pulumi
 * update-plan JSON file, not a `.tfplan` binary.
 */
export class PulumiPlanHashError extends Error {
  constructor(
    public readonly runId: string,
    public readonly artifactPath: string,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to compute SHA-256 hash of plan artifact "${artifactPath}" for run "${runId}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiPlanHashError';
  }
}

/**
 * Generic terminal outcome shape for a Pulumi operation (`preview`/`up`/
 * `destroy`), carried by {@link PulumiRunPersistError}. Deliberately minimal
 * (no operation-specific `result` payload) — only carries what
 * {@link PulumiRunPersistError.describeOutcome} needs to render a message
 * (`kind`, and the failure's `error` when `kind === 'failed'`).
 */
export type PulumiOperationOutcome =
  | { kind: 'success' }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: Error };

/**
 * Thrown when persisting a run record (local artifact plus the
 * `RunRecordStore` write) fails after a `preview`/`up`/`destroy` operation
 * has already settled. Ported from `TerraformService.ts`'s
 * `TerraformRunPersistError` and renamed (unlike the "AS-IS" ports above) —
 * its `outcome` field is reshaped to {@link PulumiOperationOutcome} (no
 * `exitCode` to branch on for a Pulumi failure, so `describeOutcome` no
 * longer needs the old `'exitCode' in outcome.error` special case), so it
 * now genuinely describes a Pulumi-specific concept rather than a verbatim
 * port.
 */
export class PulumiRunPersistError extends Error {
  constructor(
    public readonly runId: string,
    public readonly outcome: PulumiOperationOutcome,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to persist run record for run "${runId}" (outcome: ` +
        `${PulumiRunPersistError.describeOutcome(outcome)}): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PulumiRunPersistError';
  }

  /** Renders a {@link PulumiOperationOutcome} as a short phrase for the error message above. */
  private static describeOutcome(outcome: PulumiOperationOutcome): string {
    switch (outcome.kind) {
      case 'success':
        return 'succeeded';
      case 'aborted':
        return 'aborted';
      case 'failed':
        return `failed (${outcome.error.message})`;
    }
  }
}

/**
 * Thrown by `PulumiService.destroy` when it's called without a fresh, valid
 * confirmation token. Ported from `TerraformService.ts`'s
 * `DestroyNotConfirmedError` with its message text re-termed for Pulumi
 * nouns.
 */
export class DestroyNotConfirmedError extends Error {
  constructor() {
    super(
      'pulumi destroy refused: no fresh confirmation token was supplied. Call ' +
        'PulumiService.mintDestroyConfirmationToken() and pass the returned token to ' +
        'destroy() before it expires.',
    );
    this.name = 'DestroyNotConfirmedError';
  }
}

/**
 * Thrown by the rollback flow when no run record exists for the given
 * `applyRunId`. Ported byte-for-byte from `TerraformService.ts`'s
 * `RollbackTargetNotFoundError`.
 */
export class RollbackTargetNotFoundError extends Error {
  constructor(public readonly applyRunId: string) {
    super(`No run record found for apply run "${applyRunId}" — cannot roll it back.`);
    this.name = 'RollbackTargetNotFoundError';
  }
}

/**
 * Thrown by the rollback flow when the run record found for `applyRunId`
 * isn't an `apply` run. Ported byte-for-byte from `TerraformService.ts`'s
 * `RollbackNotApplyRunError`.
 */
export class RollbackNotApplyRunError extends Error {
  constructor(
    public readonly applyRunId: string,
    public readonly kind: RunKind,
  ) {
    super(`Run "${applyRunId}" is a "${kind}" run, not an "apply" run — only apply runs can be rolled back.`);
    this.name = 'RollbackNotApplyRunError';
  }
}

/**
 * Thrown by the rollback flow when the target apply run has no recorded
 * configuration-object version id — there's no version history to roll back
 * against.
 *
 * Renamed from `TerraformService.ts`'s `RollbackNoTfvarsVersionError`: the
 * configuration store retired "tfvars" as its noun everywhere except the one
 * field this class describes. `RunRecord.tfvarsVersionId` itself is
 * intentionally not renamed, so this class's name and the field it
 * describes use different terminology on purpose — a future rename of the
 * field should update this cross-reference too.
 */
export class RollbackNoConfigVersionError extends Error {
  constructor(public readonly applyRunId: string) {
    super(`Apply run "${applyRunId}" has no recorded configuration version id — nothing to roll back.`);
    this.name = 'RollbackNoConfigVersionError';
  }
}

/**
 * Thrown by the rollback flow when the historic configuration version a
 * rollback would restore no longer exists. Ported from
 * `TerraformService.ts`'s `RollbackVersionMissingError` with its message
 * text re-termed for config-object nouns — the shape (`versionId`) is
 * unchanged.
 */
export class RollbackVersionMissingError extends Error {
  constructor(public readonly versionId: string) {
    super(
      `Historic configuration version "${versionId}" no longer exists — it may have expired. Nothing was written.`,
    );
    this.name = 'RollbackVersionMissingError';
  }
}

/**
 * Thrown by {@link PulumiService.confirmRollback} when the historic
 * configuration was successfully restored as the configuration object's new
 * head, but the follow-up plan {@link PulumiService.previewCore} runs
 * against it could not be completed — the `iac-rollback` spec's "MUST NOT
 * leave the restored configuration as the head with no plan attached...
 * silently" clause. No `TerraformService.ts` analogue exists: the old
 * rollback flow never ran the follow-up plan itself, so this failure mode
 * couldn't previously occur inside a single guarded unit at all.
 *
 * This is the "record-and-surface" half of the compensating-semantics
 * strategy (see `confirmRollback`'s TSDoc for why restore-the-previous-head
 * was rejected): by the time this is thrown,
 * `ElectronStoreService.recordOrphanedRollback` has already durably
 * recorded {@link restoredVersionId} against {@link applyRunId} — this error
 * is the same failure surfaced synchronously to whatever is driving
 * `confirmRollback`'s generator, so a caller doesn't need to separately poll
 * the store to learn the rollback didn't fully complete.
 */
export class PulumiRollbackPlanFailedError extends Error {
  constructor(
    public readonly applyRunId: string,
    public readonly restoredVersionId: string,
    public readonly cause: unknown,
  ) {
    super(
      `Rollback of apply run "${applyRunId}" restored configuration version "${restoredVersionId}" as the new ` +
        `head, but the follow-up plan could not be completed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. The restored configuration is now the head ` +
        'with no completed plan attached — this has been durably recorded via ' +
        'ElectronStoreService.recordOrphanedRollback() (readable via getOrphanedRollback()) for a later ' +
        'operator-facing surface to present. Retry the rollback, or restore a different version, to resolve it.',
      { cause },
    );
    this.name = 'PulumiRollbackPlanFailedError';
  }
}
