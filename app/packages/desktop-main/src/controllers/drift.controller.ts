import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import type { DriftReport } from '@hyveon/shared';
import { DriftService } from '../services/DriftService.js';

/**
 * IPC-only controller exposing drift detection (declared `deployment-config.json`
 * vs. the applied configuration last written to the deployed Pulumi stack) for
 * the Electron main-process host. The single handler is bound to an IPC channel
 * via `@MessagePattern` — no HTTP routes are registered here. It delegates to
 * the {@link DriftService} provider.
 */
@Controller()
export class DriftController {
  constructor(private readonly drift: DriftService) {}

  /** Returns the current {@link DriftReport} — see `DriftService.getDrift()`. */
  @MessagePattern('drift.get')
  get(): Promise<DriftReport> {
    return this.drift.getDrift();
  }
}
