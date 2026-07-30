import { Injectable } from '@nestjs/common';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { fromIni } from '@aws-sdk/credential-providers';
import { HYVEON_DEPLOY_ALL_ACTIONS } from '@hyveon/shared';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';

/**
 * Maximum number of action names sent in a single `SimulatePrincipalPolicy`
 * request, matching design.md decision 6 ("batch `SimulatePrincipalPolicy`
 * calls (~50 actions per request)").
 */
const SIMULATE_BATCH_SIZE = 50;

/** Outcome of {@link IamCheckService.checkPermissions}. */
export type IamCheckStatus = 'passed' | 'missing' | 'warning';

/** Result of the wizard's best-effort IAM permission dry-run. */
export interface IamCheckResult {
  status: IamCheckStatus;
  /**
   * Present when `status` is `'missing'` — a minimal pasteable IAM policy
   * JSON document covering exactly the denied actions.
   */
  policyJson?: string;
  /**
   * Present when `status` is `'warning'` — an actionable message explaining
   * why simulation itself could not run (e.g. the caller lacks
   * `iam:SimulatePrincipalPolicy`).
   */
  message?: string;
}

/**
 * Runs the first-run wizard's best-effort IAM permission dry-run (see
 * `openspec/changes/add-first-run-wizard`, "IAM permission simulation"
 * scenario). Resolves the caller's identity via `sts:GetCallerIdentity`,
 * then batches `iam:SimulatePrincipalPolicy` calls across the
 * `HyveonDeployAll` action set (`@hyveon/shared`'s single source of
 * truth, itself synced to `docs/docs/setup.md`). Never grants permissions —
 * denied actions are surfaced as copy-paste-able policy JSON, and a
 * simulation failure degrades to a non-blocking warning rather than an error.
 */
@Injectable()
export class IamCheckService {
  constructor(private readonly store: ElectronStoreService) {}

  /** Runs the dry-run and returns a `passed` / `missing` / `warning` result. */
  async checkPermissions(): Promise<IamCheckResult> {
    let callerArn: string;
    try {
      callerArn = await this.getCallerArn();
    } catch (err) {
      return { status: 'warning', message: this.describeError(err) };
    }

    const actions = this.actionsToCheck();
    const denied: string[] = [];
    try {
      const client = this.createIamClient();
      for (const batch of this.chunk(actions, SIMULATE_BATCH_SIZE)) {
        const response = await client.send(
          new SimulatePrincipalPolicyCommand({ PolicySourceArn: callerArn, ActionNames: [...batch] }),
        );
        for (const result of response.EvaluationResults ?? []) {
          if (result.EvalDecision !== 'allowed' && result.EvalActionName) {
            denied.push(result.EvalActionName);
          }
        }
      }
    } catch (err) {
      return { status: 'warning', message: this.describeError(err) };
    }

    if (denied.length === 0) {
      return { status: 'passed' };
    }
    return { status: 'missing', policyJson: this.buildPolicyJson(denied) };
  }

  /**
   * The action set to simulate. Extracted as a seam (rather than referencing
   * {@link HYVEON_DEPLOY_ALL_ACTIONS} inline) so tests can substitute a
   * larger list to exercise batching without depending on the real policy's
   * size.
   */
  protected actionsToCheck(): readonly string[] {
    return HYVEON_DEPLOY_ALL_ACTIONS;
  }

  private async getCallerArn(): Promise<string> {
    const client = this.createStsClient();
    const response = await client.send(new GetCallerIdentityCommand({}));
    if (!response.Arn) {
      throw new Error('sts:GetCallerIdentity did not return an ARN for the configured credentials.');
    }
    return this.toPolicySourceArn(response.Arn);
  }

  /**
   * `SimulatePrincipalPolicy`'s `PolicySourceArn` only accepts an IAM user,
   * group, or role ARN — but `sts:GetCallerIdentity` returns an STS
   * assumed-role session ARN (`arn:aws:sts::ACCOUNT:assumed-role/ROLE/SESSION`)
   * for role/SSO credentials. Convert that to the underlying IAM role ARN;
   * other ARN types (IAM user) pass through unchanged.
   */
  private toPolicySourceArn(arn: string): string {
    const match = /^arn:(aws[a-zA-Z0-9-]*):sts::(\d+):assumed-role\/(.+)\/[^/]+$/.exec(arn);
    if (!match) {
      return arn;
    }
    const [, partition, accountId, roleNameWithPath] = match;
    return `arn:${partition}:iam::${accountId}:role/${roleNameWithPath}`;
  }

  private buildPolicyJson(actions: string[]): string {
    return JSON.stringify(
      {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }],
      },
      null,
      2,
    );
  }

  private *chunk<T>(items: readonly T[], size: number): Generator<readonly T[]> {
    for (let i = 0; i < items.length; i += size) {
      yield items.slice(i, i + size);
    }
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /**
   * Builds an STS client from the credentials/region chosen in the wizard's
   * credentials step. Extracted as a protected seam so tests can stub it.
   */
  protected createStsClient(): STSClient {
    return new STSClient(this.resolveClientConfig());
  }

  /**
   * Builds an IAM client from the same wizard-chosen credentials/region as
   * {@link createStsClient}. Extracted as a protected seam so tests can stub it.
   */
  protected createIamClient(): IAMClient {
    return new IAMClient(this.resolveClientConfig());
  }

  private resolveClientConfig(): Pick<import('@aws-sdk/client-iam').IAMClientConfig, 'region' | 'credentials'> {
    const aws = this.store.get('aws');
    if (!aws?.region) {
      throw new Error(
        'Cannot run the IAM permission check: no region is configured. Complete the credentials step of the wizard first.',
      );
    }
    const { region } = aws;
    const source = resolveAwsCredentialSource(this.store);
    switch (source.kind) {
      case 'none':
        return { region };
      case 'pasted':
        return {
          region,
          credentials: { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey },
        };
      case 'profile':
        return { region, credentials: fromIni({ profile: source.profile }) };
    }
  }
}
