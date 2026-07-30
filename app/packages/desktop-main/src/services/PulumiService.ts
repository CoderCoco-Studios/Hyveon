import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EngineEvent, OutputMap, PreviewResult, UpResult } from '@pulumi/pulumi/automation/index.js';
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
import { PULUMI_STACK_NAME, PulumiWorkspaceService } from './PulumiWorkspaceService.js';
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
 * identically-named constant exactly (duplicated rather than imported: see
 * this file's `resolveUserDataPath`/`getRunsDir`/`getConfigurationBucket`
 * doc comments for why `PulumiService` never imports `ConfigService`).
 */
const _APP_ROOT = join(_dirname, '..', '..', '..', '..');

/**
 * DI token for {@link RunRecordPersister} — the narrow slice of
 * `RunRecordService`'s public surface {@link PulumiService.preview} depends
 * on. Bound to the real `RunRecordService` singleton via `useExisting` in
 * `run-record.module.ts`, and resolved by `PulumiService` lazily via
 * `ModuleRef.get(RUN_RECORD_PERSISTER, { strict: false })` — see
 * `PulumiService.getRunRecordPersister` and `run-record.module.ts`'s doc
 * comment for why this is a runtime lookup rather than a constructor
 * dependency (a `forwardRef()`-guarded static import cycle was tried first
 * and empirically deadlocks this project's native-ESM module graph at
 * boot).
 *
 * `PulumiService` depends on this token (and the {@link RunRecordPersister}
 * *interface*) instead of importing the concrete `RunRecordService` *class*
 * at all, specifically so this file never needs a value-level import of
 * `RunRecordService.ts` — which imports `ConfigService.ts`, which imports
 * this very file (`PulumiService.ts`) for its own `getStackOutputs()`
 * delegate (task 7.4). A class-typed reference here (even just for a
 * `ModuleRef` lookup keyed on the class itself) would introduce a real
 * circular `import` between these three service files; only
 * `PersistRunRecordParams` (a plain interface, safe to reference — no
 * runtime import needed for a type-only reference) crosses from
 * `RunRecordService.ts` into this file.
 */
export const RUN_RECORD_PERSISTER = Symbol('RUN_RECORD_PERSISTER');

/**
 * The slice of `RunRecordService`'s public surface {@link PulumiService.preview}
 * and (task 7.2) {@link PulumiService.apply} depend on — persisting a
 * finished run to the cloud-agnostic run-history store (DynamoDB for AWS)
 * alongside the captured log transcript, plus (task 7.2's addition)
 * `getByRunId`, which {@link PulumiService.apply}'s gate uses to look up the
 * plan record it's applying (gate step 1). Structurally identical to
 * `RunRecordService.persist`/`.getByRunId`'s own signatures; kept as a
 * separate interface (rather than importing `RunRecordService` as a type and
 * referencing it directly) purely so nothing in this file ever needs
 * `RunRecordService` as a value — see {@link RUN_RECORD_PERSISTER}'s doc
 * comment.
 */
export interface RunRecordPersister {
  persist(params: PersistRunRecordParams, logFilePath: string | null): Promise<void>;
  getByRunId(runId: string): Promise<RunRecord | undefined>;
}

/**
 * DI token for the narrow slice of `RunService`'s public surface
 * {@link PulumiService.apply} depends on — acquiring the durable apply lock
 * (gate step 8's atomic compare-and-set, task 7.7) via `createRun`. Bound to
 * the real `RunService` singleton via `useExisting` in `run-record.module.ts`,
 * resolved lazily by `PulumiService` via a `strict: false` `ModuleRef.get()`
 * lookup — mirrors {@link RUN_RECORD_PERSISTER} exactly, including the
 * reason (a value-level import of `RunService` here would create the same
 * kind of circular `import` `RUN_RECORD_PERSISTER`'s doc comment describes:
 * `RunService.ts` imports `ConfigService.ts`, which imports this very file
 * for its `getStackOutputs()` delegate).
 */
export const RUN_LOCK_SERVICE = Symbol('RUN_LOCK_SERVICE');

/**
 * The slice of `RunService`'s public surface {@link PulumiService.apply}
 * depends on — see {@link RUN_LOCK_SERVICE}'s doc comment. Structurally
 * identical to `RunService.createRun`/`.releaseRun`'s own signatures.
 * `releaseRun` (fix round 1's addition) backstops two distinct paths: the
 * post-`createRun` re-check that closes the apply-vs-`preview`/`destroy`
 * local-workspace race (see {@link apply}'s TSDoc), and the outer `finally`'s
 * unconditional release covering a `writeRunRecord` failure that would
 * otherwise skip `persistRunRecord`'s own lock-releasing `finally` entirely.
 */
export interface RunLockService {
  createRun(kind: RunKind, initiator: string, runId?: string): Promise<RunLock>;
  releaseRun(runId: string): Promise<void>;
}

/**
 * DI token for the narrow slice of `ConfigService`'s public surface
 * {@link PulumiService.apply} depends on — invalidating the memoised
 * `getStackOutputs()`/tfstate cache on a successful apply (requirement
 * carried forward from task 7.4's review: nothing in production currently
 * calls this after a deploy, so without it the dashboard would show "not
 * deployed" indefinitely after the first real apply). Bound to the real
 * `ConfigService` singleton via `useExisting` in `config.module.ts`,
 * resolved lazily by `PulumiService` via a `strict: false` `ModuleRef.get()`
 * lookup — mirrors {@link RUN_RECORD_PERSISTER} exactly: a value-level
 * import of `ConfigService` here would be the exact circular `import`
 * `PulumiService.getConfigurationBucket`'s doc comment already explains
 * `PulumiService` can never take (`ConfigService.getStackOutputs()` already
 * depends on `PulumiService`).
 */
export const CONFIG_CACHE_INVALIDATOR = Symbol('CONFIG_CACHE_INVALIDATOR');

/**
 * The slice of `ConfigService`'s public surface {@link PulumiService.apply}
 * depends on — see {@link CONFIG_CACHE_INVALIDATOR}'s doc comment.
 * Structurally identical to `ConfigService.invalidateCache`'s own signature.
 */
export interface ConfigCacheInvalidator {
  invalidateCache(): void;
}

/**
 * Phase 7 (`migrate-iac-to-pulumi`) service replacing `TerraformService.ts`.
 *
 * Tasks 7.4/7.8/7.9 added the foundational pieces every later Phase-7
 * dispatch needs: the typed error classes ported from `TerraformService.ts`
 * (below), and {@link getStackOutputs} — the async stack-outputs read
 * replacing `ConfigService.getTfOutputs()`. Task 7.1 (this dispatch) adds
 * {@link preview} — the first real Pulumi operation, replacing
 * `TerraformService.plan()` — plus the plan-hash-gate hash computation
 * (task 7.5's first half; the full apply-time staleness-refusal logic is
 * task 7.2's job). `up`/`destroy` (tasks 7.2/7.3) and rollback (7.6) are
 * separate dispatches that add methods to this same class.
 *
 * ## Error-class file organization (task 7.9)
 *
 * All 13 error classes `TerraformService.ts` declared were triaged (see
 * `task-7.4-7.8-7.9-brief.md` for the full per-class verdict table this
 * follows) into: 2 DROPPED (`TerraformNotFoundError`, `TerraformInitError` —
 * no Pulumi analogue, since `PulumiEngineService` auto-installs and there is
 * no separate init step), 5 ported byte-for-byte under their ORIGINAL name
 * (`StalePlanError`, `DestroyNotConfirmedError`,
 * `RollbackTargetNotFoundError`, `RollbackNotApplyRunError`,
 * `RollbackVersionMissingError` — each is about S3 config-object versioning
 * or the destroy confirmation-token gate, concepts the engine swap doesn't
 * touch), 1 ported under its original name by task 7.9 as a placeholder and
 * then renamed by task 7.1 once it had a real caller (`TerraformPlanHashError`
 * → {@link PulumiPlanHashError} — see that class's own doc comment), 1
 * ported AND renamed for terminology (`RollbackNoTfvarsVersionError`
 * → {@link RollbackNoConfigVersionError} — Phase 6 already retired "tfvars"
 * as the configuration-store noun; `RunRecord.tfvarsVersionId` itself is NOT
 * renamed per task 7.8's scope, so the field/class names now intentionally
 * diverge), 4 ported AND reshaped+renamed to the `Pulumi*Error` convention
 * because their shape genuinely changed with the engine
 * (`TerraformPlanError`/`TerraformApplyError`/`TerraformDestroyError` lost
 * their `exitCode` field — Automation API throws a `CommandError`, not a
 * process exit code — becoming {@link PulumiPreviewError}/
 * {@link PulumiUpError}/{@link PulumiDestroyError}; `TerraformRunPersistError`
 * had its `outcome` union reshaped for Pulumi outcomes, becoming
 * {@link PulumiRunPersistError}), and 1 newly added
 * ({@link PulumiPartialApplyError}, for task 7.2's clean-failure-vs-partial-
 * apply distinction). `PulumiUnrecognizedLockError` (Phase 4,
 * `PulumiLockRecovery.ts`) already exists and is NOT recreated here — it's
 * confirmed as the correct class for later dispatches' stale-lock handling.
 *
 * Colocated in this one file (rather than a separate `pulumiServiceErrors.ts`)
 * because every one of them is either thrown by, or describes the outcome
 * of, a method this class owns (existing or still to come) — there's no
 * independent consumer that would benefit from importing the errors without
 * the service, unlike e.g. `@hyveon/shared`'s error types.
 *
 * **Duplicate class names, temporarily:** the 5 classes ported under their
 * original name (`StalePlanError`, `DestroyNotConfirmedError`,
 * `RollbackTargetNotFoundError`, `RollbackNotApplyRunError`,
 * `RollbackVersionMissingError`) now exist as TWO distinct classes with the
 * same name — one exported from `TerraformService.ts`, one from this file —
 * until task 7.10 deletes the former. (`TerraformPlanHashError` no longer
 * has this problem — its rename to `PulumiPlanHashError` this dispatch means
 * only `TerraformService.ts`'s copy still uses the old name.) Nothing in the
 * codebase imports both today, so this is currently latent, but an
 * `instanceof` check written against the wrong module's import would
 * silently never match (no compile error, just a check that's always
 * `false`) — worth flagging explicitly for whoever writes 7.2-7.6's call
 * sites: always import these from `PulumiService.ts`, never from
 * `TerraformService.ts`, once both exist side by side.
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
 * A single line of streamed stdout/stderr output from a Pulumi Automation
 * API operation, tagged with the stream it came from. Mirrors
 * `TerraformService.ts`'s `TerraformRunChunk` exactly — same shape, same
 * role (yielded by `preview`/`up`/`destroy` as the operation produces
 * output, consumed by {@link PulumiService.streamRunOutput}'s subscribers)
 * — renamed for this file's `Pulumi*` convention.
 */
