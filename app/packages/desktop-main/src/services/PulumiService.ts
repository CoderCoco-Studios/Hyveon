import { Injectable } from '@nestjs/common';
import type { OutputMap } from '@pulumi/pulumi/automation/index.js';
import type { OpType, StackOutputs } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { PulumiBackendNotBootstrappedError, PulumiWorkspaceService } from './PulumiWorkspaceService.js';

/**
 * Phase 7 (`migrate-iac-to-pulumi`) service replacing `TerraformService.ts`.
 *
 * This dispatch (tasks 7.4/7.8/7.9) adds ONLY the foundational pieces every
 * later Phase-7 dispatch needs: the typed error classes ported from
 * `TerraformService.ts` (below), and {@link getStackOutputs} — the async
 * stack-outputs read replacing `ConfigService.getTfOutputs()`. It does
 * **not** implement `preview`/`up`/`destroy` (tasks 7.1-7.3) — those, plus
 * the plan-hash gate (7.5) and rollback (7.6), are separate dispatches that
 * add methods to this same class.
 *
 * ## Error-class file organization (task 7.9)
 *
 * All 13 error classes `TerraformService.ts` declared were triaged (see
 * `task-7.4-7.8-7.9-brief.md` for the full per-class verdict table this
 * follows) into: 2 DROPPED (`TerraformNotFoundError`, `TerraformInitError` —
 * no Pulumi analogue, since `PulumiEngineService` auto-installs and there is
 * no separate init step), 6 ported byte-for-byte under their ORIGINAL name
 * (`StalePlanError`, `TerraformPlanHashError`, `DestroyNotConfirmedError`,
 * `RollbackTargetNotFoundError`, `RollbackNotApplyRunError`,
 * `RollbackVersionMissingError` — each is about S3 config-object versioning
 * or the destroy confirmation-token gate, concepts the engine swap doesn't
 * touch), 1 ported AND renamed for terminology (`RollbackNoTfvarsVersionError`
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
 */
@Injectable()
export class PulumiService {
  constructor(
    private readonly workspace: PulumiWorkspaceService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Reads every value the app cares about off the deployed Pulumi stack,
   * replacing `ConfigService.getTfOutputs()`'s parse of `terraform.tfstate`.
   * Returns `null` — NEVER throws — for a never-deployed stack, mirroring
   * `getTfOutputs()`'s existing "not deployed yet" contract; see
   * `StackOutputs`'s own doc comment.
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
   * Only once all three hold does this call
   * {@link PulumiWorkspaceService.getOrCreateStack} (with `stackExists: true`,
   * `backendReady: true`, and a no-op `program` — reading `stack.outputs()`
   * never invokes the program; see below) and `stack.outputs()`. A
   * {@link PulumiBackendNotBootstrappedError} thrown from that call (the
   * bucket was deleted between the check above and this call) is also
   * treated as "not deployed" rather than propagated, for the same
   * graceful-degrade contract; every other error propagates unchanged.
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
      if (err instanceof PulumiBackendNotBootstrappedError) {
        return null;
      }
      throw err;
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
}

/**
 * Thrown by a future `PulumiService.preview` (task 7.1) when the Automation
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
 * current head version no longer matches it. Ported byte-for-byte from
 * `TerraformService.ts`'s `StalePlanError` — purely about the S3
 * config-object head version, entirely unaffected by the engine swap.
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
 * Thrown by `TerraformService.plan`'s successor when the saved-plan artifact
 * can't be hashed after a successful `preview()`. Ported byte-for-byte from
 * `TerraformService.ts`'s `TerraformPlanHashError`, updated only in what it
 * hashes: the saved Pulumi update-plan file (task 7.1's "saving the update
 * plan as a run artifact"), not a `.tfplan` binary.
 */
export class TerraformPlanHashError extends Error {
  constructor(
    public readonly runId: string,
    public readonly artifactPath: string,
    public readonly cause: unknown,
  ) {
    super(
      `Failed to compute SHA-256 hash of plan artifact "${artifactPath}" for run "${runId}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'TerraformPlanHashError';
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
 * a fresh, valid confirmation token. Ported byte-for-byte from
 * `TerraformService.ts`'s `DestroyNotConfirmedError` — the confirmation-token
 * gate itself (task 7.3's "behind the existing confirmation-token gate") is
 * unaffected by the engine swap; only the mint/consume call sites move.
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
    public readonly kind: string,
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
 * byte-for-byte from `TerraformService.ts`'s `RollbackVersionMissingError`.
 */
export class RollbackVersionMissingError extends Error {
  constructor(public readonly versionId: string) {
    super(
      `Historic configuration version "${versionId}" no longer exists — it may have expired. Nothing was written.`,
    );
    this.name = 'RollbackVersionMissingError';
  }
}
