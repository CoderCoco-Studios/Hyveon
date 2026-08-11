import { Injectable } from '@nestjs/common';
import { IAMClient, GetRoleCommand, CreateServiceLinkedRoleCommand } from '@aws-sdk/client-iam';
import { generateHyveonDeployAllPolicy } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from './awsCredentialSource.js';

/** Outcome of a single {@link CloudHealthCheck.check} call. */
export type CloudHealthCheckStatus = 'ok' | 'missing' | 'error';

/** Result of running a {@link CloudHealthCheck}'s `check()`. */
export interface CloudHealthCheckResult {
  status: CloudHealthCheckStatus;
  /** Present when `status` is `'missing'` or `'error'` — an actionable, human-readable message. */
  message?: string;
}

/** Outcome of a single {@link CloudHealthCheck.fix} call. */
export type CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed';

/** Result of running a {@link CloudHealthCheck}'s `fix()`. */
export interface CloudHealthFixResult {
  outcome: CloudHealthFixOutcome;
  /** Present when `outcome` is `'needsPolicyUpdate'` — the current `HyveonDeployAll` policy JSON to apply. */
  policyJson?: string;
  /** Present when `outcome` is `'failed'` — an actionable, human-readable message. */
  message?: string;
}

/** One AWS-account prerequisite check surfaced on the Settings page's Cloud Health section. */
export interface CloudHealthCheck {
  id: string;
  label: string;
  check(): Promise<CloudHealthCheckResult>;
  fix(): Promise<CloudHealthFixResult>;
}

/**
 * Backs the Settings page's Cloud Health checklist — a small, extensible set
 * of account-level prerequisite checks. Ships with one check: whether the
 * `AWSServiceRoleForECS` service-linked role exists, since its absence
 * causes ECS `RunTask` to fail with `InvalidParameterException` at game
 * start with no in-app way to discover or fix it.
 */
@Injectable()
export class CloudHealthService {
  constructor(
    private readonly store: ElectronStoreService,
    private readonly config: ConfigService,
  ) {}

  /** Returns every registered {@link CloudHealthCheck}. Add future checks here. */
  getChecks(): CloudHealthCheck[] {
    return [
      {
        id: 'ecs-service-linked-role',
        label: 'ECS service-linked role',
        check: () => this.checkEcsServiceLinkedRole(),
        fix: () => this.fixEcsServiceLinkedRole(),
      },
    ];
  }

  private getIamClient(): IAMClient {
    const region = this.config.getRegion();
    const { credentials } = resolveAwsClientCredentialsWithSignature(this.store);
    return new IAMClient({ region, credentials });
  }

  private async checkEcsServiceLinkedRole(): Promise<CloudHealthCheckResult> {
    logger.debug('CloudHealthService.checkEcsServiceLinkedRole: checking');
    try {
      await this.getIamClient().send(new GetRoleCommand({ RoleName: 'AWSServiceRoleForECS' }));
      return { status: 'ok' };
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (name === 'NoSuchEntityException') {
        return {
          status: 'missing',
          message: 'The AWSServiceRoleForECS service-linked role does not exist in this account.',
        };
      }
      logger.warn('CloudHealthService.checkEcsServiceLinkedRole: unexpected failure', { message });
      return { status: 'error', message };
    }
  }

  private async fixEcsServiceLinkedRole(): Promise<CloudHealthFixResult> {
    logger.debug('CloudHealthService.fixEcsServiceLinkedRole: attempting fix');
    try {
      await this.getIamClient().send(new CreateServiceLinkedRoleCommand({ AWSServiceName: 'ecs.amazonaws.com' }));
      return { outcome: 'fixed' };
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = err instanceof Error ? err.message : String(err);
      // "Already exists" arrives as InvalidInputException — the SDK models no
      // dedicated exception for this case, so the message must be inspected.
      if (name === 'InvalidInputException' && /already exists/i.test(message)) {
        return { outcome: 'fixed' };
      }
      // AWS-wide errors like AccessDenied aren't always modeled as a
      // service-specific exception class, so both common name spellings are checked.
      if (name === 'AccessDeniedException' || name === 'AccessDenied') {
        logger.warn('CloudHealthService.fixEcsServiceLinkedRole: access denied, deploy policy needs updating', {
          message,
        });
        return { outcome: 'needsPolicyUpdate', policyJson: JSON.stringify(generateHyveonDeployAllPolicy(), null, 2) };
      }
      logger.error('CloudHealthService.fixEcsServiceLinkedRole: unexpected failure', { message });
      return { outcome: 'failed', message };
    }
  }
}
