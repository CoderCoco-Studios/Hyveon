import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { DEPLOYMENT_CONFIG_DEFAULTS, resolveRunsTableName } from '@hyveon/shared';
import {
  AwsProfileService,
  type AwsProfileSummary,
  type SavePastedCredentialsInput,
} from '../services/AwsProfileService.js';
import { BootstrapService, type BootstrapResult } from '../services/BootstrapService.js';
import { IamCheckService, type IamCheckResult } from '../services/IamCheckService.js';
import { FirstRunWizardService, type WizardProgress, type WizardStepName } from '../services/FirstRunWizardService.js';
import {
  GuidedIamService,
  type RenderedTemplateResult,
  type OpenConsoleResult,
  type BootstrapKeyIntakeInput,
  type BootstrapKeyIntakeResult,
  type RotationInput,
  type RotationResult,
  type RevokeBootstrapKeyInput,
  type RevokeBootstrapKeyResult,
} from '../services/GuidedIamService.js';
import { ElectronStoreService } from '../services/ElectronStoreService.js';

/** Payload accepted by {@link WizardController.bootstrapStateBucket}. */
export interface BootstrapStateBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link WizardController.bootstrapConfigurationBucket}. */
export interface BootstrapConfigurationBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link WizardController.bootstrapDeploymentConfig}. */
export interface BootstrapDeploymentConfigInput {
  bucketName: string;
}

/** Payload accepted by {@link WizardController.saveProgress}. */
export interface SaveWizardProgressInput {
  step: WizardStepName;
  /** See {@link WizardProgress.guidedIam}. */
  guidedIam?: WizardProgress['guidedIam'];
}

/** Payload accepted by {@link WizardController.openGuidedIamConsole}. */
export interface OpenGuidedIamConsoleInput {
  region: string;
}

/**
 * The credentials step's chosen source, as persisted to `ElectronStoreService.aws`.
 * `profile` names either a real `~/.aws` profile (the "pick an existing
 * profile" path) or a `creds.aws.<profileName>` pasted-credentials entry
 * (the "paste keys instead" path, e.g. `hyveon-pasted`) — the two are
 * distinguished later by whether `creds.aws.<profile>` exists, not by a
 * separate flag here.
 */
export interface WizardAwsChoice {
  profile?: string;
  region?: string;
}

/**
 * The bootstrap step's last-submitted resource names, as persisted to
 * `ElectronStoreService.bootstrap`. Names are operator-editable, so Settings'
 * Reconfigure flow (#211) needs these on record to run bootstrap again
 * against the resources that actually exist rather than
 * `defaultBootstrapResourceNames()`.
 *
 * @remarks
 * `PulumiService.initializeStack` resolves its own state bucket/region
 * internally and needs no lock-table name, so this shape carries no
 * `lockTable` field — bootstrap doesn't create a lock-table resource.
 */
export interface WizardBootstrapNames {
  stateBucket: string;
  configurationBucket: string;
}

/** Minimal wizard-progress summary the renderer needs to decide whether to show the wizard route. */
export interface WizardState {
  wizardCompleted: boolean;
  /** The cloud chosen in the pick-cloud step. Locked to `'aws'` for v1; `undefined` before that step runs. */
  activeCloud?: 'aws';
  /** The credential source chosen in the credentials step (#192), if any. */
  aws?: WizardAwsChoice;
  /** The bootstrap step's last-submitted resource names, if any. */
  bootstrap?: WizardBootstrapNames;
}

/** Payload accepted by {@link WizardController.saveState}. */
export interface SaveWizardStateInput {
  activeCloud?: 'aws';
  aws?: WizardAwsChoice;
  bootstrap?: WizardBootstrapNames;
}

/**
 * IPC-only controller for the first-run wizard (see
 * `openspec/changes/add-first-run-wizard`). Every handler is a plain
 * request/response `@MessagePattern` — no HTTP routes, and no streaming
 * side-channels of its own (the wizard's one streaming step reuses the
 * already-shipped `terraform.init` channel instead of adding a second one
 * here).
 */
