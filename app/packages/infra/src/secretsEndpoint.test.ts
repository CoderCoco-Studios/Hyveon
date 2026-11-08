import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineSecretsEndpoint } from './secretsEndpoint.js';
import { defineSecurityGroups } from './securityGroups.js';
import { FIXTURE_GAME_SERVERS, FIXTURE_HEALTH_CHECK_SECRET_ARN, buildHealthCheckGame } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

const VPC_CIDR = '10.0.0.0/16';
const SUBNET_IDS = ['subnet-0', 'subnet-1'];

/** Declares the security groups, then the endpoint area, and resolves every handle so the mock recorder is complete. */
async function arrange(gameServers: Record<string, GameServerConfig>) {
  const provider = new aws.Provider('aws', { region: 'us-east-1' });
  const securityGroups = defineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-123', provider });
  const resources = defineSecretsEndpoint({
    projectName: 'hyveon',
    awsRegion: 'us-east-1',
    gameServers,
    vpcId: 'vpc-123',
    vpcCidr: VPC_CIDR,
    subnetIds: SUBNET_IDS,
    healthCheckSecurityGroupId: securityGroups.healthCheck?.id,
    provider,
  });
  await Promise.all([
    promiseOf(securityGroups.gameServers.id),
    promiseOf(securityGroups.fileManager.id),
    promiseOf(securityGroups.efs.id),
    ...(securityGroups.healthCheck ? [promiseOf(securityGroups.healthCheck.id)] : []),
    ...securityGroups.healthCheckEgressRules.map((rule) => promiseOf(rule.id)),
    ...(resources
      ? [
          promiseOf(resources.endpoint.id),
          promiseOf(resources.securityGroup.id),
          promiseOf(resources.ingressRule.id),
          promiseOf(resources.healthCheckEgressRule.id),
        ]
      : []),
  ]);
  return { securityGroups, resources };
}

