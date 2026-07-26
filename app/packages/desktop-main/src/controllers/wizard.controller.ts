import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { PrerequisiteService, type PrerequisitesReport } from '../services/PrerequisiteService.js';
import {
  AwsProfileService,
  type AwsProfileSummary,
  type SavePastedCredentialsInput,
} from '../services/AwsProfileService.js';
import { BootstrapService, type BootstrapResult } from '../services/BootstrapService.js';
import { ElectronStoreService } from '../services/ElectronStoreService.js';

/** Payload accepted by {@link WizardController.bootstrapStateBucket}. */
export interface BootstrapStateBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link WizardController.bootstrapLockTable}. */
export interface BootstrapLockTableInput {
  tableName: string;
}

/**
 * The credentials step's chosen source, as persisted to `ElectronStoreService.aws`.
 * `profile` names either a real `~/.aws` profile (the "pick an existing
 * profile" path) or a `creds.aws.<profileName>` pasted-credentials entry
 * (the "paste keys instead" path, e.g. `gsd-pasted`) — the two are
 * distinguished later by whether `creds.aws.<profile>` exists, not by a
 * separate flag here.
 */
export interface WizardAwsChoice {
  profile?: string;
  region?: string;
}

/** Minimal wizard-progress summary the renderer needs to decide whether to show the wizard route. */
export interface WizardState {
  wizardCompleted: boolean;
  /** The cloud chosen in the pick-cloud step. Locked to `'aws'` for v1; `undefined` before that step runs. */
  activeCloud?: 'aws';
  /** The credential source chosen in the credentials step (#192), if any. */
  aws?: WizardAwsChoice;
}

/** Payload accepted by {@link WizardController.saveState}. */
export interface SaveWizardStateInput {
  activeCloud?: 'aws';
  aws?: WizardAwsChoice;
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
    private readonly prerequisites: PrerequisiteService,
    private readonly awsProfiles: AwsProfileService,
    private readonly store: ElectronStoreService,
    private readonly bootstrap: BootstrapService,
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
   * inline per test, not through the shared `applyGsdMocks` helper), so a
   * `false` default here would route every one of them into the wizard
   * instead of the dashboard they're actually testing. Defaulting to
   * `true` under test mode avoids retrofitting every existing spec; a
   * future spec that *does* want to exercise the wizard flow itself can
   * still override this via `window.gsd.__test.mock('wizard.state.get', ...)`
   * — the mock registry is consulted before this controller is ever reached.
   * This is a plain read of `ElectronStoreService` either way — the fuller
   * resumable step-progress state (`userData/state.json`, owned by
   * `FirstRunWizardService`) lands in a later PR of this epic.
   */
  @MessagePattern('wizard.state.get')
  getState(): WizardState {
    const stored = this.store.get('wizardCompleted');
    const wizardCompleted = stored !== undefined ? stored : this.isTestMode();
    return { wizardCompleted, activeCloud: this.store.get('activeCloud'), aws: this.store.get('aws') };
  }

  /**
   * Persists wizard-flow answers into `ElectronStoreService`. `activeCloud`
   * (pick-cloud step) and `aws` (credentials step, #192 — the chosen
   * profile/region) exist so far; later PRs in this epic extend the payload
   * as more steps need to durably save a choice. `aws` is merged onto any
   * existing stored value so unrelated fields (e.g. encrypted key material
   * written by other flows) survive. Returns the same shape as
   * {@link getState} so the renderer can update its local state directly
   * from the response.
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

  /** Detects `terraform` and `aws` on `PATH`, reporting per-tool found/path/version. */
  @MessagePattern('wizard.prereqs.check')
  checkPrereqs(): Promise<PrerequisitesReport> {
    return this.prerequisites.check();
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
   * Idempotently creates/ensures the Terraform state-lock DynamoDB table.
   * See `BootstrapService.ensureLockTable` for the full idempotency mapping.
   */
  @MessagePattern('wizard.bootstrap.lockTable')
  bootstrapLockTable(@Payload() body: BootstrapLockTableInput): Promise<BootstrapResult> {
    return this.bootstrap.ensureLockTable(body.tableName);
  }
}