@Controller()
export class WizardController {
  constructor(
    private readonly awsProfiles: AwsProfileService,
    private readonly store: ElectronStoreService,
    private readonly bootstrap: BootstrapService,
    private readonly iamCheck: IamCheckService,
    private readonly firstRunWizard: FirstRunWizardService,
    private readonly guidedIam: GuidedIamService,
  ) {}

  /**
   * Returns the wizard's completion flag so the renderer can gate the app
   * router. Defaults to `false` (unset in a fresh `electron-store`, meaning
   * the wizard hasn't run yet) — except under the `HYVEON_TEST_MODE` e2e
   * test seam, where an unset value defaults to `true` instead.
   *
   * @remarks
   * The Electron e2e specs that land on the dashboard (`dashboard`, `costs`,
   * `logs`, `discord`, `terraform`) launch the real packaged app and don't
   * register a `wizard.state.get` mock (most seed their own IPC responses
   * inline per test, not through the shared `applyHyveonMocks` helper), so a
   * `false` default here would route every one of them into the wizard
   * instead of the dashboard they're actually testing. Defaulting to
   * `true` under test mode avoids retrofitting every existing spec; a
   * future spec that *does* want to exercise the wizard flow itself can
   * still override this via `window.hyveon.__test.mock('wizard.state.get', ...)`
   * — the mock registry is consulted before this controller is ever reached.
   * This is a plain read of `ElectronStoreService` either way — the fuller
   * resumable step-progress state (`userData/wizard-state.json`, owned by
   * `FirstRunWizardService`) is exposed separately via `wizard.progress.get`.
   */
  @MessagePattern('wizard.state.get')
  getState(): WizardState {
    const stored = this.store.get('wizardCompleted');
    const wizardCompleted = stored !== undefined ? stored : this.isTestMode();
    return {
      wizardCompleted,
      activeCloud: this.store.get('activeCloud'),
      aws: this.store.get('aws'),
      bootstrap: this.store.get('bootstrap'),
    };
  }

  /**
   * Persists wizard-flow answers into `ElectronStoreService`. `activeCloud`
   * (pick-cloud step), `aws` (credentials step, #192 — the chosen
   * profile/region), and `bootstrap` (bootstrap step, #211 — the last
   * submitted resource names) exist so far; later PRs in this epic extend
   * the payload as more steps need to durably save a choice. `aws` is merged
   * onto any existing stored value so unrelated fields (e.g. encrypted key
   * material written by other flows) survive; `bootstrap` is replaced
   * wholesale since a caller always submits all three resource names
   * together (there's no partial-name concept to preserve). Returns the same
   * shape as {@link getState} so the renderer can update its local state
   * directly from the response.
   */
  @MessagePattern('wizard.state.save')
  saveState(@Payload() body: SaveWizardStateInput): WizardState {
    if (body.activeCloud !== undefined) {
      // The `SaveWizardStateInput` union only constrains compile-time
      // callers — an IPC payload is runtime data, so a malformed or
      // malicious call could otherwise persist an unsupported value.
      if (body.activeCloud !== 'aws') {
        throw new Error(`Unsupported cloud provider: ${String(body.activeCloud)}`);
      }
      this.store.set('activeCloud', body.activeCloud);
    }
    if (body.aws !== undefined) {
      const current = this.store.get('aws') ?? {};
      this.store.set('aws', { ...current, ...body.aws });
    }
    if (body.bootstrap !== undefined) {
      this.store.set('bootstrap', body.bootstrap);
    }
    return this.getState();
  }

  /**
   * Returns `true` when `HYVEON_TEST_MODE=1` is set (the Electron e2e test
   * seam). Extracted as a protected seam so tests can `vi.spyOn` it instead
   * of mutating `process.env` directly.
   */
  protected isTestMode(): boolean {
    return process.env['HYVEON_TEST_MODE'] === '1';
  }

  /** Lists AWS CLI profiles discovered in `~/.aws/credentials` and `~/.aws/config`. */
  @MessagePattern('wizard.aws.listProfiles')
  listAwsProfiles(): Promise<AwsProfileSummary[]> {
    return this.awsProfiles.listProfiles();
  }

