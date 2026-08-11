import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CloudHealthService, type CloudHealthCheckStatus, type CloudHealthFixResult } from '../services/CloudHealthService.js';
import { logger } from '../logger.js';

/** One row's worth of data for the Settings page's Cloud Health checklist. */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

/**
 * IPC-only Cloud Health controller. Surfaces the account-prerequisite
 * checklist from {@link CloudHealthService} to the Settings page via
 * `cloudHealth.list` / `cloudHealth.fix` — no HTTP routes are registered.
 */
@Controller()
export class CloudHealthController {
  constructor(private readonly cloudHealth: CloudHealthService) {}

  /** Returns a status summary for every registered Cloud Health check. */
  @MessagePattern('cloudHealth.list')
  async list(): Promise<CloudHealthCheckSummary[]> {
    logger.debug('CloudHealthController: cloudHealth.list invoked');
    return Promise.all(
      this.cloudHealth.getChecks().map(async (check) => {
        const result = await check.check();
        return { id: check.id, label: check.label, ...result };
      }),
    );
  }

  /** Attempts to fix the check identified by `payload.id`. */
  @MessagePattern('cloudHealth.fix')
  async fix(@Payload() payload: { id: string }): Promise<CloudHealthFixResult> {
    logger.debug('CloudHealthController: cloudHealth.fix invoked', { id: payload.id });
    const check = this.cloudHealth.getChecks().find((c) => c.id === payload.id);
    if (!check) {
      return { outcome: 'failed', message: `Unknown health check id: ${payload.id}` };
    }
    return check.fix();
  }
}
