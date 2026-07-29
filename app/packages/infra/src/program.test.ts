import { beforeEach, describe, expect, it } from 'vitest';
import { createInfraProgram } from './program.js';
import { buildTestDeploymentConfig } from './testing/fixtures.js';
import { installPulumiMocks } from './testing/pulumiMocks.js';

/**
 * Flushes one macrotask tick, giving Pulumi's mocked resource-registration
 * promise chains room to settle. `createInfraProgram`'s closure deliberately
 * exposes no resource handles (see `program.ts`'s file doc — the closure's
 * return value is reserved for real stack outputs, task 3.11's scope, not
 * test plumbing), so unlike `network.test.ts`/`securityGroups.test.ts` this
 * file has no per-resource `Output` to await as a precise completion
 * barrier. One `setImmediate` flush after `await programFn()` was confirmed
 * empirically to be sufficient for a resource graph this size; this test is
 * therefore a coarse wiring/smoke check, not the source of truth for
 * resource shape — the per-field assertions (names, CIDRs, ports, dedup,
 * HTTPS) live in `network.test.ts` and `securityGroups.test.ts`, which do
 * have direct resource handles and use the doc-recommended `promiseOf`
 * pattern instead.
 */
function flushMockRegistrations(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('createInfraProgram', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should return a zero-argument PulumiFn', () => {
    const programFn = createInfraProgram(buildTestDeploymentConfig());
    expect(typeof programFn).toBe('function');
    expect(programFn.length).toBe(0);
  });

  it('should declare the networking and security-group resources when invoked', async () => {
    const programFn = createInfraProgram(buildTestDeploymentConfig({ projectName: 'hyveon' }));
    await programFn();
    await flushMockRegistrations();

    const types = mocks.resources.map((resource) => resource.type);
    expect(types).toContain('aws:ec2/vpc:Vpc');
    expect(types).toContain('aws:ec2/internetGateway:InternetGateway');
    expect(types.filter((type) => type === 'aws:ec2/subnet:Subnet')).toHaveLength(2);
    expect(types).toContain('aws:ec2/routeTable:RouteTable');
    expect(types.filter((type) => type === 'aws:ec2/routeTableAssociation:RouteTableAssociation')).toHaveLength(2);
    expect(types.filter((type) => type === 'aws:ec2/securityGroup:SecurityGroup')).toHaveLength(2);

    const names = mocks.resources.map((resource) => resource.name);
    expect(names).toContain('hyveon-vpc');
    expect(names).toContain('hyveon-sg');
    expect(names).toContain('hyveon-filemgr-sg');
  });

  it('should construct the AWS provider with the region from config.awsRegion', async () => {
    const programFn = createInfraProgram(buildTestDeploymentConfig({ awsRegion: 'eu-west-1' }));
    await programFn();
    await flushMockRegistrations();

    const provider = mocks.resources.find((resource) => resource.type === 'pulumi:providers:aws');
    expect(provider?.inputs.region).toBe('eu-west-1');
  });

  it('should apply the fixed Project=hyveon default tag via the provider regardless of projectName', async () => {
    const programFn = createInfraProgram(buildTestDeploymentConfig({ projectName: 'renamed-project' }));
    await programFn();
    await flushMockRegistrations();

    // Provider resources serialize their config as flat, JSON-stringified
    // string properties under the mock protocol (confirmed empirically),
    // unlike regular resources' nested-object inputs — hence the parse.
    const provider = mocks.resources.find((resource) => resource.type === 'pulumi:providers:aws');
    expect(JSON.parse(provider?.inputs.defaultTags as string)).toEqual({ tags: { Project: 'hyveon' } });

    // Resource *naming* does follow the (renamed) projectName, unlike the tag value above.
    const names = mocks.resources.map((resource) => resource.name);
    expect(names).toContain('renamed-project-vpc');
  });
});