export interface PulumiRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * In-memory fan-out buffer for a single in-flight `preview`/`up`/`destroy`
 * run's streamed output, keyed by `runId` in `PulumiService`'s private
 * `activeRuns` map. Mirrors `TerraformService.ts`'s `ActiveRunBuffer`
 * byte-for-byte — see that interface's doc comment for the full contract
 * (populated by {@link PulumiService.recordRunChunk}, consumed by
 * {@link PulumiService.streamRunOutput}).
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
 * run wasn't aborted. Mirrors `TerraformService.ts`'s `TerraformPlanResult`,
 * reshaped for the engine swap:
 *  - `varFilePath` is dropped — the Pulumi inline program takes the
 *    deployment config as an in-memory object (see {@link PulumiService.preview}),
 *    so there is no separate pulled-var-file artifact on disk to point at.
 *  - `add`/`change`/`destroy` (three counts scraped from Terraform's
 *    human-readable summary line) become the single structured
 *    {@link ChangeSummary} the design doc's "Structured summaries, not
 *    scraped stdout" decision requires.
 *  - `engineVersion` is new: the engine version stamped into the saved plan
 *    artifact's own `manifest.version` field — see
 *    {@link PulumiService.preview}'s doc comment, "Engine-version stamping",
 *    for why this is a separate field rather than folded into `planHash`.
 */
export interface PulumiPreviewResult {
  /** The `runId` minted for this run — the parent directory (`<runsDir>/<runId>/`) of {@link artifactPath}. */
  runId: string;
  /** Absolute path to the persisted Pulumi update-plan JSON artifact (`--save-plan`) — what a future `up()` passes as `UpOptions.plan`. */
  artifactPath: string;
  /**
   * The structured resource-change summary this run's `stack.preview()`
   * reported — see {@link ChangeSummary}'s doc comment for the "`{}` means
   * summary missed, not no changes" sharp edge every reader must respect.
   */
  changeSummary: ChangeSummary;
  /**
   * SHA-256 hex digest covering both the persisted plan artifact's bytes AND
   * the deployment-config object's S3 version id this run ran against — see
   * {@link PulumiService.computePlanHash}'s doc comment for the exact
   * algorithm.
   */
  planHash: string;
  /**
   * The engine version stamped into the saved plan artifact's own
   * `manifest.version` field, with any leading `v` stripped (e.g. the
   * artifact's `"v3.255.0"` is stored as `"3.255.0"`) so it's directly
   * comparable — via a bare string equality, no caller-side normalization
   * needed — against `PulumiEngineService.getResolvedVersion()`'s own
   * un-prefixed shape. See {@link PulumiService.readEngineVersionFromPlanArtifact}
   * for exactly where the stripping happens. Stored alongside, not folded
   * into, {@link planHash} — see {@link PulumiService.preview}'s doc comment,
   * "Engine-version stamping", for why.
   */
  engineVersion: string;
}

/**
 * Describes what {@link PulumiService.preview} was about to return/throw the
 * moment its operation settled — captured before the run record is
 * persisted so a persistence failure (see {@link PulumiRunPersistError})
 * doesn't discard the real outcome. Mirrors `TerraformService.ts`'s
 * `TerraformPlanOutcome`.
 */
export type PulumiPreviewOutcome =
  | { kind: 'success'; result: PulumiPreviewResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: PulumiPreviewError | PulumiPlanHashError };

/**
 * Persisted to `<runsDir>/<runId>/run.json` once a {@link PulumiService.preview}
 * (and, later, `up`/`destroy`) run has settled — the local run-history
 * counterpart to the DynamoDB write {@link PulumiService.persistRunRecord}
 * makes through {@link RunRecordPersister}. Mirrors `TerraformService.ts`'s
 * `TerraformRunRecord` field-for-field, plus `changeSummary`/`engineVersion`
 * (new, task 7.1). `kind` reuses the SAME `RunKind` union
 * (`'plan'`/`'apply'`/`'destroy'`) `TerraformRunRecord` used — task 7.8
 * deliberately did not rename this vocabulary, so a Pulumi `preview` run is
 * still recorded as a `'plan'` kind.
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
  /** `0` on success, `null` if aborted, a nonzero sentinel (`1`) on a genuine failure — mirrors `TerraformRunRecord.exitCode`'s three-way meaning even though there is no real process exit code to report for an Automation API call. */
  exitCode: number | null;
  /** The deployment-config object's S3 version id this run ran against. */
  tfvarsVersionId?: string;
  /** SHA-256 hex digest of the persisted plan artifact plus the config version id — see {@link PulumiService.computePlanHash}. */
  planHash?: string;
  /** The `runId` of the `apply` run this plan rolled back, if this run was started via the rollback flow (task 7.6, not yet built). */
  rolledBackFrom?: string;
  /** The structured resource-change summary this run's `stack.preview()` reported — see {@link ChangeSummary}'s doc comment. */
  changeSummary?: ChangeSummary;
  /** The engine version stamped into the saved plan artifact — see {@link PulumiPreviewResult.engineVersion}. */
  engineVersion?: string;
  /**
   * `true` only on a `kind: 'apply'` record whose `stack.up()` call did NOT
   * settle as `'success'` — failed OR was aborted — AFTER at least one
   * resource step had already been applied. Task 7.2's "distinguish clean
   * failure from partial apply" requirement. Deliberately an ADDITIVE field
   * alongside `exitCode`/`status` rather than a fourth `RunStatus` value:
   * `RunStatus` is also the hash key of the `status-index` DynamoDB GSI
   * (`terraform/aws/runs_store.tf`), so widening its value set is an
   * infra-affecting change this dispatch declines to take on without
   * explicit justification — an additive boolean lets the UI/later logic
   * check "is this a partial apply" without touching the GSI's key schema at
   * all.
   *
   * **Independent of which non-`'success'` `status` the run settled with —
   * fix round 1 correction of an earlier, incorrect doc claim.** This is
   * `true` on a `status: 'failed'` record (`exitCode: 1`) exactly as often
   * as on a `status: 'aborted'` one (`exitCode: null` — the operator
   * pressing Cancel mid-`up()`, arguably the single most likely real-world
   * way this system ends up partway through). **Any consumer MUST check
   * `partialApply` directly and MUST NOT gate that check behind
   * `status === 'failed'` first** — doing so silently misses every
   * cancelled-mid-apply partial. Absent (never `false`) on every
   * non-partial record (including every `status: 'success'` record, however
   * many resources it touched), mirroring this file's established "absence
   * means N/A, not false" convention for `changeSummary`/`engineVersion`
   * above.
   */
  partialApply?: boolean;
}

/**
 * Outcome of a successful {@link PulumiService.apply} run, resolved via the
 * async generator's return value once `stack.up()` settles and the run
 * wasn't aborted. Deliberately narrower than {@link PulumiPreviewResult}: no
 * `artifactPath`/`planHash`/`engineVersion` — those describe the *plan* this
 * apply was constrained by (already on the plan's own {@link PulumiRunRecord},
 * looked up via `planRunId`), not a fresh artifact this run itself produces.
 */
export interface PulumiUpResult {
  /** The `runId` of this apply run — always equal to the `planRunId` the gate validated (see {@link PulumiService.apply}'s "run id" doc section). */
  runId: string;
  /**
   * The structured resource-change summary this run's `stack.up()` reported,
   * captured via `onEvent`'s `summaryEvent` — see {@link ChangeSummary}'s
   * doc comment for the "`{}` means summary missed, not no changes" sharp
   * edge every reader must respect.
   */
  changeSummary: ChangeSummary;
}

/**
 * Describes what {@link PulumiService.apply} was about to return/throw the
 * moment its operation settled — captured before the run record is
 * persisted so a persistence failure (see {@link PulumiRunPersistError})
 * doesn't discard the real outcome. Mirrors {@link PulumiPreviewOutcome},
 * plus `partialApply` on the `'failed'` variant (task 7.2's clean-failure-
 * vs-partial-apply distinction — see {@link PulumiRunRecord.partialApply}'s
 * doc comment for why this is a sibling flag rather than a fourth outcome
 * kind).
 *
 * **This type's own `partialApply` is NOT what gets persisted** — it exists
 * only for the `'failed'` variant's own internal bookkeeping. The
 * PERSISTED `PulumiRunRecord.partialApply` value {@link apply} actually
 * writes is computed independently, directly from `completedSteps.length`,
 * gated only on `outcome.kind !== 'success'` — covering the `'aborted'`
 * variant too, which carries no `partialApply` field of its own here. See
 * {@link apply}'s implementation and {@link PulumiRunRecord.partialApply}'s
 * doc comment.
 */
export type PulumiApplyOutcome =
  | { kind: 'success'; result: PulumiUpResult }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: Error; partialApply: boolean };

/**
 * Phase 7 (`migrate-iac-to-pulumi`) service replacing `TerraformService.ts`
 * — see this file's top-level doc comment (above) for the full picture:
 * the ported error classes, {@link getStackOutputs}, and (task 7.1)
 * {@link preview}, the first real Pulumi operation.
 */
@Injectable()
export class PulumiService {
  /**
   * Name of whichever operation (`preview`, or later `up`/`destroy`) is
   * actively running against the shared Pulumi workspace directory, or
   * `null` when none is. Mirrors `TerraformService.ts`'s `workspaceInFlight`
   * guard: every operation reuses the SAME `workDir`/`Pulumi.<stack>.yaml`
   * (`PulumiWorkspaceService.getWorkspaceRoot`'s doc comment: "one stable
   * directory per stack, reused across operations"), so two concurrent
   * operations against this one `PulumiService` instance would race on that
   * shared local state — independent of whether the DIY backend's own lock
   * is ever taken (see {@link preview}'s doc comment, "Does preview take the
   * backend lock?", for why `preview` itself never takes that lock; this
   * in-process guard exists regardless, for the local workspace files).
   */
  private operationInFlight: 'preview' | 'up' | 'destroy' | null = null;

  /**
   * Fan-out buffers for every currently in-flight `preview`/`up`/`destroy`
   * run, keyed by `runId`. Mirrors `TerraformService.ts`'s `activeRuns` —
   * see {@link PulumiActiveRunBuffer}'s doc comment for the full contract.
   */
  private readonly activeRuns = new Map<string, PulumiActiveRunBuffer>();