  /**
   * Saves pasted AWS credentials (the wizard's "paste keys instead" flow).
   * Only the resolved profile name is returned — the decrypted/plaintext
   * values passed in are never echoed back over IPC.
   */
  @MessagePattern('wizard.aws.saveCredentials')
  saveCredentials(@Payload() body: SavePastedCredentialsInput): { profileName: string } {
    return this.awsProfiles.savePastedCredentials(body);
  }

  /**
   * Idempotently creates/ensures the Terraform S3 state bucket (versioning +
   * default encryption). See `BootstrapService.ensureStateBucket` for the
   * full idempotency mapping.
   */
  @MessagePattern('wizard.bootstrap.stateBucket')
  bootstrapStateBucket(@Payload() body: BootstrapStateBucketInput): Promise<BootstrapResult> {
    return this.bootstrap.ensureStateBucket(body.bucketName);
  }

  /**
   * Idempotently creates/ensures the versioned configuration S3 bucket
   * (versioning + 90-day noncurrent-version-expiration lifecycle rule +
   * public-access-block, applied on both the fresh-create and
   * already-exists paths). See `BootstrapService.ensureConfigurationBucket`
   * for the full idempotency mapping.
   *
   * @remarks
   * A public-access-block failure surfaces the same way any other
   * configuration failure on this bucket does — the bucket's own
   * `status: 'failed'` plus the underlying SDK error's message — rather than
   * a separate status field, matching `BootstrapService.ensurePublicAccessBlock`'s
   * documented error-handling convention (no dedicated error type for PAB,
   * consistent with versioning/lifecycle).
   */
  @MessagePattern('wizard.bootstrap.configurationBucket')
  bootstrapConfigurationBucket(@Payload() body: BootstrapConfigurationBucketInput): Promise<BootstrapResult> {
    return this.bootstrap.ensureConfigurationBucket(body.bucketName);
  }

  /**
   * Idempotently seeds the initial `deployment-config.json` document (see
   * `BootstrapService.ensureDeploymentConfig`'s own doc comment for the full
   * Critical-bug rationale — before this existed, nothing ever created that
   * first object, so a fresh install was unusable the moment the wizard
   * finished). Takes the SAME `bucketName` the wizard just passed to
   * {@link bootstrapConfigurationBucket} — this must be seeded into that
   * exact bucket, not `ConfigService.getConfigurationBucket()` (which isn't
   * durably persisted until the operator advances past this wizard step).
   */
  @MessagePattern('wizard.bootstrap.deploymentConfig')
  bootstrapDeploymentConfig(@Payload() body: BootstrapDeploymentConfigInput): Promise<BootstrapResult> {
    return this.bootstrap.ensureDeploymentConfig(body.bucketName);
  }

  /**
   * Idempotently creates/ensures the run-history DynamoDB table (see
   * `BootstrapService.ensureRunsTable`'s own doc for the full
   * bootstrap-deadlock rationale). Unlike {@link bootstrapStateBucket}/
   * {@link bootstrapConfigurationBucket}, this takes no payload: the table's
   * name is NOT operator-editable at this point in the wizard — it's
   * computed from `@hyveon/shared`'s `DEPLOYMENT_CONFIG_DEFAULTS.projectName`
   * (the default `DeploymentConfig.projectName` every fresh install starts
   * with, since no `DeploymentConfig` — and therefore no
   * operator-configured `runsTableName` override — exists yet this early in
   * the wizard; that only gets configured later, from the Games/Settings
   * pages). Uses `resolveRunsTableName` so this can never drift from the
   * identical resolution `@hyveon/infra`'s stack-output computation and
   * `RunRecordService`'s pre-apply fallback apply.
   */
  @MessagePattern('wizard.bootstrap.runsTable')
  bootstrapRunsTable(): Promise<BootstrapResult> {
    return this.bootstrap.ensureRunsTable(resolveRunsTableName(DEPLOYMENT_CONFIG_DEFAULTS.projectName, ''));
  }

  /**
   * Runs the wizard's best-effort IAM permission dry-run against the
   * `HyveonDeployAll` action set. See `IamCheckService.checkPermissions`
   * for the passed/missing/warning result mapping.
   */
  @MessagePattern('wizard.iam.simulate')
  simulateIamPermissions(): Promise<IamCheckResult> {
    return this.iamCheck.checkPermissions();
  }

