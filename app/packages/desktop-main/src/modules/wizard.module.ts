import { Module } from '@nestjs/common';
import { PrerequisiteService } from '../services/PrerequisiteService.js';

/**
 * Groups the first-run wizard's providers (see
 * `openspec/changes/add-first-run-wizard`). Follows the same shape as
 * `TerraformModule`/`DiscordModule` — `providers`/`exports` only, no
 * `controllers` array; the IPC controller is wired directly into
 * `AppModule.controllers` alongside every other controller in this codebase.
 */
@Module({
  providers: [PrerequisiteService],
  exports: [PrerequisiteService],
})
export class WizardModule {}
