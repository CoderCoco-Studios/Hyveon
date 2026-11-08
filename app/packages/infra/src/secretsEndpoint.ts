/**
 * The Secrets Manager interface VPC endpoint the health-check Lambda uses to fetch a declared `healthCheck.auth`
 * credential, plus its security group and the health-check group's matching egress rule. Declared only while some game
 * declares `healthCheck.auth.secretArn` (the same derived set the health-check IAM policy is built from), so a
 * deployment whose checks are all unauthenticated pays nothing for it. See `health-check-design.md`, Decisions:
 * "VPC placement and AWS API reachability".
 *
 * The endpoint security group declares no inline rules at all: its only rule, TCP 443 ingress from the VPC CIDR, is a
 * standalone `SecurityGroupRule`, and it has no egress rule (see `securityGroups.ts`'s "Inline vs. standalone" doc).
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import { healthCheckSecretArns } from './iam.js';

/** Every resource {@link defineSecretsEndpoint} declares when an authenticated health check exists. */
export interface SecretsEndpointResources {
  /** The Secrets Manager interface endpoint, one ENI in the first public subnet. */
  endpoint: aws.ec2.VpcEndpoint;
  /** The endpoint's security group; carries no inline rules and no egress. */
  securityGroup: aws.ec2.SecurityGroup;
  /** Standalone TCP 443 ingress on {@link securityGroup} from the VPC CIDR. */
  ingressRule: aws.ec2.SecurityGroupRule;
  /** Standalone TCP 443 egress on the health-check security group toward {@link securityGroup}. */
  healthCheckEgressRule: aws.ec2.SecurityGroupRule;
}

/** Arguments {@link defineSecretsEndpoint} needs. */
export interface DefineSecretsEndpointArgs {
  /** Project name — every resource name/tag below is `${projectName}-...`. */
  projectName: string;
  /** Region the service name `com.amazonaws.{region}.secretsmanager` is built from. */
  awsRegion: string;
  /** The configured game-server map the declared `auth.secretArn` set is derived from. */
  gameServers: Record<string, GameServerConfig>;
  /** The VPC the endpoint and its security group are created in. */
  vpcId: pulumi.Input<string>;
  /** The VPC CIDR the endpoint security group admits on TCP 443. */
  vpcCidr: string;
  /** The declared public-subnet ids in index order; the endpoint occupies index 0 only. */
  subnetIds: pulumi.Input<string>[];
  /** The health-check security group id, which must exist whenever a game declares `healthCheck.auth`. */
  healthCheckSecurityGroupId: pulumi.Input<string> | undefined;
  /** The regional AWS provider every resource is declared against. */
  provider: aws.Provider;
}

// @spec IAC-PROGRAM-NET-003, IAC-PROGRAM-NET-004, IAC-PROGRAM-NET-005, IAC-PROGRAM-NET-006
// @spec IAC-PROGRAM-SG-014, IAC-PROGRAM-SG-015, IAC-PROGRAM-SG-016, IAC-PROGRAM-SG-017, IAC-PROGRAM-SG-018
// @spec IAC-PROGRAM-SG-019, IAC-PROGRAM-SG-020, IAC-PROGRAM-LAMBDA-012, RT-HEALTH-PROV-004, RT-HEALTH-NET-007
/**
 * Declares the Secrets Manager endpoint area. Must be called from inside the Pulumi inline-program closure.
 *
 * @remarks
 * Several authenticated games, or several games sharing one secret, still yield exactly one endpoint. The endpoint
 * sits in subnet 0 alone to bill for one subnet; the health-check function keeps both subnets and reaches the
 * endpoint across Availability Zones inside the VPC.
 *
 * @param args - See {@link DefineSecretsEndpointArgs}.
 * @returns The declared resources, or `undefined` when no game declares `healthCheck.auth.secretArn`.
 * @throws When an authenticated health check exists but no health-check security group id was supplied.
 */
export function defineSecretsEndpoint(args: DefineSecretsEndpointArgs): SecretsEndpointResources | undefined {
  const { projectName, awsRegion, gameServers, vpcId, vpcCidr, subnetIds, healthCheckSecurityGroupId, provider } = args;
  if (healthCheckSecretArns(gameServers).length === 0) {
    return undefined;
  }
  if (healthCheckSecurityGroupId === undefined) {
    throw new Error('defineSecretsEndpoint: healthCheckSecurityGroupId is undefined but a game declares healthCheck.auth.');
  }
  const opts: pulumi.CustomResourceOptions = { provider };

  const securityGroup = new aws.ec2.SecurityGroup(
    `${projectName}-secrets-endpoint-sg`,
    {
      namePrefix: `${projectName}-secrets-endpoint-sg-`,
      description: 'Secrets Manager interface endpoint — TCP 443 from the VPC',
      vpcId,
      // No inline rules — see this file's doc.
      tags: { Name: `${projectName}-secrets-endpoint-sg` },
    },
    opts,
  );

  const ingressRule = new aws.ec2.SecurityGroupRule(
    `${projectName}-secrets-endpoint-ingress`,
    {
      type: 'ingress',
      fromPort: 443,
      toPort: 443,
      protocol: 'tcp',
      securityGroupId: securityGroup.id,
      cidrBlocks: [vpcCidr],
    },
    opts,
  );

  const healthCheckEgressRule = new aws.ec2.SecurityGroupRule(
    `${projectName}-health-check-egress-secrets-endpoint`,
    {
      type: 'egress',
      fromPort: 443,
      toPort: 443,
      protocol: 'tcp',
      securityGroupId: healthCheckSecurityGroupId,
      sourceSecurityGroupId: securityGroup.id,
    },
    opts,
  );

  const endpoint = new aws.ec2.VpcEndpoint(
    `${projectName}-secretsmanager-endpoint`,
    {
      vpcId,
      serviceName: `com.amazonaws.${awsRegion}.secretsmanager`,
      vpcEndpointType: 'Interface',
      subnetIds: [subnetIds[0]],
      securityGroupIds: [securityGroup.id],
      privateDnsEnabled: true,
      tags: { Name: `${projectName}-secretsmanager-endpoint` },
    },
    { ...opts, dependsOn: [ingressRule] },
  );

  return { endpoint, securityGroup, ingressRule, healthCheckEgressRule };
}