  /**
   * `workspace`/`store` are the same two dependencies this class has taken
   * since task 7.4. `engine` (task 7.2's addition) is `apply`'s route to
   * `PulumiEngineService.getResolvedVersion()` for the gate's engine-version
   * check (step 7) — an ordinary constructor dependency, not a lazy
   * `ModuleRef` lookup, because `PulumiEngineModule` has no dependencies of
   * its own and importing it into `pulumi-service.module.ts` creates no
   * cycle (unlike `RunRecordModule`/`ConfigModule`, both reachable from
   * `PulumiServiceModule`'s own importers — see below). `moduleRef` is
   * `preview`'s (task 7.1) route to `RUN_RECORD_PERSISTER` (the DynamoDB
   * run-history write path) and `REMOTE_FILE_STORE` (the cloud-agnostic
   * config-object store), and (task 7.2's addition) `apply`'s route to
   * `RUN_LOCK_SERVICE` (the durable apply lock, gate step 8) and
   * `CONFIG_CACHE_INVALIDATOR` (the post-apply cache invalidation, task
   * 7.4's carried-forward requirement) — see {@link getRunRecordPersister}/
   * {@link getRemoteFileStore}/{@link getRunLockService}/
   * {@link getConfigCacheInvalidator} for why these four are resolved
   * lazily via `ModuleRef.get(token, { strict: false })` at call time rather
   * than taken as ordinary constructor-injected dependencies:
   * `pulumi-service.module.ts`'s own doc comment has the full story (a
   * `forwardRef()`-guarded static import cycle was tried first and
   * empirically deadlocks this project's native-ESM module graph at boot).
   * `ModuleRef` itself is a core Nest primitive with no relation to any
   * module in that cycle, so injecting it creates no new edge at all.
   */
  constructor(
    private readonly workspace: PulumiWorkspaceService,
    private readonly store: ElectronStoreService,
    private readonly moduleRef: ModuleRef,
    private readonly engine: PulumiEngineService,
  ) {}

