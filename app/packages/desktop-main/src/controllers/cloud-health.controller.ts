import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CloudHealthService, type CloudHealthCheckStatus, type CloudHealthFixResult } from '../services/CloudHealthService.js';
import type { OpenConsoleResult } from '../services/GuidedIamService.js';
import { errMessage } from '@hyveon/shared';
import { logger } from '../logger.js';

/** One row's worth of data for the Settings page's Cloud Health checklist. */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

// @spec APP-WIZARD-HEALTH-005
/**
 * IPC-only Cloud Health controller. Surfaces the account-prerequisite
 * checklist from {@link CloudHealthService} to the Settings page via
 * `cloudHealth.list` / `cloudHealth.fix` — no HTTP routes are registered.
 */
@Controller()
export class CloudHealthController {
  constructor(private readonly cloudHealth: CloudHealthService) {}

  // @spec APP-WIZARD-HEALTH-001, APP-WIZARD-HEALTH-011
  /**
   * Returns a status summary for every registered Cloud Health check. A check that throws is reported as an
   * `error` row with its message rather than failing the whole list.
   */
  @MessagePattern('cloudHealth.list')
  async list(): Promise<CloudHealthCheckSummary[]> {
    logger.debug('CloudHealthController: cloudHealth.list invoked');
    return Promise.all(
      this.cloudHealth.getChecks().map(async (check): Promise<CloudHealthCheckSummary> => {
        try {
          const result = await check.check();
          return { id: check.id, label: check.label, ...result };
        } catch (err) {
          const message = errMessage(err);
          logger.warn('CloudHealthController.list: check threw', { id: check.id, error: message });
          return { id: check.id, label: check.label, status: 'error', message };
        }
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

  /** Writes `payload.policyJson` to disk and returns the path it was written to. */
  @MessagePattern('cloudHealth.downloadPolicy')
  downloadPolicy(@Payload() payload: { policyJson: string }): { path: string } {
    logger.debug('CloudHealthController: cloudHealth.downloadPolicy invoked');
    return this.cloudHealth.writePolicyToDisk(payload.policyJson);
  }

  /** Opens `payload.url` (an IAM console link) in the operator's default browser. */
  @MessagePattern('cloudHealth.openPolicyConsole')
  async openPolicyConsole(@Payload() payload: { url: string }): Promise<OpenConsoleResult> {
    logger.debug('CloudHealthController: cloudHealth.openPolicyConsole invoked');
    return this.cloudHealth.openPolicyConsole(payload.url);
  }
}
