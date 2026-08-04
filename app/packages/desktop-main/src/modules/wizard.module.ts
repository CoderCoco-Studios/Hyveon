import { Module } from '@nestjs/common';
import { AwsProfileService } from '../services/AwsProfileService.js';
import { BootstrapService } from '../services/BootstrapService.js';
import { IamCheckService } from '../services/IamCheckService.js';
import { FirstRunWizardService } from '../services/FirstRunWizardService.js';
import { GuidedIamService } from '../services/GuidedIamService.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Groups the first-run wizard's providers (see
 * `openspec/changes/add-first-run-wizard`). Follows the same shape as
 * `TerraformModule`/`DiscordModule` — `providers`/`exports` only, no
 * `controllers` array; the IPC controller is wired directly into
 * `AppModule.controllers` alongside every other controller in this codebase.
 * Imports `ElectronStoreModule` so `AwsProfileService`/`BootstrapService`/
 * `IamCheckService`/`FirstRunWizardService`/`GuidedIamService` can inject
 * `SafeStorageService`/`ElectronStoreService` for the pasted-credentials,
 * credential-resolution, wizard-completion, and guided-IAM-bootstrap flows.
 */
@Module({
  imports: [ElectronStoreModule],
  providers: [AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService, GuidedIamService],
  exports: [AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService, GuidedIamService],
})
export class WizardModule {}
