import { Module } from '@nestjs/common';
import { AwsProfileService } from '../services/AwsProfileService.js';
import { BootstrapService } from '../services/BootstrapService.js';
import { IamCheckService } from '../services/IamCheckService.js';
import { FirstRunWizardService } from '../services/FirstRunWizardService.js';
import { GuidedIamService } from '../services/GuidedIamService.js';
import { CloudHealthService } from '../services/CloudHealthService.js';
import { ElectronStoreModule } from './electron-store.module.js';
import { ConfigModule } from './config.module.js';

/**
 * Groups the first-run wizard's providers (see
 * `openspec/changes/add-first-run-wizard`). Follows the same shape as
 * `DiscordModule` — `providers`/`exports` only, no
 * `controllers` array; the IPC controller is wired directly into
 * `AppModule.controllers` alongside every other controller in this codebase.
 * Imports `ElectronStoreModule` so `AwsProfileService`/`BootstrapService`/
 * `IamCheckService`/`FirstRunWizardService`/`GuidedIamService`/
 * `CloudHealthService` can inject `SafeStorageService`/`ElectronStoreService`
 * for the pasted-credentials, credential-resolution, wizard-completion,
 * guided-IAM-bootstrap, and cloud-health-check flows. Also imports
 * `ConfigModule` — `CloudHealthService` additionally injects `ConfigService`
 * (for `getRegion()`, building its `IAMClient`), which no other provider in
 * this module previously required.
 */
@Module({
  imports: [ElectronStoreModule, ConfigModule],
  providers: [
    AwsProfileService,
    BootstrapService,
    IamCheckService,
    FirstRunWizardService,
    GuidedIamService,
    CloudHealthService,
  ],
  exports: [
    AwsProfileService,
    BootstrapService,
    IamCheckService,
    FirstRunWizardService,
    GuidedIamService,
    CloudHealthService,
  ],
})
export class WizardModule {}