  /**
   * Lazily resolves the real `RunRecordService` singleton (bound to
   * {@link RUN_RECORD_PERSISTER} by `run-record.module.ts`) from anywhere in
   * the application's provider container — see the constructor's doc
   * comment and `run-record.module.ts`'s for why this is a `ModuleRef`
   * lookup rather than a constructor dependency. Safe to call from
   * {@link preview} (and later `up`/`destroy`): those methods only ever run
   * once the application has fully bootstrapped, by which point every
   * provider `RUN_RECORD_PERSISTER` could possibly resolve to already
   * exists. `strict: false` searches the whole container, not just this
   * service's own module scope — required, since `PulumiServiceModule`
   * deliberately does not import whatever module provides this token.
   *
   * Throws a clear, wrapped `Error` (naming the missing token and the module
   * expected to provide it) rather than letting Nest's own
   * `UnknownElementException` propagate unexplained — deliberately the SAME
   * failure mode {@link getRemoteFileStore} uses for the identical situation,
   * so a missing DI binding fails loudly and identically regardless of which
   * token is missing. What a *caller* of this method does with that thrown
   * error is a separate, independent choice made at each call site: `preview`'s
   * `persistRunRecord` wraps this call in a try/catch that treats ANY
   * failure of the run-history side-write (a missing token included) as
   * best-effort and logs+swallows it, mirroring `TerraformService.persistRunRecord`'s
   * pre-existing "never throws" contract for that specific write — that is
   * `persistRunRecord`'s own deliberate policy about what "run-history
   * persistence failed" means for an otherwise-successful preview, not a
   * difference in what this method itself does on failure.
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
   * {@link getRunRecordPersister} exactly, including wrapping a missing
   * binding in the same clear, loud `Error` shape; see that method's doc
   * comment. Unlike {@link getRunRecordPersister}, nothing in {@link preview}
   * currently catches a failure from this method — reading the deployment
   * configuration is load-bearing for `preview()` (there is no meaningful
   * "preview with no configuration" outcome), so a missing binding here is
   * correctly a hard failure of the whole operation, not a best-effort
   * side-write.
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
   * {@link getRunRecordPersister} exactly, including the same loud-failure
   * shape on a missing binding. {@link apply}'s gate step 8 (task 7.7's
   * atomic compare-and-set) is the only caller — nothing wraps this in a
   * try/catch the way `persistRunRecord` wraps {@link getRunRecordPersister},
   * since a missing binding here is a wiring bug, not a condition `apply`
   * should degrade past.
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
   * {@link getRunRecordPersister} exactly. {@link apply} calls this only
   * on a successful apply, to invalidate the memoised `getStackOutputs()`
   * cache (task 7.4's carried-forward review requirement) — a failure to
   * resolve this token is logged and swallowed at that call site (mirroring
   * `persistRunRecord`'s "never let a side-effect write mask an otherwise-
   * successful apply" policy), not propagated raw the way
   * {@link getRemoteFileStore}'s failures are.
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
   * Reads every value the app cares about off the deployed Pulumi stack,
   * replacing `ConfigService.getTfOutputs()`'s parse of `terraform.tfstate`.
   * Returns `null` — NEVER throws, full stop — mirroring `getTfOutputs()`'s
   * exact contract: that method had three separate catch-alls
   * (`ConfigService.ts`'s old `getTfOutputs()`, pre-task-7.4) that swallowed
   * every failure — a missing file, unparseable JSON, a thrown projection
   * error — and returned `null`/logged rather than ever propagating. Every
   * one of the ~14 call sites this dispatch migrated to `getStackOutputs()`
   * was written against that never-throw contract (several inside `finally`
   * blocks, or ahead of code that must not be skipped by an unhandled
   * rejection — e.g. `RunService.releaseRun`'s lock release, or
   * `AuditService.record`'s documented "never throws" promise), so this
   * method restores it in full: see the catch-all around the Pulumi call
   * below. See `StackOutputs`'s own doc comment for the "not deployed yet"
   * framing this degrades to.
   *
   * ## Never deployed yet: three independent short-circuits, no Pulumi call
   *
   * A mere outputs *read* must never have the side effect of creating a
   * stack or generating a fresh secrets passphrase — both of which
   * {@link PulumiWorkspaceService.getOrCreateStack} would do for a
   * genuinely-new stack (`stackExists: false`). So this method checks, in
   * order, for evidence that a stack could possibly exist BEFORE ever
   * calling into Pulumi, returning `null` immediately if any check fails:
   *
   * 1. `bootstrap.stateBucket` is configured — no backend has even been
   *    bootstrapped otherwise (mirrors `PulumiBackendNotBootstrappedError`'s
   *    condition, checked here directly so the "not deployed" path never
   *    even constructs a `PulumiWorkspaceInput`).
   * 2. A secrets passphrase is already stored
   *    (`store.get('pulumi')?.passphrase !== undefined`) — this is exactly
   *    {@link PulumiWorkspaceService}'s own definition of "an existing
   *    stack" (see its `resolvePassphrase` doc comment): a passphrase is
   *    only ever persisted the first time a stack is genuinely created. Its
   *    absence means either nothing has ever been deployed from this
   *    install, or a stack exists remotely with no local passphrase record
   *    (`PulumiPassphraseUnavailableError`'s `'existing-stack-no-local-record'`
   *    case) — either way, this method degrades to "not deployed" rather
   *    than risk generating a passphrase that can never decrypt a real
   *    stack's state.
   * 3. `aws.region` is configured — needed to build the backend URL; absent
   *    only if the wizard's credentials step was never completed, which
   *    implies nothing was ever deployed either.
   *
   * **These three checks are a proxy for "a stack might exist", not a
   * proof.** A destroyed stack, or a passphrase persisted by a failed/
   * abandoned create attempt (a future `preview`/`up` dispatch, 7.1/7.2,
   * could plausibly leave one behind), both leave the store looking exactly
   * like "existing stack" when the remote stack may not actually be there —
   * this is a best-effort no-create guarantee, not a proven one. A hot
   * caller (e.g. a short-interval dashboard poll) relying on this to never
   * take the backend's write lock should not assume that guarantee is
   * airtight; a genuinely create-proof read path (e.g. a `listStacks`-based
   * select-only check) is a larger change than this dispatch's scope.
   *
   * Only once all three checks pass does this call
   * {@link PulumiWorkspaceService.getOrCreateStack} (with `stackExists: true`,
   * `backendReady: true`, and a no-op `program` — reading `stack.outputs()`
   * never invokes the program; see below) and `stack.outputs()`, inside a
   * catch-all: ANY failure from either call — `PulumiBackendNotBootstrappedError`,
   * `PulumiPassphraseUnavailableError`, `PulumiCredentialsNotConfiguredError`,
   * engine-resolution failures, or a `CommandError` from the underlying
   * `pulumi stack output` invocation — is logged and degraded to `null`,
   * exactly like `getTfOutputs()`'s old catch-alls. This is a deliberate,
   * blunt restoration of the old contract rather than a nuanced per-error
   * classification: callers cannot tell "genuinely not deployed" apart from
   * "deployed, but this read failed" from the return value alone, which is
   * an acceptable trade against the alternative (an unhandled rejection
   * reaching code that assumed synchronous-style read semantics never
   * throw). A future dispatch that wants callers to distinguish those cases
   * should do so deliberately, call-site by call-site, not by loosening this
   * method's contract back open.
   *
   * ## Why a no-op `program` is safe here
   *
   * `LocalWorkspace.createOrSelectStack`'s `program` option is only ever
   * invoked by `stack.preview()`/`.up()`/`.refresh()` — `stack.outputs()`
   * reads the already-persisted checkpoint/state, never re-running the
   * program (confirmed against `@pulumi/pulumi/automation/stack.js`). This
   * method is read-only, so it passes a trivial `async () => ({})` rather
   * than importing `@hyveon/infra`'s real `createInfraProgram` (which needs
   * a full `DeploymentConfig` this read has no reason to assemble) — keeping
   * this dispatch decoupled from the `@hyveon/infra` package entirely.
   *
   * ## "Empty outputs" also degrades to `null`
   *
   * A stack that exists but has never had a successful `up()` (e.g. only
   * `preview()` has ever run) reports `stack.outputs()` as `{}` — treated as
   * "not deployed" here too, mirroring `projectTfOutputs`'s identical
   * "empty outputs map = infra not yet deployed" rule for
   * `terraform.tfstate`.
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
   * once it settles — replacing `TerraformService.plan()`. Ports that
   * method's generator shape (positional args, `runId`/`startedAt` hoisted
   * above the `try` so a force-closed generator's outer `finally` can still
   * persist a cancelled record, `workspaceInFlight`-equivalent guard,
   * `beginActiveRun` registered before the pre-spawn awaits so an early
   * `streamRunOutput` subscriber never falls through to "unknown run") —
   * see `TerraformService.plan`'s own TSDoc for the shape this mirrors.
   *
   * ## Does `preview` take the DIY backend lock? (investigated this dispatch)
   *
   * **No — verified against the Pulumi CLI's Go source.** `pkg/backend/diy/backend.go`
   * (fetched from the `pulumi/pulumi` GitHub repo, `master` branch, during
   * this dispatch's investigation) shows `diyBackend.Preview` calling `b.apply`
   * directly:
   *
   * ```go
   * func (b *diyBackend) Preview(...) (*deploy.Plan, sdkDisplay.ResourceChanges, error) {
   *     // We can skip PreviewThenPromptThenExecute and just go straight to Execute.
   *     opts := backend.ApplierOptions{DryRun: true, ShowLink: true}
   *     return b.apply(ctx, apitype.PreviewUpdate, stack, op, opts, events)
   * }
   * ```
   *
   * — with **no** `b.Lock`/`b.Unlock` call anywhere in that path. Contrast
   * `diyBackend.Update` (the `up` path, task 7.2's job), which wraps its own
   * call in `err := b.Lock(ctx, stack.Ref()); defer b.Unlock(ctx, stack.Ref())`
   * before proceeding — same for `Import`/`Refresh`/`Destroy`. `Lock` itself
   * calls `checkForLock` (`pkg/backend/diy/lock.go`), which is what produces
   * the `"the stack is currently locked by"` conflict text
   * `PulumiLockRecovery.ts` classifies — since `Preview` never calls `Lock`,
   * it can never observe or report a conflicting lock at all; it reads
   * whatever state snapshot is on disk at the moment it runs, unlocked and
   * unsynchronized with any concurrent `up`/`destroy`. **Conclusion: this
   * method deliberately does NOT wire `ElectronStoreService.recordPulumiLockAttempt`/
   * `clearPulumiLockAttempt` or `PulumiLockRecovery`'s classification** —
   * there is nothing for them to guard here. Task 7.2's `up` almost
   * certainly does need this wiring, since `Update` genuinely takes the
   * lock.
   *
   * ## Leaked-promise `recoverResult` (investigated this dispatch)
   *
   * Confirmed against the SDK's own `PreviewResult` shape (`stack.d.ts`):
   * `{ stdout, stderr, changeSummary }` — nothing this method doesn't
   * already have in hand by the time a leak could occur. `stack.js`'s
   * `preview()` computes `changeSummary` from the exact same `summaryEvent`
   * this method's own `onEvent` callback (below) already captures — the SDK
   * only loses access to it because the leak-check throw replaces the
   * `return` statement, not because the data itself is unavailable. The
   * saved plan artifact (`--save-plan`) is written by the CLI subprocess
   * *before* it exits — i.e. before `runPulumiCmd` resolves and the SDK's
   * `finally`-block leak check even runs — so it's already on disk
   * regardless of which path (clean success or leak-recovery) is taken.
   * **Conclusion: `recoverResult` needs to re-read nothing** — it
   * synthesizes `{ stdout: '', stderr: '', changeSummary }` from the
   * `changeSummary` this method already captured via `onEvent`. `stdout`/
   * `stderr` are left empty in the synthetic result because this method
   * never reads `PreviewResult.stdout`/`.stderr` anyway (the chunk-streaming
   * loop below already captured and yielded every line via `onOutput`/
   * `onError` as it streamed, independent of the SDK's own buffered
   * `stdout`/`stderr` strings).
   *
   * ## Engine-version stamping (decision this dispatch)
   *
   * The saved plan artifact's own `manifest.version` field (e.g.
   * `"v3.255.0"`, WITH a `v` prefix) is read by
   * {@link readEngineVersionFromPlanArtifact}, which strips the prefix
   * before returning — so {@link PulumiPreviewResult.engineVersion} is
   * stored un-prefixed (`"3.255.0"`), directly comparable via a bare string
   * equality against `PulumiEngineService.getResolvedVersion()`'s own
   * un-prefixed shape (`SemVer.toString()` never includes one). Normalizing
   * once here, at write time, means task 7.2's apply-time comparison is a
   * plain `===` with no format trap to rediscover.
   *
   * `engineVersion` is persisted as a field *separate from* {@link planHash}
   * rather than folded into it. Folding it into the hash would make a
   * task-7.2 apply-time mismatch unable to tell "the plan or config changed"
   * apart from "only the engine was upgraded" — the `iac-plan-apply-page`
   * spec's "Engine upgraded between plan and apply" scenario requires an
   * error that *names the version change* specifically, which needs the two
   * failure causes distinguishable. A separate field lets task 7.2 check
   * independently: hash mismatch → generic staleness error; hash match but
   * `engineVersion` differs from `PulumiEngineService.getResolvedVersion()`
   * → the specific "engine upgraded" error.
   *
   * ## Structured `changeSummary`, not scraped stdout
   *
   * `onEvent` captures `event.summaryEvent.resourceChanges` into a local
   * variable exactly the way the SDK's own internal `onEvent` wrapper does
   * (`stack.js`'s `preview()`) — this method's own capture exists
   * specifically so the leaked-promise recovery path above still has it
   * (the SDK's internal capture is not exposed to a caller once the throw
   * replaces its `return`). On every other path, this method's captured
   * value and `PreviewResult.changeSummary` are identical (same
   * `summaryEvent`), so `previewResult.changeSummary` is used directly for
   * the returned result — see {@link ChangeSummary}'s doc comment for the
   * `{}`-means-"summary missed" sharp edge every reader must respect.
   *
   * ## Chunk streaming (ported from `TerraformService.spawnAndStream`)
   *
   * `onOutput`/`onError` deliver **unbounded chunks, not lines** (design.md's
   * "Streaming and cancellation" section) — the exact same shape
   * `spawnAndStream`'s `child.stdout`/`.stderr` `'data'` handlers received.
   * The line-splitting algorithm is ported verbatim: accumulate a per-stream
   * buffer, `split(/\r?\n/)`, hold back the trailing partial line, flush any
   * remainder once the operation settles. What's ported *differently* is the
   * production side: `spawnAndStream` drives its queue from `child.on('data'/'close')`
   * event-emitter callbacks; this method has no child-process handle to
   * listen on (the Automation API's `onOutput`/`onError` are plain callbacks
   * passed into `stack.preview()`), so the same queue/wake/notify consumer
   * loop is instead fed by those callbacks directly, and "closed" is
   * signalled by the wrapped `stack.preview()` promise settling (success or
   * error alike) rather than a `child.on('close', ...)` event.
   *
   * ## Cancellation
   *
   * The whole `stack.preview()` call (wrapped in the leaked-promise
   * recovery above) is wrapped again in {@link runWithEscalatingCancellation}
   * (task 4.7), which forwards a signal into `PreviewOptions.signal` and
   * escalates to a logical forced-termination if the operation doesn't
   * settle within the bounded window after that signal aborts — see that
   * function's own TSDoc for the three distinct settlement shapes
   * ({@link PulumiOperationNotStartedError}/{@link PulumiOperationAbortedError}/
   * {@link PulumiOperationEscalatedError}) this method treats as "aborted"
   * (ending the generator cleanly, resolving `undefined`) rather than a
   * genuine {@link PulumiPreviewError} failure. No `onEscalate` hook is
   * supplied — `preview` has no backend lock to forcefully clear (see
   * above), so there is nothing task 4.7's extension point would do here;
   * task 7.2's `up` is the more likely place for one.
   *
   * The signal actually forwarded is an internal `AbortController` this
   * method owns (mirroring `signal` when the caller supplies one — abort
   * events are chained one-way, caller → internal), NOT `signal` directly.
   * This exists so a **force-closed generator** (a consumer calling
   * `break`/`.return()`/`.throw()` on the generator itself, independent of
   * whether `signal` was ever provided or aborted) still has something to
   * cancel: the outer `finally` below aborts this internal controller and
   * AWAITS the resulting settlement before clearing {@link operationInFlight},
   * so a torn-down consumer can never leave the CLI subprocess (and the
   * shared workspace directory it's still writing to) running unsupervised
   * while this instance reports itself free for a new operation — see the
   * outer `finally`'s own comment for the full rationale and why this
   * mirrors `TerraformService.plan()`'s inner `stream.return({ aborted: true })`
   * call.
   *
   * ## Persistence
   *
   * Once the operation settles (success, failure, or abort), this method —
   * mirroring `TerraformService.plan` exactly — writes the accumulated
   * transcript (`writeRunLog`), settles the active-run buffer
   * (`endActiveRun`), writes the local `<runsDir>/<runId>/run.json`
   * (`writeRunRecord`), and persists the same record to the cloud-agnostic
   * run-history store (`persistRunRecord`, via {@link RunRecordPersister}) —
   * on every exit path, including the force-closed-generator path handled
   * by the outer `finally` below. A persistence failure is wrapped in
   * {@link PulumiRunPersistError} (carrying the already-computed outcome)
   * rather than discarding it.
   *
   * @param configVersionId - The deployment-config object's S3 version id
   *   this preview is expected to run against, if the caller has one (e.g.
   *   re-running a preview after a prior stale one). When supplied and it no
   *   longer matches the configuration object's current head version, throws
   *   before any Pulumi call is made — mirrors `TerraformService.pullVarFile`'s
   *   identical inline staleness check (re-termed for Phase 6's
   *   "configuration object" noun), and is unrelated to {@link planHash}'s
   *   hash mechanism, which always covers whatever version id was actually
   *   observed. Ignored entirely when omitted — there is no prior expectation
   *   to compare against.
   * @param signal - Optional cancellation signal — see "Cancellation" above.
   * @param preMintedRunId - Optional caller-minted `runId` (mirrors
   *   `TerraformService.plan`'s identically-named parameter) — must match
   *   {@link RUN_ID_PATTERN}.
   * @param rolledBackFrom - The `runId` of the `apply` run this preview is
   *   re-planning after a rollback (task 7.6, not yet built) — passed
   *   through to the persisted run record unchanged.
   * @throws A descriptive `Error` if another `preview`/`up`/`destroy` is
   *   already in flight on this instance, or if `preMintedRunId` doesn't
   *   match {@link RUN_ID_PATTERN} — checked at the very top of the method
   *   body, so the throw happens the instant the generator is first driven
   *   (its first `.next()` call), before any `await`; note this is NOT the
   *   same as "synchronously from the `preview(...)` call itself" — like any
   *   async generator, calling `preview(...)` only constructs the generator
   *   object and runs none of this method's body until iteration begins
   *   (mirrors a pre-existing imprecision in `TerraformService.plan`'s own
   *   equivalent doc, fixed here since this method's doc was being rewritten
   *   anyway).
   * @throws A descriptive `Error` if no configuration bucket is configured,
   *   the configuration object doesn't exist, or `configVersionId` is stale
   *   (see above).
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
      this.operationInFlight = null;
    }
  }

  /**
   * Runs `pulumi up` constrained by a previously approved, unexpired plan —
   * `TerraformService.apply`'s successor (task 7.2), replacing the old
   * `TerraformController.apply`'s controller-side gate with a
   * **self-contained** gate this method owns end-to-end (this dispatch's
   * controller ruling: `TerraformController` split the gate across itself
   * and `TerraformService`; `PulumiService.apply` does not — there is no
   * `PulumiController` yet, and this method needs none).
   *
   * ## The 8-step gate, in the exact order the `iac-plan-apply-page` spec
   * requires ("The gate MUST verify, in order: ...")
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
   * 6. Re-verifies the record's hash against reality, in two parts, NEITHER
   *    of which ever parses the on-disk plan artifact as JSON — satisfying
   *    the spec's "the configuration check MUST NOT depend on the plan file
   *    being parseable":
   *    - 6a. The configuration object's CURRENT head version id
   *      (`RemoteFileStore.listVersions`) is compared directly against
   *      `record.tfvarsVersionId` (the version the plan actually ran
   *      against). A mismatch means the configuration has been written
   *      again since the plan was reviewed — throws {@link StalePlanError}
   *      (reused, not reinvented: this is exactly the condition that class
   *      already exists to describe, byte-for-byte the same shape
   *      `TerraformService.pullVarFile`'s pre-existing staleness check
   *      used).
   *    - 6b. The on-disk plan artifact is re-hashed
   *      (`computePlanHash(artifactPath, currentConfigVersionId)` — raw
   *      bytes only, never `JSON.parse`d) and compared against
   *      `record.planHash`. Since 6a already proved the config version is
   *      unchanged, a mismatch here can only mean the artifact's *bytes*
   *      differ from what was hashed at plan time — i.e. the file was
   *      swapped or tampered with since review. Throws
   *      {@link PulumiPlanArtifactStaleError} — a NEW class (7.9's 13 didn't
   *      anticipate this specific byte-tamper case; `StalePlanError`'s shape
   *      is about S3 config-object versions, not artifact bytes, so it does
   *      not fit here) — also thrown, wrapping the read/hash failure as
   *      `cause`, if the artifact can't be read/hashed at all.
   * 7. The plan's stamped `record.engineVersion` (already normalized,
   *    no `v` prefix, by `preview()`/`readEngineVersionFromPlanArtifact`)
   *    is compared against `PulumiEngineService.getResolvedVersion()` —
   *    `this.engine.resolve()` is awaited first to guarantee that accessor
   *    is populated even on a fresh app session where no prior
   *    `preview()`/`up()` call has resolved the engine yet (its own
   *    memoization makes this a no-op, not a re-provision, once already
   *    resolved — e.g. by an earlier `preview()` in the same process).
   *    A mismatch throws {@link PulumiEngineVersionMismatchError}, naming
   *    both versions, satisfying the spec's "an error that names the
   *    version change".
   * 8. **THEN, AND ONLY THEN**: `RunLockService.createRun('apply', initiator, planRunId)`
   *    — task 7.7's atomic compare-and-set, the FINAL and
   *    AUTHORITATIVE step. Steps 1-7 above are pure reads (no
   *    `getWorkspaceInFlight()`-style "is it free" pre-check is performed
   *    anywhere in this method, deliberately — that is exactly the
   *    anti-pattern task 7.7 exists to eliminate); two concurrent `apply()`
   *    calls for the same plan race through steps 1-7 harmlessly and only
   *    ONE of them wins this step's atomic reservation
   *    (`RunService.createRun`'s in-memory check-then-set is synchronous,
   *    before its own first `await`; its DynamoDB layer is a genuine
   *    conditional `PutItem` — both confirmed already atomic, not
   *    reinvented here). The loser's `createRun` call rejects with
   *    `RunLockHeldError` (`@hyveon/shared`), which this method does not
   *    catch or reclassify — it propagates raw, carrying the winning lock's
   *    detail, for a future controller to map onto an ack shaped like
   *    `{ started: false, conflict: 'apply' }`, the same way
   *    `TerraformController.apply` did.
   *
   * ## Fix round 1: the top-of-function `operationInFlight` check was itself
   * the forbidden "preceding workspace-is-free observation"
   *
   * The version of this method a first review round caught: `operationInFlight`
   * was both CHECKED and SET at the very top of the method, before gate step
   * 1 ever ran. That set is exactly the "is the workspace free" observation
   * the `iac-plan-apply-page` spec and task 7.7 both explicitly forbid as the
   * gate — it meant two `apply()` calls in the SAME process (the only
   * concurrency case that matters for a single desktop app) could never both
   * reach step 8 at all: the second was refused immediately, before reading
   * anything, with a generic `Error` rather than `RunLockHeldError`, and the
   * spec's "two simultaneous applies are ordered by the lock" scenario was
   * never actually exercised.
   *
   * The fix: `operationInFlight` is now only ever SET once — synchronously,
   * immediately after `createRun` above resolves (see the re-check
   * immediately below) — never at the top. The top-of-function check
   * (unchanged in shape, just no longer paired with a set) still exists and
   * still matters, but for a narrower, legitimate purpose: refusing an
   * `apply()` call that arrives while a `preview`/`destroy` call, or an
   * `apply` that has ALREADY won its lock and is actively running the
   * engine, is genuinely using the shared local workspace directory
   * (`operationInFlight`'s own doc comment — a concern entirely independent
   * of the durable apply lock, since two Automation API invocations against
   * the same `workDir`/`Pulumi.<stack>.yaml` would corrupt local state
   * regardless of what `RunService` thinks). It can no longer be true that
   * two `apply()` calls both racing through steps 1-7 ever observe each
   * other via this field — only `createRun`'s own atomicity orders them now.
   *
   * `initiator` is resolved internally via {@link resolveInitiator}
   * (`os.userInfo().username`, duplicating `TerraformController.resolveApprover()`'s
   * identical lookup) rather than taken as a parameter — this method is
   * self-contained per the ruling above, and there is no controller yet to
   * resolve it instead.
   *
   * `runId` is always `planRunId` itself (never a fresh `randomUUID()`) —
   * mirrors `TerraformController.apply`'s established precedent ("the
   * applied plan and its apply run record share the same
   * `<runsDir>/<runId>/` lineage"): the plan's own `runId` is reused so the
   * plan artifact, the plan's `run.json`, and the apply's `run.json` all
   * live under one `<runsDir>/<planRunId>/` directory, and so `RunLockService.createRun`'s
   * `runId` parameter *is* the atomic reservation key both task 7.7's gate
   * and the plan/apply lineage need to agree on.
   *
   * ## Nothing is reserved before step 8 — verified, not just asserted
   *
   * `this.beginActiveRun(runId)`, `this.operationInFlight = 'up'` (fix round
   * 1 — see above), and `this.store.recordPulumiLockAttempt(...)` (the
   * DIY-lock ownership record, see below) are ALL called only after step 8's
   * `createRun` has already resolved successfully AND the post-`createRun`
   * local-workspace re-check immediately below has itself passed — reading
   * this method top-to-bottom confirms no side effect precedes the atomic
   * reservation, satisfying task 7.7's "nothing before this point may
   * reserve anything". Gate step 8 is immediately followed by exactly one
   * more check before anything is actually reserved: a re-read of
   * `operationInFlight`, closing the residual TOCTOU gap between the
   * top-of-function check and this point (a `preview`/`destroy` call could
   * have started and set the field during the `await`s gate steps 1-7 took)
   * — mirrors `TerraformController.apply`'s own identical post-`createRun`
   * re-check of `getWorkspaceInFlight()` ("a concurrent plan/init could have
   * reserved the workspace during that gap; this re-check closes it"). If
   * that re-check finds the field already set, the durable lock this call
   * just won is released (`RunLockService.releaseRun`) and the call is
   * refused — nothing was ever reserved from the operator's point of view
   * (no run record, no active-run buffer), so releasing here is simply
   * undoing gate step 8, not a failure-recovery backstop. This re-check can
   * only ever observe `'preview'`/`'destroy'` in practice, never `'up'` from
   * a sibling `apply` — `RunService`'s lock is a single global slot, so two
   * `createRun` calls can never both succeed while either is still held.
   *
   * ## Does `up()` take the DIY backend lock? (confirmed this dispatch)
   *
   * **Yes.** {@link preview}'s own TSDoc ("Does `preview` take the DIY
   * backend lock?") already verified `diyBackend.Preview` calls `b.apply`
   * directly, with no `Lock`/`Unlock` anywhere in that path. The SAME Go
   * source (`pkg/backend/diy/backend.go`) shows `diyBackend.Update` — the
   * path `stack.up()` reaches — wraps its call in
   * `err := b.Lock(ctx, stack.Ref()); defer b.Unlock(ctx, stack.Ref())`
   * before proceeding. This confirms `up` genuinely takes and releases the
   * DIY backend lock around the whole update, and is why (unlike `preview`)
   * this method wires the lock-recovery primitives below.
   *
   * ## Lock-recovery wiring (Phase 4 primitives, wired for real for the
   * first time by this dispatch)
   *
   * Immediately before calling `stack.up()` (never earlier — see "Nothing
   * is reserved before step 8" above), this method records a lock-ownership
   * attempt via `ElectronStoreService.recordPulumiLockAttempt(PULUMI_STACK_NAME)`,
   * keeping the returned attempt id in scope. On every settlement of the
   * wrapped `stack.up()` call EXCEPT {@link PulumiOperationEscalatedError},
   * the attempt is cleared via `clearPulumiLockAttempt` — a normal CLI exit
   * (success, a genuine failure, or a cancellation the CLI itself
   * acknowledged via `SIGINT`) releases its own DIY lock via the backend's
   * own `Unlock()`, so the record is no longer needed as reclaim evidence
   * (mirrors `recordPulumiLockAttempt`'s own doc comment: "Never call
   * [`clearPulumiLockAttempt`] when the operation was forcefully
   * terminated"). An {@link PulumiOperationEscalatedError} settlement is
   * exactly that forceful-termination case — see "Force-close safety net"
   * below for why the record is deliberately left behind on that path.
   *
   * If `stack.up()` itself rejects with a lock conflict
   * (`isStackLockConflict` — `instanceof ConcurrentUpdateError`, or the
   * DIY-backend message pattern as a backstop), the rejection is classified
   * via `PulumiLockRecovery.classifyStackLockConflict`:
   * - `'reclaimable-own-orphan'` — every lock present is provably this
   *   installation's own dead orphan (identity + liveness + time-consistency,
   *   per that function's own TSDoc). Per `PulumiLockRecovery.ts`'s own doc
   *   comment ("Phase 7's caller acts on that classification directly —
   *   calling `stack.cancel()` and retrying — without ever constructing or
   *   throwing an error for it"), this method clears the lock via
   *   `stack.cancel()` and retries `stack.up()` exactly once with the same
   *   options/signal. No operator confirmation is involved — the spec's
   *   "The app MAY reclaim it without prompting" — and this is the FIRST
   *   real exercise of that classification anywhere in the codebase.
   * - `'requires-confirmation'` (anything not provably an own orphan,
   *   including "no locks could even be parsed") — throws
   *   {@link PulumiUnrecognizedLockError} (holder + age already carried on
   *   `locks`, per spec), and this method does NOT clear anything — clearing
   *   an unrecognized lock needs explicit operator confirmation, a later
   *   phase's UI concern.
   *
   * ## Force-close safety net for a wedged engine (investigated this
   * dispatch — the residual gap 7.1's review flagged, now higher-stakes
   * since `up()` holds the real backend lock)
   *
   * `preview()`'s outer `finally` — mirrored here — aborts and awaits its
   * internal operation on a force-closed generator, but that `finally` can
   * only run once the generator's CURRENT suspension point resolves. If the
   * generator is parked mid-drain-loop on its own internal
   * `await new Promise((resolveWait) => { wake = resolveWait })` (not a
   * `yield`) waiting for `stack.up()` to settle, and `stack.up()` is
   * genuinely wedged (ignores `SIGINT`, or is stuck between signal checks in
   * a cloud-provider API call) — `runWithEscalatingCancellation`'s own
   * escalation timer NEVER ARMS, because arming it requires `internalController.abort()`
   * to have already fired, and the only thing that calls that (absent a
   * caller-supplied `signal` that itself aborts) is this method's own outer
   * `finally`. That `finally` cannot run until the pending internal `await`
   * resolves; that `await` cannot resolve until the escalation timer fires;
   * the escalation timer cannot arm until `finally` calls `abort()`. This is
   * a genuine circular dependency — a wedged engine with no caller-supplied
   * `signal` can leave this generator (and its outer `finally`) suspended
   * indefinitely, with the DIY backend lock still held by the CLI
   * subprocess. Fully closing this gap (an unconditional watchdog
   * independent of `.return()` ever being called, or the "unofficial `run`
   * override" `PulumiCancellation.ts`'s TSDoc floats for a real killable
   * process handle) is a larger change than this dispatch takes on — this
   * section documents the finding per the brief's investigation charge,
   * rather than silently leaving it unstated.
   *
   * **The lock-ownership record recorded above IS a sufficient backstop for
   * this exact gap.** `ElectronStoreService.recordPulumiLockAttempt` is a
   * synchronous, already-completed write to `electron-store` made BEFORE
   * `stack.up()` is ever invoked — entirely unaffected by any later hang
   * inside that call. Whether this run's own generator ever gets a chance
   * to run its `finally` again or not, the record survives (in
   * `userData`'s persisted store, on disk) for
   * `PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS` (2 hours) as evidence: once
   * the wedged CLI process eventually exits — by any means: the OS finally
   * delivers `SIGINT`, the operator kills it manually, the app or machine
   * restarts — its PID becomes provably dead, and the NEXT `preview`/`up`/
   * `destroy` attempt against this stack that hits the same DIY lock
   * conflict will have `classifyStackLockConflict` find this run's record,
   * confirm identity (same username/hostname) + liveness (PID now dead) +
   * time-consistency (`startedAt` at or before the stale lock's
   * `lockedAt`), and classify it `'reclaimable-own-orphan'` — reclaiming and
   * proceeding automatically, exactly the same path a fresh `up()` call
   * exercises above. **Yes: the recorded evidence is sufficient for a LATER
   * operation to recognize and reclaim the orphan even when THIS run cannot
   * clean up after itself.**
   *
   * ## Partial-apply detection (this task's headline requirement)
   *
   * `UpResult` itself carries no "was this partial" signal (confirmed
   * against `@pulumi/pulumi/automation/stack.d.ts`'s
   * `{ stdout, stderr, outputs, summary }` shape — `summary.resourceChanges`,
   * when present, is a final tally, not a partial/complete distinction) — this must be
   * inferred from the `onEvent` stream, as the brief's own research
   * anticipated. `onEvent`'s `resOutputsEvent` fires once per resource
   * "finished being provisioned" (confirmed against `events.d.ts` — distinct
   * from `resourcePreEvent`, which fires BEFORE a resource is touched and
   * would over-count in-flight-but-not-yet-complete steps as "applied").
   * Every `resOutputsEvent` whose `metadata.op` is in {@link MUTATING_OP_TYPES}
   * (excludes `'same'`/read/refresh/discard-family no-ops) is accumulated
   * into `completedSteps` as it streams. If `stack.up()` ultimately fails
   * (not aborted, not a leaked-promise-recovered success) and
   * `completedSteps.length > 0`, the failure is wrapped in
   * {@link PulumiPartialApplyError} (carrying `completedSteps`) instead of
   * {@link PulumiUpError} — a clean failure (nothing mutated yet) still gets
   * {@link PulumiUpError}. `PulumiUnrecognizedLockError` is a distinct third
   * shape (the update never even started against the backend — see above)
   * and is thrown as-is, never wrapped in either.
   *
   * ## Terminal-state representation (decision this dispatch)
   *
   * `RunRecord.status`/`PulumiRunRecord.exitCode` stay a closed
   * success/failed/aborted (0/1/null) triple, per the additive
   * `partialApply: true` boolean field (see {@link PulumiRunRecord.partialApply}'s
   * doc comment for why an additive field was chosen over a fourth
   * `RunStatus` value: `RunStatus` is the `status-index` DynamoDB GSI's hash
   * key, and widening a GSI key's value set is a materially bigger,
   * infra-affecting change than this dispatch's scope justifies without
   * explicit sign-off).
   *
   * **`partialApply` is independent of which non-`'success'` `status` the
   * run settled with — fix round 1 correction.** A resource step can have
   * already been applied whether the run subsequently *failed*
   * (`exitCode: 1` → `status: 'failed'`) OR was *aborted* (`exitCode: null`
   * → `status: 'aborted'`, e.g. the operator pressing Cancel mid-`up()` —
   * arguably the single most likely real-world way this system ends up
   * partway through). `partialApply` is computed from whether
   * `completedSteps` is non-empty, gated only on `outcome.kind !== 'success'`
   * (see {@link apply}'s implementation) — never on `status === 'failed'`
   * specifically. **Any
   * consumer (the UI, a future controller, run-history rendering) MUST check
   * `partialApply` directly and MUST NOT gate that check behind
   * `status === 'failed'` first** — doing so silently re-drops the aborted-
   * cancel case this fix round restored, exactly the scenario the spec's
   * "the UI MUST direct the operator to re-plan rather than retry blindly
   * after a partial failure" requirement most needs to catch. The correct
   * check is simply `record.partialApply` on its own — re-plan, don't retry
   * blindly, whenever it's `true` — independent of `record.status`.
   *
   * ## Leaked-promise `recoverResult` (a REAL implementation this time —
   * `preview`'s investigation found nothing needed re-reading; `up` does)
   *
   * If `stack.up()` rejects with the SDK's leaked-promise message
   * (`isLeakedPromiseError`), `PulumiLeakedPromise.ts`'s own TSDoc proves
   * this can only happen after the actual update already succeeded — the
   * update landed in the backend, but the synthetic `UpResult` the SDK would
   * have returned is unrecoverable from the rejected promise itself.
   * `recoverResult` re-reads `stack.outputs()` and `stack.info()` — fresh,
   * independent, read-only calls, per that file's own guidance — to
   * reconstruct a well-typed `UpResult`. `stack.info()`'s `result` field
   * (`UpdateResult`) is checked and a mismatch from `'succeeded'` is logged
   * as a sanity-check WARN, but does not override the recovery — trusting
   * `isLeakedPromiseError`'s proven-sufficient classification, not a second
   * heuristic, per that file's "provably sufficient" section. What does NOT
   * need re-reading: `changeSummary` — the `capturedChangeSummary` this
   * method's own `onEvent` closure already captured (the same mechanism
   * `preview()` uses) survives the leak untouched, since it lives in this
   * method's own local state, not inside the SDK's rejected promise.
   *
   * ## Cache invalidation (hard requirement carried forward from task 7.4's
   * review)
   *
   * On a successful apply — and ONLY then; a failed/aborted/partial apply
   * did not durably change what a fresh `getStackOutputs()` read would
   * report — `ConfigCacheInvalidator.invalidateCache()` (the real
   * `ConfigService.invalidateCache()`, resolved lazily via
   * {@link getConfigCacheInvalidator}) is called. Best-effort: a failure to
   * resolve or call it is logged and swallowed, mirroring
   * `persistRunRecord`'s "never let a side-effect write mask an otherwise-
   * successful apply" policy — without task 7.4's review flagging this,
   * nothing in production would ever call it after a deploy, leaving the
   * dashboard showing "not deployed" indefinitely after the first real
   * apply.
   *
   * ## Cancellation and abort-listener leak (carry-forward fix from 7.1's
   * review)
   *
   * Mirrors {@link preview}'s `internalController`/`operationPromise`
   * cancellation shape exactly (see that method's TSDoc for the full
   * rationale), with 7.1's review fix applied here from the start rather
   * than copied-then-fixed: the `signal.addEventListener('abort', ...)`
   * call below passes `{ once: true }`, so a caller that reuses the same
   * `AbortSignal` across repeated calls (or whose signal fires more than
   * once for any reason) never accumulates more than one live listener per
   * `apply()` invocation — 7.1's review found the original `preview()` omit
   * this, leaking one listener per call. The escalation timer arming on
   * every force-close (even with no caller-supplied `signal`) is kept
   * exactly as 7.1's fix left it — that behaviour was already correct.
   *
   * ## Persistence
   *
   * Once gate step 8 succeeds, every settlement (success, failure, partial
   * failure, or abort) goes through the same
   * `writeRunLog`/`endActiveRun`/`writeRunRecord`/`persistRunRecord`
   * sequence {@link preview} uses — `kind: 'apply'`, `tfvarsVersionId`/
   * `planHash`/`engineVersion` passed through from the validated plan
   * record (not re-derived), plus the new `partialApply` indicator. As
   * documented on {@link persistRunRecord}, `RunRecordService.persist`'s own
   * `finally` releases the durable apply lock gate step 8 acquired — no
   * separate `RunLockService.releaseRun` call is made by this method itself,
   * on any path, mirroring `TerraformService.apply`'s identical reliance on
   * that release happening one layer down. A gate failure (steps 1-7) never
   * reaches this point at all — `runId` is only ever assigned after step 8
   * succeeds, so a rejected gate call writes no run record and holds no
   * lock to release, exactly like the plan-hash gate's pre-migration
   * controller-side rejection wrote nothing either.
   *
   * @param planRunId - The `runId` of the approved `plan` run to apply — also
   *   reused, unchanged, as this apply run's own `runId` (see "run id"
   *   above).
   * @param planHash - The plan hash the caller expects this plan run to
   *   still carry (gate step 5) — normally the same value the originating
   *   `preview()` call returned.
   * @param signal - Optional cancellation signal — see "Cancellation" above.
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
    // below, fix round 1) so an `apply()` call arriving while a `preview`/
    // `destroy`/already-lock-won `apply` is genuinely running the engine is
    // refused immediately, without wasting a gate read that would lose
    // anyway. Deliberately does NOT gate two applies racing for the SAME
    // (or different) plan: those must both reach gate step 8 and be ordered
    // by `RunLockService.createRun`'s own atomicity, never by this
    // observation — see this method's TSDoc, "Nothing is reserved before
    // step 8", for the fix-round-1 finding that setting this field here
    // (as this method originally did) was exactly the forbidden "preceding
    // workspace-is-free observation" the `iac-plan-apply-page` spec and
    // task 7.7 both explicitly rule out as the gate.
    if (this.operationInFlight) {
      throw new Error(
        `PulumiService.apply() cannot run while ${this.operationInFlight}() is already ` +
          'running; wait for it to finish before calling apply() again.',
      );
    }
    PulumiService.assertValidRunId(planRunId);
    // Hoisted above the try block — mirrors preview()'s identical hoist and
    // rationale: a force-closed generator unwinds straight to the outer
    // `finally`, which needs to see these regardless of how far the gate/
    // operation got.
    let runId: string | undefined;
    let startedAt: string | undefined;
    let runRecordWritten = false;
    // `true` only once THIS invocation has itself set `operationInFlight`
    // (post gate-step-8, see below) — gates the outer `finally`'s reset so a
    // gate failure that never touched the field can never null out some
    // OTHER concurrently-running operation's own flag (fix round 1: with the
    // top check above no longer also setting the field, a failing gate call
    // can reach the outer `finally` having never touched `operationInFlight`
    // at all, while a genuinely unrelated `preview`/`destroy` call is live).
    let ownsOperationInFlight = false;
    // `true` once a call that genuinely attempted to release the durable
    // apply lock has completed — set after the NORMAL-path `persistRunRecord`
    // call (whose own `RunRecordService.persist` releases the lock in its
    // own `finally`) and after the force-close fallback's equivalent call.
    // Fix round 2: gates the outer `finally`'s unconditional backstop
    // `releaseRun` call (see below) so it does NOT also fire on every
    // ordinary successful apply — `RunService.releaseRun` awaits
    // `ConfigService.getStackOutputs()`, which the just-run
    // `invalidateCache()` call (on the success path) guarantees will MISS
    // its cache and re-invoke `PulumiService.getStackOutputs()` — two more
    // real `pulumi` CLI subprocess spawns (`stack select` + `stack output`)
    // on the hot path of every successful apply, delaying the generator's
    // final settlement for no reason (the lock was already correctly
    // released moments earlier). The backstop is only ever actually needed
    // on the ONE path this flag stays `false` for: `writeRunRecord` itself
    // throwing, which skips `persistRunRecord` entirely (see the backstop's
    // own comment).
    let lockReleased = false;
    // The gate-validated tfvarsVersionId/engineVersion, hoisted the instant
    // the plan record is fetched (well before the lock is acquired) so the
    // outer `finally`'s force-closed fallback can still thread them through
    // its own best-effort run-record write — mirrors why `runId`/`startedAt`
    // are hoisted, just for record-persistence completeness rather than
    // control flow.
    let tfvarsVersionId: string | undefined;
    let engineVersion: string | undefined;
    // Hoisted (fix round 1) so the outer `finally`'s force-closed fallback
    // can persist real changeSummary/partial-apply data instead of nothing —
    // see this method's TSDoc, "Partial-apply detection", for why this must
    // be visible on every settlement path, not only a clean `outcome.kind
    // === 'failed'`.
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
    // every exit path, not only once it fires — fix round 1: `{ once: true }`
    // alone (round 0's fix) only detaches the listener once `signal` itself
    // aborts; on the overwhelmingly common path (the caller's signal never
    // aborts at all), the listener stayed attached for the signal's entire
    // lifetime, so a caller reusing one long-lived `AbortSignal` across many
    // `apply()` calls still accumulated one listener per call — the exact
    // leak the brief asked to fix, which `{ once: true }` alone does not.
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

      // --- Gate step 8: THE atomic, authoritative reservation (task 7.7) ---
      // No "is the workspace free" pre-check precedes this call — see this
      // method's TSDoc for why that would reintroduce exactly the
      // TOCTOU race task 7.7 exists to eliminate. A losing race rejects with
      // RunLockHeldError, propagated unwrapped.
      const initiator = PulumiService.resolveInitiator();
      await this.getRunLockService().createRun('apply', initiator, planRunId);

      // Re-check the shared local-workspace guard now that this call has
      // crossed the only genuinely async gap since the top-of-function
      // check — mirrors `TerraformController.apply`'s identical
      // post-`createRun` recheck ("a concurrent plan/init could have
      // reserved the workspace during that gap; this re-check closes it").
      // Fix round 1: this closes the apply-vs-`preview`/`destroy` race the
      // top-of-function check alone can no longer close by itself now that
      // it no longer also SETS the field — `preview`/`destroy` never touch
      // `RunLockService` at all, so only this in-process flag can order them
      // against an apply that has already won the durable lock. Apply-vs-
      // apply is NEVER decided here — that race is already fully resolved by
      // `createRun`'s own atomicity above; this check can only ever observe
      // `'preview'`/`'destroy'` (never `'up'` from a sibling apply, since
      // `RunService`'s lock is a single global slot — two `createRun` calls
      // can never both succeed while either is still held).
      if (this.operationInFlight) {
        const inFlight = this.operationInFlight;
        // Release the durable lock this call just won — nothing has been
        // reserved from the operator's point of view yet (no run record, no
        // active-run buffer, no `startedAt`), so releasing here is the
        // correct undo of gate step 8, not a backstop for a later failure.
        // Fix round 2: wrapped in try/catch, consistent with the outer
        // `finally`'s own backstop `releaseRun` call — `RunService.releaseRun`
        // is documented to never throw (low severity either way), but a
        // rejection here must not replace this method's own descriptive
        // refusal error (and skip the durable-lock delete this branch exists
        // to guarantee) with whatever `releaseRun` itself rejected with.
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
      // population semantics from the CLI were not independently verified
      // this dispatch, unlike `PreviewResult.changeSummary`).
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

        // Lock-recovery wiring (task 4.8's primitives, wired for real for
        // the first time) — recorded immediately before the call that can
        // actually take the DIY backend lock, never earlier. See TSDoc
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
      // comment (fix round 2) for the liveness bug this specifically
      // avoids.
      lockReleased = true;

      if (outcome.kind === 'success') {
        // Cache invalidation — hard requirement carried forward from task
        // 7.4's review (see TSDoc). Best-effort: never let this mask an
        // otherwise-successful apply.
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
      // Fix round 1: unconditionally detach the internal-controller abort
      // listener — `{ once: true }` alone only removes it once `signal`
      // itself fires; on the overwhelmingly common path (the caller's
      // signal never aborts across a normal completion), it stayed attached
      // for the signal's whole lifetime, so a caller reusing one long-lived
      // `AbortSignal` across many `apply()` calls accumulated one listener
      // per call. Safe/idempotent to call even when the listener already
      // detached itself (a `{ once: true }` listener that already fired).
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
        // Fix round 1: threads `capturedChangeSummary`/a `completedSteps`-derived
        // `partialApply` through this fallback write too (both now hoisted
        // above the outer `try` for exactly this reason) — a force-closed
        // apply that had already applied a mutating resource step is just as
        // much a partial apply as one that settled through the normal path
        // below; the fallback write previously discarded both signals
        // entirely. `planHash` (the parameter, not `record.planHash` — `record`
        // is block-scoped to the gate above and unreachable here) is threaded
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

      // Reset the LOCAL in-process mutex BEFORE the (rare, best-effort)
      // durable-lock backstop below, not after — fix round 2 hardening: the
      // backstop's own `await` (a real network round-trip through
      // `RunService.releaseRun` → `ConfigService.getStackOutputs()`) has no
      // bearing on the shared workspace directory this flag actually guards
      // (nothing further touches `workDir` after this point on any path),
      // so there is no reason a slow or wedged backstop call should also
      // block a brand-new `preview`/`apply`/`destroy` call on this same
      // instance from starting. Gated on `ownsOperationInFlight` rather than
      // unconditional — see that variable's own doc comment for why an
      // unconditional reset here would risk nulling out a concurrently
      // running, unrelated `preview`/`destroy` call's own flag on a path
      // where THIS `apply()` call's gate failed before ever touching the
      // field itself (now possible since the top-of-function check no
      // longer also sets it — see "Nothing is reserved before step 8").
      if (ownsOperationInFlight) {
        this.operationInFlight = null;
      }

      // Fix round 2: skipped entirely once `lockReleased` is already `true`
      // — the overwhelmingly common case, since every ordinary successful or
      // cleanly-failed apply already released the lock via `persistRunRecord`
      // (or its force-close-fallback equivalent) moments earlier. Firing
      // this UNCONDITIONALLY on every apply, as round 1's own fix first did,
      // was itself a regression: `RunService.releaseRun` awaits
      // `ConfigService.getStackOutputs()`, and on the success path the
      // `invalidateCache()` call above guarantees that read MISSES its cache
      // and re-invokes `PulumiService.getStackOutputs()` — two more real
      // `pulumi` CLI subprocess spawns (`stack select` + `stack output`)
      // delaying the generator's final settlement on every single successful
      // apply, for a release that had already happened moments before.
      // Reserved now for the ONE path it's actually needed — `writeRunRecord`
      // itself throwing, which skips `persistRunRecord` on the NORMAL
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
   * Reads and parses the persisted plan artifact's top-level `manifest.version`
   * field (e.g. `"v3.255.0"`) and strips a leading `v`, if present, before
   * returning — see {@link preview}'s TSDoc, "Engine-version stamping", for
   * why normalizing here (once, at write time) rather than leaving the
   * caller-facing format mismatch against `PulumiEngineService.getResolvedVersion()`'s
   * own un-prefixed shape for task 7.2 to rediscover.
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
   * artifact's bytes AND the deployment-config object's S3 version id the
   * plan ran against — task 7.5's hash-computation half (the full
   * staleness-refusal logic that re-derives and compares this hash is task
   * 7.2's job).
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
   * A concatenation (rather than a hash-of-hashes, e.g.
   * `sha256(sha256(artifact) + sha256(configVersionId))`) was chosen because
   * it needs no second hash primitive and is trivially re-derivable by task
   * 7.2's apply-time verification: read the artifact bytes off disk, append
   * the UTF-8 bytes of the config version id the run record has on file,
   * hash once — exactly what this method does. No separator byte is
   * inserted between the two parts; this is safe (does not introduce an
   * ambiguity where two different `(artifact, versionId)` pairs could
   * collide on the same concatenated input) because neither input is
   * attacker- or operator-influenced in a way that matters here: the
   * artifact is a JSON file this app itself just wrote, and `configVersionId`
   * is an opaque S3-assigned version id — there is no scenario where varying
   * the split point between the two produces a meaningful second
   * interpretation of the same bytes.
   *
   * The engine version does NOT participate in this hash — see
   * {@link preview}'s TSDoc, "Engine-version stamping", for why it's a
   * separate stored field instead.
   *
   * Public (rather than `private`) — mirrors `TerraformService.computePlanHash`'s
   * own public visibility — so a future apply-time re-verification (task
   * 7.2, mirroring `TerraformController.apply`'s pre-flight re-hash of the
   * on-disk `.tfplan`) can re-read and re-hash the on-disk artifact directly,
   * rather than trusting the stored `planHash` alone to prove the artifact
   * on disk hasn't been swapped or tampered with.
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
   * `TerraformService.writeRunRecord` exactly, plus the `changeSummary`/
   * `engineVersion` parameters (task 7.1) and `partialApply` (task 7.2 —
   * see {@link PulumiRunRecord.partialApply}'s doc comment).
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
   * (env override, then `ElectronStoreService`'s `bootstrap.configurationBucket`)
   * rather than injecting `ConfigService` — `PulumiService` cannot depend on
   * `ConfigService` at all: `ConfigService.getStackOutputs()` (task 7.4)
   * already depends on `PulumiService`, so the reverse dependency would be a
   * genuine circular import between the two service *class* files (not just
   * a `forwardRef()`-able Nest module cycle — see `RUN_RECORD_PERSISTER`'s
   * doc comment for the same reasoning applied to `RunRecordService`).
   * Duplicating this one small accessor mirrors the established precedent
   * `PulumiWorkspaceService`/`PulumiEngineService` already set for
   * `resolveUserDataPath()` (see either class's own doc comment for the
   * identical rationale).
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
   * **Known gap, not this dispatch's to close:** per `lambdas.ts`'s own doc
   * comment, the packaged-app branch above is NOT actually satisfiable
   * today — `app/packages/lambda/*\/dist/**` is not in `electron-builder.yml`'s
   * `files:`/`extraResources:` list (only `out/**` and the pinned
   * `node_modules/**` closures are). That file's doc comment explicitly
   * assigns this to "Phase 7's `PulumiService`" as a follow-up
   * `electron-builder.yml` change — a packaging/build-config concern, not
   * orchestration logic, and out of scope for implementing `preview()`
   * itself. This method resolves the path faithfully either way; making the
   * packaged build actually find a file there is tracked separately.
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
 * Thrown by `TerraformService.apply`'s successor (task 7.2, `PulumiService.apply`)
 * when the Automation API's `stack.up()` call throws and the failure is a
 * clean (non-partial) failure. Ports `TerraformApplyError`'s role, reshaped
 * the same way as {@link PulumiPreviewError} — see its doc comment for why
 * `cause` replaces `exitCode`. Distinct from {@link PulumiPartialApplyError},
 * which task 7.2 throws instead when the divergence happened partway
 * through applying resources rather than before any resource was touched.
 */
export class PulumiUpError extends Error {
  constructor(public readonly cause: unknown) {
    super(`pulumi up failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PulumiUpError';
  }
}

/**
 * Thrown by `TerraformService.destroy`'s successor (task 7.3,
 * `PulumiService.destroy`) when the Automation API's `stack.destroy()` call
 * throws. Ports `TerraformDestroyError`'s role, reshaped the same way as
 * {@link PulumiPreviewError} — see its doc comment for why `cause` replaces
 * `exitCode`.
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
 * {@link PulumiPartialApplyError} so a caller (or the run-history UI, task
 * 9.3) can show exactly what already changed before the failure, rather than
 * only "the apply failed".
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
 * Thrown by task 7.2's `PulumiService.apply` when `stack.up()` fails AFTER at
 * least one resource step has already been applied — i.e. the stack is now
 * in a state between its old and new desired states, distinct from a clean
 * failure ({@link PulumiUpError}) where nothing was touched before the
 * divergence. New in this dispatch (task 7.9's "adding ... partial-apply
 * errors"): `TerraformService.ts` had no equivalent, since a failed
 * `terraform apply` process's partial-resource-state is only ever visible by
 * re-reading `terraform show`, not surfaced as a distinguishable outcome by
 * the CLI itself.
 *
 * `completedSteps` is populated from whatever `StepEventMetadata` the
 * `onEvent` callback observed before the failure (see
 * {@link PulumiPartialApplyStep}) — this is the full per-resource fidelity
 * the SDK's event stream exposes (confirmed against
 * `@pulumi/pulumi/automation/events.js`), so task 7.2 is expected to
 * populate it fully rather than falling back to an empty array; an empty
 * array here would still be a truthful (if less useful) "apply failed
 * partway through, no completed-step detail available" signal if a future
 * caller ever constructs one without wiring up the event listener.
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
 * exists at all for the supplied `planRunId`. New this dispatch (task
 * 7.2) — none of the 13 error classes task 7.9 ported/reshaped cover this
 * case; `RunRecordService`'s own `RunRecordNotFoundError` exists but is
 * scoped to `approveRun`'s call site, not `apply`'s gate, so a distinct
 * class is added here following this file's `Pulumi*Error` house style.
 */
export class PulumiPlanRunNotFoundError extends Error {
  constructor(public readonly planRunId: string) {
    super(`No plan run found for planRunId "${planRunId}" — cannot apply.`);
    this.name = 'PulumiPlanRunNotFoundError';
  }
}

/**
 * Thrown by {@link PulumiService.apply}'s gate (step 2) when the run record
 * found for `planRunId` is not a `'plan'`-kind record. New this dispatch —
 * see {@link PulumiPlanRunNotFoundError}'s doc comment for why a new class
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
 * `approvedBy`/`approvedAt` are not both set. New this dispatch — mirrors
 * the pre-migration `TerraformController.apply`'s equivalent (previously an
 * un-typed string, never a class), now given a proper typed error since
 * `apply` is self-contained and has no controller to compose the message at
 * the call site instead.
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
 * (`@hyveon/shared/runs.js`, `isApprovalExpired`) of `approvedAt`. New this
 * dispatch — see {@link PulumiPlanNotApprovedError}'s doc comment for why a
 * typed class now exists where the pre-migration controller used a bare
 * string.
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
 * New this dispatch — see {@link PulumiPlanNotApprovedError}'s doc comment
 * for why a typed class now exists where the pre-migration controller used
 * a bare string.
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
 * `cause`, if the artifact can't even be read/hashed. New this dispatch:
 * none of task 7.9's 13 ported/reshaped classes fit this byte-level
 * tamper-detection case — {@link StalePlanError}'s shape
 * (`key`/`bucket`/`expectedVersionId`/`actualVersionId`) describes an S3
 * config-object version mismatch, not an artifact-bytes mismatch, so
 * reusing it here would misdescribe the failure.
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
 * carried and included in the message. New this dispatch: none of task
 * 7.9's 13 classes anticipated an engine-version comparison (task 7.1, the
 * dispatch immediately before 7.9's "13 classes" survey, hadn't yet added
 * `engineVersion` stamping when 7.9 ran its triage), so a new class is
 * added here following this file's `Pulumi*Error` house style.
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
 * hashed (or its `manifest.version` read — see {@link PulumiService.readEngineVersionFromPlanArtifact})
 * after a successful `stack.preview()` call. Renamed (task 7.1, as the first
 * real caller) from `TerraformService.ts`'s `TerraformPlanHashError` — the
 * prior dispatch (7.9) ported it byte-for-byte under its original name as a
 * placeholder, ledgering the rename to whichever dispatch actually used it;
 * this is that dispatch. Updated in what it hashes: the saved Pulumi
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
 * (no operation-specific `result` payload) — task 7.9 must not invent the
 * still-unbuilt `PulumiPreviewResult`/`PulumiUpResult`/`PulumiDestroyResult`
 * shapes tasks 7.1-7.3 own; this only carries what
 * {@link PulumiRunPersistError.describeOutcome} actually needs to render a
 * message (`kind`, and the failure's `error` when `kind === 'failed'`).
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
 * Thrown by `TerraformService.destroy`'s successor when it's called without
 * a fresh, valid confirmation token. Ported from `TerraformService.ts`'s
 * `DestroyNotConfirmedError` with its message text re-termed for Pulumi
 * nouns ("pulumi destroy" for "terraform destroy",
 * "PulumiService.mintDestroyConfirmationToken()" for the `TerraformService`
 * equivalent) — the confirmation-token gate itself (task 7.3's "behind the
 * existing confirmation-token gate") is unaffected by the engine swap; only
 * the mint/consume call sites move.
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
 * Thrown by the rollback flow's successor (task 7.6) when no run record
 * exists for the given `applyRunId`. Ported byte-for-byte from
 * `TerraformService.ts`'s `RollbackTargetNotFoundError`.
 */
export class RollbackTargetNotFoundError extends Error {
  constructor(public readonly applyRunId: string) {
    super(`No run record found for apply run "${applyRunId}" — cannot roll it back.`);
    this.name = 'RollbackTargetNotFoundError';
  }
}

/**
 * Thrown by the rollback flow's successor (task 7.6) when the run record
 * found for `applyRunId` isn't an `apply` run. Ported byte-for-byte from
 * `TerraformService.ts`'s `RollbackNotApplyRunError`.
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
 * Thrown by the rollback flow's successor (task 7.6) when the target apply
 * run has no recorded configuration-object version id — there's no version
 * history to roll back against.
 *
 * Renamed from `TerraformService.ts`'s `RollbackNoTfvarsVersionError` — task
 * 7.9's brief explicitly floated this rename, and it's taken here: Phase 6
 * ("Configuration persisted as versioned JSON") already retired "tfvars" as
 * the noun for the configuration store everywhere except the one field this
 * class describes. That field, `RunRecord.tfvarsVersionId`, is intentionally
 * NOT renamed by task 7.8 — it's out of that task's stated scope — so this
 * class's name and the field it describes now use different terminology on
 * purpose; a future dispatch that does rename the field should rename this
 * class's doc comment's cross-reference too.
 */
export class RollbackNoConfigVersionError extends Error {
  constructor(public readonly applyRunId: string) {
    super(`Apply run "${applyRunId}" has no recorded configuration version id — nothing to roll back.`);
    this.name = 'RollbackNoConfigVersionError';
  }
}

/**
 * Thrown by the rollback flow's successor (task 7.6) when the historic
 * configuration version a rollback would restore no longer exists. Ported
 * from `TerraformService.ts`'s `RollbackVersionMissingError` with its
 * message text re-termed for config-object nouns ("configuration version"
 * for "tfvars version") — the shape (`versionId`) is unchanged.
 */
export class RollbackVersionMissingError extends Error {
  constructor(public readonly versionId: string) {
    super(
      `Historic configuration version "${versionId}" no longer exists — it may have expired. Nothing was written.`,
    );
    this.name = 'RollbackVersionMissingError';
  }
}
