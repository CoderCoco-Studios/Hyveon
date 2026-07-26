import { Module } from '@nestjs/common';
import { PrerequisiteService } from '../services/PrerequisiteService.js';
import { AwsProfileService } from '../services/AwsProfileService.js';
import { ElectronStoreModule } from './electron-store.module.js';

/**
 * Groups the first-run wizard's providers (see
 * `openspec/changes/add-first-run-wizard`). Follows the same shape as
 * `TerraformModule`/`DiscordModule` — `providers`/`exports` only, no
 * `controllers` array; the IPC controller is wired directly into
 * `AppModule.controllers` alongside every other controller in this codebase.
 * Imports `ElectronStoreModule` so `AwsProfileService` can inject
 * `SafeStorageService`/`ElectronStoreService` for the pasted-credentials
 * save flow.
 */
@Module({
  imports: [ElectronStoreModule],
  providers: [PrerequisiteService, AwsProfileService],
  exports: [PrerequisiteService, AwsProfileService],
})
export class WizardModule {}
