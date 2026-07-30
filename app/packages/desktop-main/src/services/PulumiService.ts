import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EngineEvent, OutputMap, PreviewResult } from '@pulumi/pulumi/automation/index.js';
import { createInfraProgram } from '@hyveon/infra';
import { CONFIGURATION_OBJECT_KEY } from '@hyveon/shared';
import type { ChangeSummary, DeploymentConfig, OpType, RemoteFileStore, RunKind, StackOutputs } from '@hyveon/shared';
import { logger } from '../logger.js';
import { REMOTE_FILE_STORE } from '../modules/cloud-provider.tokens.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { PulumiWorkspaceService } from './PulumiWorkspaceService.js';
import {
  PulumiOperationAbortedError,
  PulumiOperationEscalatedError,
  PulumiOperationNotStartedError,
  runWithEscalatingCancellation,
} from './PulumiCancellation.js';
import { runTreatingLeakedPromiseAsSuccess } from './PulumiLeakedPromise.js';
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
 * (and, later, `.up`/`.destroy`) depends on — persisting a finished run to
 * the cloud-agnostic run-history store (DynamoDB for AWS) alongside the
 * captured log transcript. Structurally identical to `RunRecordService.persist`'s
 * own signature; kept as a separate interface (rather than importing
 * `RunRecordService` as a type and referencing it directly) purely so
 * nothing in this file ever needs `RunRecordService` as a value — see
 * {@link RUN_RECORD_PERSISTER}'s doc comment.
 */
export interface RunRecordPersister {
  persist(params: PersistRunRecordParams, logFilePath: string | null): Promise<void>;
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
}

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
   * since task 7.4. `moduleRef` is `preview`'s (task 7.1) route to
   * `RUN_RECORD_PERSISTER` (the DynamoDB run-history write path) and
   * `REMOTE_FILE_STORE` (the cloud-agnostic config-object store) — see
   * {@link getRunRecordPersister}/{@link getRemoteFileStore} for why these
   * are resolved lazily via `ModuleRef.get(token, { strict: false })` at
   * call time rather than taken as ordinary constructor-injected
   * dependencies: `pulumi-service.module.ts`'s own doc comment has the full
   * story (a `forwardRef()`-guarded static import cycle was tried first and
   * empirically deadlocks this project's native-ESM module graph at boot).
   * `ModuleRef` itself is a core Nest primitive with no relation to any
   * module in that cycle, so injecting it creates no new edge at all.
   */
  constructor(
    private readonly workspace: PulumiWorkspaceService,
    private readonly store: ElectronStoreService,
    private readonly moduleRef: ModuleRef,
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
   * `TerraformService.writeRunRecord` exactly, plus the new `changeSummary`/
   * `engineVersion` parameters (task 7.1).
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
   * never throws, logged and swallowed on failure" contract.
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
  ): Promise<void> {
    try {
      await this.getRunRecordPersister().persist(
        { runId, kind, startedAt, completedAt, exitCode, tfvarsVersionId, planHash, rolledBackFrom, changeSummary, engineVersion },
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
 * Thrown by `TerraformService.apply`'s successor (task 7.2, `PulumiService.up`)
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
 * Thrown by task 7.2's `PulumiService.up` when `stack.up()` fails AFTER at
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
