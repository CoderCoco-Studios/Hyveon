import { Module } from '@nestjs/common';
import { PrerequisiteService } from '../services/PrerequisiteService.js';
import { AwsProfileService } from '../services/AwsProfileService.js';
import { BootstrapService } from '../services/BootstrapService.js';
import { IamCheckService } from '../services/IamCheckService.js';
import { FirstRunWizardService } from '../services/FirstRunWizardService.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Groups the first-run wizard's providers (see
 * `openspec/changes/add-first-run-wizard`). Follows the same shape as
 * `TerraformModule`/`DiscordModule` — `providers`/`exports` only, no
 * `controllers` array; the IPC controller is wired directly into
 * `AppModule.controllers` alongside every other controller in this codebase.
 * Imports `ElectronStoreModule` so `AwsProfileService`/`BootstrapService`/
 * `IamCheckService`/`FirstRunWizardService` can inject
 * `SafeStorageService`/`ElectronStoreService` for the pasted-credentials,
 * credential-resolution, and wizard-completion flows.
 */
@Module({
  imports: [ElectronStoreModule],
  providers: [PrerequisiteService, AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService],
  exports: [PrerequisiteService, AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService],
})
export class WizardModule {}
