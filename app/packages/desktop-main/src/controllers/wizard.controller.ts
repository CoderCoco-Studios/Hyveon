import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { PrerequisiteService, type PrerequisitesReport } from '../services/PrerequisiteService.js';

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
  constructor(private readonly prerequisites: PrerequisiteService) {}

  /** Detects `terraform` and `aws` on `PATH`, reporting per-tool found/path/version. */
  @MessagePattern('wizard.prereqs.check')
  checkPrereqs(): Promise<PrerequisitesReport> {
    return this.prerequisites.check();
  }
}
