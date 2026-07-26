import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { PrerequisiteService, type PrerequisitesReport } from '../services/PrerequisiteService.js';
import {
  AwsProfileService,
  type AwsProfileSummary,
  type SavePastedCredentialsInput,
} from '../services/AwsProfileService.js';

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
  ) {}

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
}