  /** Returns the last-recorded resumable step, defaulting to `pick-cloud` if unset/corrupt. */
  @MessagePattern('wizard.progress.get')
  getProgress(): Promise<WizardProgress> {
    return this.firstRunWizard.getProgress();
  }

  /**
   * Persists the current step — and, once the guided-IAM step has made
   * progress, its `guidedIam` sub-state — so the wizard resumes here if the
   * app closes before completion.
   */
  @MessagePattern('wizard.progress.save')
  saveProgress(@Payload() body: SaveWizardProgressInput): Promise<void> {
    return this.firstRunWizard.recordStep(body.step, body.guidedIam);
  }

  /**
   * Marks the wizard complete (`wizardCompleted: true`), which is what
   * actually gates the app router past the wizard. Returns the same shape as
   * {@link getState} so the renderer can update its local state directly.
   */
  @MessagePattern('wizard.complete')
  async complete(): Promise<WizardState> {
    await this.firstRunWizard.complete();
    return this.getState();
  }

  /**
   * Renders the `iam-bootstrap.yaml` CloudFormation template shell to disk
   * (policy documents substituted in) and returns the path the renderer
   * displays to the operator.
   */
  @MessagePattern('wizard.guidedIam.prepareTemplate')
  prepareGuidedIamTemplate(): RenderedTemplateResult {
    return this.guidedIam.renderTemplate();
  }

  /**
   * Builds the region-scoped CloudFormation "Create stack" console URL and
   * then attempts to open it in the operator's default browser — the one
   * channel here that orchestrates two {@link GuidedIamService} calls in
   * sequence rather than delegating to a single service method, since
   * {@link GuidedIamService} deliberately keeps `buildCloudFormationConsoleUrl`
   * and `openConsole` independently testable (see that service's doc
   * comments). On a failed/unavailable browser launch, `openConsole` already
   * echoes the same URL back in its result so the renderer can fall back to
   * displaying it as plain text.
   */
  @MessagePattern('wizard.guidedIam.openConsole')
  openGuidedIamConsole(@Payload() body: OpenGuidedIamConsoleInput): Promise<OpenConsoleResult> {
    const url = this.guidedIam.buildCloudFormationConsoleUrl(body.region);
    return this.guidedIam.openConsole(url);
  }

  /**
   * Validates the operator-pasted bootstrap access key pair against
   * `sts:GetCallerIdentity`, returning the resolved AWS account ID. The
   * pasted secret is accepted as IPC input (renderer → main) — expected and
   * fine — but is never echoed back in the result.
   */
  @MessagePattern('wizard.guidedIam.submitBootstrapKey')
  submitGuidedIamBootstrapKey(@Payload() body: BootstrapKeyIntakeInput): Promise<BootstrapKeyIntakeResult> {
    return this.guidedIam.intakeBootstrapKey(body);
  }

  /**
   * Performs the mandatory mint-then-revoke rotation onto a freshly-minted
   * key pair, per {@link GuidedIamService.rotate}'s documented step
   * sequence and its `complete`/`verification-failed`/`delete-failed`
   * result branches.
   */
  @MessagePattern('wizard.guidedIam.rotate')
  rotateGuidedIamKey(@Payload() body: RotationInput): Promise<RotationResult> {
    return this.guidedIam.rotate(body);
  }

  /**
   * Manual-retry action for {@link GuidedIamService.rotate}'s
   * `delete-failed` outcome: revokes the still-live bootstrap access key
   * without re-running the mint/verify sequence. Never rejects — a refusal
   * or AWS failure comes back as `{ revoked: false, message }`, per
   * {@link GuidedIamService.revokeBootstrapKey}'s doc comment.
   */
  @MessagePattern('wizard.guidedIam.revokeBootstrapKey')
  revokeGuidedIamBootstrapKey(@Payload() body: RevokeBootstrapKeyInput): Promise<RevokeBootstrapKeyResult> {
    return this.guidedIam.revokeBootstrapKey(body);
  }
}