/** Finds the single recorded resource with the given logical name. */
function findByName(resources: RecordedResource[], name: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

const ofType = (resources: RecordedResource[], type: string): RecordedResource[] => resources.filter((r) => r.type === type);

describe('defineSecretsEndpoint', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  // @spec IAC-PROGRAM-NET-004, IAC-PROGRAM-SG-018, IAC-PROGRAM-SG-019, RT-HEALTH-NET-007
  it.each([
    ['no game declares healthCheck', FIXTURE_GAME_SERVERS],
    ['a game declares healthCheck without auth', { ...FIXTURE_GAME_SERVERS, echo: buildHealthCheckGame() }],
  ])('should declare no endpoint, endpoint security group or 443 rule when %s', async (_label, gameServers) => {
    const { securityGroups, resources } = await arrange(gameServers);

    expect(resources).toBeUndefined();
    expect(ofType(mocks.resources, 'aws:ec2/vpcEndpoint:VpcEndpoint')).toHaveLength(0);
    expect(mocks.resources.some((r) => r.name.includes('secrets-endpoint'))).toBe(false);
    const rules = ofType(mocks.resources, 'aws:ec2/securityGroupRule:SecurityGroupRule');
    expect(rules.some((r) => r.inputs.toPort === 443)).toBe(false);
    expect(securityGroups.healthCheckEgressRules).toHaveLength(gameServers['echo'] ? 1 : 0);
  });

  // @spec IAC-PROGRAM-NET-003, IAC-PROGRAM-NET-005, IAC-PROGRAM-NET-006
  it('should declare one Secrets Manager interface endpoint in subnet 0 only with private DNS', async () => {
    const { resources } = await arrange({
      ...FIXTURE_GAME_SERVERS,
      echo: buildHealthCheckGame({ secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }),
    });

    const endpoints = ofType(mocks.resources, 'aws:ec2/vpcEndpoint:VpcEndpoint');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].inputs).toMatchObject({
      vpcId: 'vpc-123',
      serviceName: 'com.amazonaws.us-east-1.secretsmanager',
      vpcEndpointType: 'Interface',
      subnetIds: ['subnet-0'],
      privateDnsEnabled: true,
    });
    expect(endpoints[0].inputs.securityGroupIds).toEqual([await promiseOf(resources!.securityGroup.id)]);
  });

  // @spec IAC-PROGRAM-NET-003
  it('should share one endpoint across several games that declare auth, including a shared secret', async () => {
    await arrange({
      ...FIXTURE_GAME_SERVERS,
      echo: buildHealthCheckGame({ port: 8211, secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }),
      foxtrot: buildHealthCheckGame({ port: 8212, secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }),
      golf: buildHealthCheckGame({ port: 8213, secretArn: `${FIXTURE_HEALTH_CHECK_SECRET_ARN}-2` }),
    });

    expect(ofType(mocks.resources, 'aws:ec2/vpcEndpoint:VpcEndpoint')).toHaveLength(1);
    const endpointSgs = ofType(mocks.resources, 'aws:ec2/securityGroup:SecurityGroup').filter((r) =>
      r.name.includes('secrets-endpoint'),
    );
    expect(endpointSgs).toHaveLength(1);
  });

  // @spec IAC-PROGRAM-SG-014, IAC-PROGRAM-SG-015, IAC-PROGRAM-SG-016, IAC-PROGRAM-SG-020
  it('should give the endpoint SG no inline rules and one standalone TCP 443 ingress rule from the VPC CIDR', async () => {
    const { resources } = await arrange({
      ...FIXTURE_GAME_SERVERS,
      echo: buildHealthCheckGame({ secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }),
    });
    const sgId = await promiseOf(resources!.securityGroup.id);

    const sg = findByName(mocks.resources, 'hyveon-secrets-endpoint-sg');
    expect(sg.inputs.vpcId).toBe('vpc-123');
    expect(sg.inputs.ingress).toBeUndefined();
    expect(sg.inputs.egress).toBeUndefined();

    const rules = ofType(mocks.resources, 'aws:ec2/securityGroupRule:SecurityGroupRule').filter(
      (r) => r.inputs.securityGroupId === sgId,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].inputs).toMatchObject({
      type: 'ingress',
      fromPort: 443,
      toPort: 443,
      protocol: 'tcp',
      cidrBlocks: [VPC_CIDR],
    });
  });

  // @spec IAC-PROGRAM-SG-017, RT-HEALTH-NET-007
  it('should give the health-check SG one standalone TCP 443 egress rule toward the endpoint SG alongside its port rules', async () => {
    const { securityGroups, resources } = await arrange({
      ...FIXTURE_GAME_SERVERS,
      echo: buildHealthCheckGame({ secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }),
    });
    const healthSgId = await promiseOf(securityGroups.healthCheck!.id);
    const endpointSgId = await promiseOf(resources!.securityGroup.id);

    const egress = ofType(mocks.resources, 'aws:ec2/securityGroupRule:SecurityGroupRule').filter(
      (r) => r.inputs.securityGroupId === healthSgId && r.inputs.type === 'egress',
    );
    expect(egress.map((r) => r.inputs.toPort).sort()).toEqual([443, 8211]);
    const toEndpoint = egress.find((r) => r.inputs.toPort === 443)!;
    expect(toEndpoint.inputs).toMatchObject({ protocol: 'tcp', fromPort: 443, sourceSecurityGroupId: endpointSgId });
  });

  // @spec IAC-PROGRAM-SG-013
  it('should keep the health-check SG all-standalone when the endpoint rule is added', async () => {
    await arrange({ ...FIXTURE_GAME_SERVERS, echo: buildHealthCheckGame({ secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }) });

    const healthSg = findByName(mocks.resources, 'hyveon-health-check-sg');
    expect(healthSg.inputs.egress).toBeUndefined();
    expect(healthSg.inputs.ingress).toBeUndefined();
  });

  // @spec IAC-PROGRAM-NET-005
  it('should throw when auth is declared but no health-check security group exists', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    expect(() =>
      defineSecretsEndpoint({
        projectName: 'hyveon',
        awsRegion: 'us-east-1',
        gameServers: { echo: buildHealthCheckGame({ secretArn: FIXTURE_HEALTH_CHECK_SECRET_ARN }) },
        vpcId: 'vpc-123',
        vpcCidr: VPC_CIDR,
        subnetIds: SUBNET_IDS,
        healthCheckSecurityGroupId: undefined,
        provider,
      }),
    ).toThrow(/healthCheckSecurityGroupId is undefined/);
  });
});
