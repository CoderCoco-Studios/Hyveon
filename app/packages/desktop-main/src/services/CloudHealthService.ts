import { Injectable } from '@nestjs/common';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { IAMClient, GetRoleCommand, CreateServiceLinkedRoleCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DEPLOYMENT_CONFIG_DEFAULTS, errMessage, generateHyveonDeployAllPolicy } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { DeploymentConfigService } from './DeploymentConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from './awsCredentialSource.js';
import type { OpenConsoleResult } from './GuidedIamService.js';

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
  /**
   * Present when `outcome` is `'needsPolicyUpdate'` — a direct link to the
   * `HyveonDeployAll` managed policy's edit page in the IAM console, built
   * from the account ID resolved via `sts:GetCallerIdentity`. `undefined` if
   * the account ID couldn't be resolved (e.g. the same denied credentials
   * also lack `sts:GetCallerIdentity`, though that's atypical) — the UI falls
   * back to the Copy button alone in that case.
   */
  policyConsoleUrl?: string;
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
    private readonly deploymentConfig: DeploymentConfigService,
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

  private getStsClient(): STSClient {
    const region = this.config.getRegion();
    const { credentials } = resolveAwsClientCredentialsWithSignature(this.store);
    return new STSClient({ region, credentials });
  }

  private async checkEcsServiceLinkedRole(): Promise<CloudHealthCheckResult> {
    logger.debug('CloudHealthService.checkEcsServiceLinkedRole: checking');
    try {
      await this.getIamClient().send(new GetRoleCommand({ RoleName: 'AWSServiceRoleForECS' }));
      return { status: 'ok' };
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = errMessage(err);
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

  /**
   * Resolves the operator's configured project name for building an
   * account-specific `HyveonDeployAll` policy. Falls back to
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}'s project name — both when the
   * setting is unset and when `deployment-config.json` can't be read yet
   * (e.g. setup hasn't reached the point of provisioning the configuration
   * bucket) — since the remediation policy is still useful with the default
   * name in that case.
   */
  private async getProjectName(): Promise<string> {
    try {
      const { settings } = await this.deploymentConfig.getTopLevelSettings();
      return settings.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName;
    } catch (err) {
      const message = errMessage(err);
      logger.warn('CloudHealthService.getProjectName: falling back to the default project name', { message });
      return DEPLOYMENT_CONFIG_DEFAULTS.projectName;
    }
  }

  private async fixEcsServiceLinkedRole(): Promise<CloudHealthFixResult> {
    logger.debug('CloudHealthService.fixEcsServiceLinkedRole: attempting fix');
    try {
      await this.getIamClient().send(new CreateServiceLinkedRoleCommand({ AWSServiceName: 'ecs.amazonaws.com' }));
      return { outcome: 'fixed' };
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = errMessage(err);
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
        const projectName = await this.getProjectName();
        return {
          outcome: 'needsPolicyUpdate',
          policyJson: JSON.stringify(generateHyveonDeployAllPolicy(projectName), null, 2),
          policyConsoleUrl: await this.buildPolicyConsoleUrl(),
        };
      }
      logger.error('CloudHealthService.fixEcsServiceLinkedRole: unexpected failure', { message });
      return { outcome: 'failed', message };
    }
  }

  /**
   * Builds a direct link to the `HyveonDeployAll` managed policy's edit page
   * in the IAM console, scoped to the caller's account ID (resolved via
   * `sts:GetCallerIdentity`, using the same credentials that just failed
   * `iam:CreateServiceLinkedRole` in {@link fixEcsServiceLinkedRole} — those
   * credentials still have `sts:GetCallerIdentity`, since every IAM
   * principal can call it against itself). Returns `undefined` on failure
   * (e.g. the account ID can't be resolved) rather than throwing — this is
   * only used to enrich an already-successful `needsPolicyUpdate` result with
   * a convenience link; its absence just means the UI falls back to the Copy
   * button alone.
   */
  private async buildPolicyConsoleUrl(): Promise<string | undefined> {
    try {
      const response = await this.getStsClient().send(new GetCallerIdentityCommand({}));
      if (!response.Account) {
        return undefined;
      }
      return `https://console.aws.amazon.com/iam/home#/policies/arn:aws:iam::${response.Account}:policy/HyveonDeployAll`;
    } catch (err) {
      const message = errMessage(err);
      logger.warn('CloudHealthService.buildPolicyConsoleUrl: could not resolve account ID', { error: message });
      return undefined;
    }
  }

  /**
   * Writes `policyJson` to disk as `hyveon-deploy-all-policy.json`, so the
   * operator has a real file for `aws iam create-policy-version` or similar
   * AWS CLI use — mirrors `GuidedIamService.getRenderedTemplatePath`'s
   * packaged/dev resolution order exactly (own copy of the same two small
   * helpers below, matching this codebase's existing per-service convention
   * rather than importing across service files for a two-line helper).
   *
   * @param policyJson - The policy document text to write, verbatim.
   */
  writePolicyToDisk(policyJson: string): { path: string } {
    const path = this.getPolicyDownloadPath();
    writeFileSync(path, policyJson);
    return { path };
  }

  /**
   * Launch the operator's default browser at `url` (the IAM console page
   * from {@link buildPolicyConsoleUrl}) via Electron's `shell.openExternal`.
   * Mirrors `GuidedIamService.openConsole` exactly — same validation
   * (`https:` only), same never-throws contract, same `OpenConsoleResult`
   * shape — so the wizard's existing "browser cannot be opened, show the URL
   * as text" fallback pattern applies here unchanged.
   *
   * @param url - The URL to hand to the OS's default browser.
   */
  async openPolicyConsole(url: string): Promise<OpenConsoleResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { opened: false, url };
    }
    if (parsed.protocol !== 'https:') {
      return { opened: false, url };
    }
    if (!this.readIsElectron()) {
      return { opened: false, url };
    }
    try {
      await this.openExternalUrl(url);
      return { opened: true };
    } catch {
      return { opened: false, url };
    }
  }

  /**
   * Returns `true` when `process.versions['electron']` is set. Extracted as a
   * protected method so tests can stub it via `vi.spyOn`. Mirrors
   * `GuidedIamService.readIsElectron` exactly.
   */
  protected readIsElectron(): boolean {
    return !!process.versions['electron'];
  }

  /**
   * Calls `shell.openExternal(url)` and awaits its result. Only called after
   * {@link readIsElectron} returns `true`. Extracted as a protected method,
   * lazily requiring `electron` at call-time, mirroring
   * `GuidedIamService.openExternalUrl` exactly.
   *
   * @param url - The URL to hand to the OS's default browser.
   */
  protected async openExternalUrl(url: string): Promise<void> {
    const _require = createRequire(import.meta.url);
    const { shell } = _require('electron') as { shell: { openExternal(url: string): Promise<void> } };
    await shell.openExternal(url);
  }

  /**
   * Return `process.resourcesPath` when running inside an Electron packaged
   * app, or `undefined` otherwise. Extracted as a protected method so tests
   * can stub it. Mirrors `GuidedIamService.readIsPackaged`/`ConfigService.readIsPackaged` exactly.
   */
  protected readIsPackaged(): boolean {
    if (!process.versions['electron']) return false;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { isPackaged: boolean } };
      return electron.app.isPackaged;
    } catch {
      return false;
    }
  }

  /**
   * Return the Electron `userData` directory when running inside an Electron
   * process, or `null` otherwise. Extracted as a protected method so tests
   * can stub it. Mirrors `GuidedIamService.readUserDataPath` exactly.
   */
  protected readUserDataPath(): string | null {
    if (!process.versions['electron']) return null;
    try {
      const _require = createRequire(import.meta.url);
      const electron = _require('electron') as { app: { getPath(name: string): string } };
      return electron.app.getPath('userData');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the absolute path {@link writePolicyToDisk} writes to: the
   * Electron `userData` directory (a user-writable location that survives
   * app updates) when packaged, or a git-ignored dev-scratch path under the
   * current working directory otherwise. Mirrors
   * `GuidedIamService.getRenderedTemplatePath`'s resolution order.
   */
  protected getPolicyDownloadPath(): string {
    if (this.readIsPackaged()) {
      const userData = this.readUserDataPath();
      if (userData) {
        return join(userData, 'hyveon-deploy-all-policy.json');
      }
    }
    return join(process.cwd(), 'hyveon-deploy-all-policy.json');
  }
}
