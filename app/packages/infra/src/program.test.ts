import { beforeEach, describe, expect, it } from 'vitest';
import { createInfraProgram, defineAll } from './program.js';
import { buildTestDeploymentConfig } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf } from './testing/pulumiMocks.js';

/**
 * Resolves every leaf resource `defineAll` declares (the network's route
 * table associations, which transitively depend on the VPC/IGW/subnets/route
 * table, plus each independent security group), guaranteeing the mock
 * recorder has captured the entire resource set — including the provider
 * itself, which every one of those resources depends on via `{ provider }`
 * — before assertions run. See `pulumiMocks.ts`'s `promiseOf` doc: this is
 * the same precise-handle pattern `network.test.ts`/`securityGroups.test.ts`
 * use, deliberately NOT the fixed-flush pattern this file used to use (a
 * `setImmediate` guess that only happened to work for a resource graph this
 * small, and risked leaving registrations in flight past the end of a test
 * — see `installPulumiMocks`'s doc on why every test must fully settle
 * before it ends).
 */
async function runDefineAll(config: Parameters<typeof defineAll>[0]): Promise<ReturnType<typeof defineAll>> {
  const result = defineAll(config);
  await Promise.all([
    ...result.network.routeTableAssociations.map((association) => promiseOf(association.id)),
    promiseOf(result.securityGroups.gameServers.id),
    promiseOf(result.securityGroups.fileManager.id),
    promiseOf(result.securityGroups.efs.id),
  ]);
  return result;
}

describe('createInfraProgram', () => {
  it('should return a zero-argument PulumiFn', () => {
    // No mocks needed: constructing the closure does not construct any
    // resource, so there is nothing for `installPulumiMocks` to intercept.
    const programFn = createInfraProgram(buildTestDeploymentConfig());
    expect(typeof programFn).toBe('function');
    expect(programFn.length).toBe(0);
  });

  it('should resolve without throwing when invoked', async () => {
    // Deliberately does not install mocks or inspect `resources`: this test
    // only asserts on the closure's own returned promise, whose
    // resolution/rejection is decided synchronously by the closure body
    // (`defineAll` either throws while declaring resources or it doesn't) —
    // it does not depend on when the mocked resource-registration promise
    // chains settle, so it needs no completion barrier and installs no mocks
    // for later tests to accidentally race against.
    installPulumiMocks();
    const programFn = createInfraProgram(buildTestDeploymentConfig());
    await expect(programFn()).resolves.toBeUndefined();
  });
});

describe('defineAll', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the full networking and security-group resource set', async () => {
    await runDefineAll(buildTestDeploymentConfig({ projectName: 'hyveon' }));

    const types = mocks.resources.map((resource) => resource.type);
    expect(types).toContain('aws:ec2/vpc:Vpc');
    expect(types).toContain('aws:ec2/internetGateway:InternetGateway');
    expect(types.filter((type) => type === 'aws:ec2/subnet:Subnet')).toHaveLength(2);
    expect(types).toContain('aws:ec2/routeTable:RouteTable');
    expect(types.filter((type) => type === 'aws:ec2/routeTableAssociation:RouteTableAssociation')).toHaveLength(2);
    expect(types.filter((type) => type === 'aws:ec2/securityGroup:SecurityGroup')).toHaveLength(3);

    const names = mocks.resources.map((resource) => resource.name);
    expect(names).toContain('hyveon-vpc');
    expect(names).toContain('hyveon-sg');
    expect(names).toContain('hyveon-filemgr-sg');
    expect(names).toContain('hyveon-efs-sg');
  });

  it('should construct the AWS provider with the region from config.awsRegion', async () => {
    await runDefineAll(buildTestDeploymentConfig({ awsRegion: 'eu-west-1' }));

    const provider = mocks.resources.find((resource) => resource.type === 'pulumi:providers:aws');
    expect(provider?.inputs.region).toBe('eu-west-1');
  });

  it('should apply the fixed Project=hyveon default tag via the provider regardless of projectName', async () => {
    await runDefineAll(buildTestDeploymentConfig({ projectName: 'renamed-project' }));

    // Provider resources serialize their config as flat, JSON-stringified
    // string properties under the mock protocol (confirmed empirically),
    // unlike regular resources' nested-object inputs — hence the parse.
    const provider = mocks.resources.find((resource) => resource.type === 'pulumi:providers:aws');
    expect(JSON.parse(provider?.inputs.defaultTags as string)).toEqual({ tags: { Project: 'hyveon' } });

    // Resource *naming* does follow the (renamed) projectName, unlike the tag value above.
    const names = mocks.resources.map((resource) => resource.name);
    expect(names).toContain('renamed-project-vpc');
  });

  it('should wire the efs security group ingress to the game-servers and file-manager group ids', async () => {
    const result = await runDefineAll(buildTestDeploymentConfig());

    const efsSg = mocks.resources.find((resource) => resource.name === 'hyveon-efs-sg');
    expect(efsSg?.inputs.ingress).toEqual([
      {
        description: 'NFS from game servers',
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        securityGroups: [
          await promiseOf(result.securityGroups.gameServers.id),
          await promiseOf(result.securityGroups.fileManager.id),
        ],
      },
    ]);
  });
});
