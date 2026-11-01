import { Injectable } from '@nestjs/common';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { errMessage, resolveEniPublicIp } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature, type AwsClientCredentials } from './awsCredentialSource.js';
import { createCachedAwsClient } from './awsClientCache.js';

/**
 * Thin EC2 wrapper used solely to turn an ECS task's Elastic Network
 * Interface ID into the IP address we surface to users. ECS exposes the
 * ENI attachment on the task, but not the IP — that lives on the ENI and
 * has to be resolved via the EC2 API.
 */
@Injectable()
export class Ec2Service {
  private readonly getCachedClient = createCachedAwsClient(
    (config: { region: string; credentials: AwsClientCredentials; credentialsSignature: string }) =>
      new EC2Client({ region: config.region, credentials: config.credentials }),
  );

  constructor(
    private readonly config: ConfigService,
    private readonly store: ElectronStoreService,
  ) {}

  /**
   * Lazily constructs the EC2 client, recreating it whenever the
   * freshly-resolved region or credentials signature differs from what the
   * cached client was built with — see `EcsService.getClient`'s matching doc
   * comment for why both matter.
   */
  private getClient(): EC2Client {
    const region = this.config.getRegion();
    const { credentials, signature } = resolveAwsClientCredentialsWithSignature(this.store);
    return this.getCachedClient({ region, credentials, credentialsSignature: signature });
  }

  /**
   * Resolve the public IPv4 of a task's ENI. Returns `null` when the ENI has
   * no public association (e.g. `assignPublicIp: DISABLED`) or the describe
   * call fails — callers then show "starting" / "no IP" instead of an error.
   */
  async getPublicIp(eniId: string): Promise<string | null> {
    try {
      const ip = await resolveEniPublicIp(
        (id) => this.getClient().send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [id] })),
        eniId,
      );
      logger.debug('Resolved public IP', { eniId, ip });
      return ip;
    } catch (err) {
      logger.error('Failed to resolve public IP', { err, eniId });
      return null;
    }
  }

  /**
   * Resolve the VPC-private IPv4 of a task's ENI. Kept separate from
   * {@link Ec2Service.getPublicIp} so callers can pick whichever addressing
   * they need (e.g. for internal-only FileBrowser access).
   */
  async getPrivateIp(eniId: string): Promise<string | null> {
    try {
      const resp = await this.getClient().send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      const ip = resp.NetworkInterfaces?.[0]?.PrivateIpAddress ?? null;
      logger.debug('Resolved private IP', { eniId, ip });
      return ip;
    } catch (err) {
      logger.error('Failed to resolve private IP', { err, eniId });
      return null;
    }
  }

  // @spec HELPER-REACH-001
  /**
   * Opens `cidr` on `port` (tcp) of `securityGroupId`, tagging the rule with `description` so it can be found again
   * by {@link Ec2Service.listIngressRulesByDescriptionPrefix}. An identical rule that already exists counts as success.
   *
   * @throws Error carrying only the normalized message when EC2 rejects the call.
   */
  async authorizeIngress(securityGroupId: string, cidr: string, port: number, description: string): Promise<void> {
    logger.debug('Ec2Service.authorizeIngress: authorizing rule', { securityGroupId, cidr, port, description });
    try {
      await this.getClient().send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: securityGroupId,
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: port,
              ToPort: port,
              IpRanges: [{ CidrIp: cidr, Description: description }],
            },
          ],
        }),
      );
    } catch (err) {
      const message = errMessage(err);
      if (err instanceof Error && err.name === 'InvalidPermission.Duplicate') {
        logger.warn('Ec2Service.authorizeIngress: rule already present', { securityGroupId, cidr, port });
        return;
      }
      logger.error('Ec2Service.authorizeIngress: failed', { securityGroupId, cidr, port, error: message });
      throw new Error(message);
    }
  }

  // @spec HELPER-REACH-005
  /**
   * Lists the ingress rules of `securityGroupId` whose description starts with `prefix` — how the app finds rules it
   * added itself (outside Pulumi's inline set). Returns `[]` when the lookup fails, so cleanup stays best-effort.
   */
  async listIngressRulesByDescriptionPrefix(
    securityGroupId: string,
    prefix: string,
  ): Promise<{ ruleId: string; description: string; cidr: string }[]> {
    logger.debug('Ec2Service.listIngressRulesByDescriptionPrefix: listing rules', { securityGroupId, prefix });
    try {
      const rules: { ruleId: string; description: string; cidr: string }[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await this.getClient().send(
          new DescribeSecurityGroupRulesCommand({
            Filters: [{ Name: 'group-id', Values: [securityGroupId] }],
            NextToken: nextToken,
          }),
        );
        for (const rule of resp.SecurityGroupRules ?? []) {
          if (rule.IsEgress || !rule.SecurityGroupRuleId || !rule.Description?.startsWith(prefix)) continue;
          rules.push({ ruleId: rule.SecurityGroupRuleId, description: rule.Description, cidr: rule.CidrIpv4 ?? '' });
        }
        nextToken = resp.NextToken;
      } while (nextToken);
      return rules;
    } catch (err) {
      logger.warn('Ec2Service.listIngressRulesByDescriptionPrefix: failed', {
        securityGroupId,
        prefix,
        error: errMessage(err),
      });
      return [];
    }
  }

  // @spec HELPER-REACH-005
  /** Revokes the given ingress rule ids from `securityGroupId`. Best-effort: returns `false` (after logging) on failure. */
  async revokeIngressRules(securityGroupId: string, ruleIds: string[]): Promise<boolean> {
    if (ruleIds.length === 0) return true;
    logger.debug('Ec2Service.revokeIngressRules: revoking rules', { securityGroupId, count: ruleIds.length });
    try {
      await this.getClient().send(
        new RevokeSecurityGroupIngressCommand({ GroupId: securityGroupId, SecurityGroupRuleIds: ruleIds }),
      );
      return true;
    } catch (err) {
      logger.warn('Ec2Service.revokeIngressRules: failed', { securityGroupId, ruleIds, error: errMessage(err) });
      return false;
    }
  }
}
