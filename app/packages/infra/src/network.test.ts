import * as aws from '@pulumi/aws';
import { beforeEach, describe, expect, it } from 'vitest';
import { cidrSubnet, defineNetwork } from './network.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** Resolves every `id` on {@link resources} the network's `RouteTableAssociation`s transitively depend on, guaranteeing the mock recorder has captured every resource `defineNetwork` declares before assertions run — see `pulumiMocks.ts`'s file doc. */
async function runDefineNetwork(
  args: Parameters<typeof defineNetwork>[0],
): Promise<ReturnType<typeof defineNetwork>> {
  const result = defineNetwork(args);
  await Promise.all(result.routeTableAssociations.map((association) => promiseOf(association.id)));
  return result;
}

/** Finds the single recorded resource of the given Pulumi type, failing loudly if there isn't exactly one — keeps test assertions from silently matching zero or multiple resources. */
function findOne(resources: RecordedResource[], type: string): RecordedResource {
  const matches = resources.filter((resource) => resource.type === type);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource of type "${type}", found ${matches.length}`);
  }
  return matches[0];
}

describe('cidrSubnet', () => {
  it('should compute the first public subnet CIDR from a /16 base', () => {
    expect(cidrSubnet('10.0.0.0/16', 8, 0)).toBe('10.0.0.0/24');
  });

  it('should compute the second public subnet CIDR from a /16 base', () => {
    expect(cidrSubnet('10.0.0.0/16', 8, 1)).toBe('10.0.1.0/24');
  });

  it('should compute a subnet CIDR from a non-default base CIDR', () => {
    expect(cidrSubnet('172.16.0.0/16', 8, 2)).toBe('172.16.2.0/24');
  });

  it('should throw when newbits leaves no room in the base CIDR', () => {
    expect(() => cidrSubnet('10.0.0.0/28', 8, 0)).toThrow(/newbits/);
  });
});

describe('defineNetwork', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare a VPC with the project-prefixed name, configured CIDR, and DNS attributes enabled', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineNetwork({ projectName: 'hyveon', vpcCidr: '10.0.0.0/16', provider });

    const vpc = findOne(mocks.resources, 'aws:ec2/vpc:Vpc');
    expect(vpc.name).toBe('hyveon-vpc');
    expect(vpc.inputs.cidrBlock).toBe('10.0.0.0/16');
    expect(vpc.inputs.enableDnsHostnames).toBe(true);
    expect(vpc.inputs.enableDnsSupport).toBe(true);
    expect(vpc.inputs.tags).toEqual({ Name: 'hyveon-vpc' });
  });

  it('should declare an internet gateway attached to the VPC', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineNetwork({ projectName: 'hyveon', vpcCidr: '10.0.0.0/16', provider });

    const igw = findOne(mocks.resources, 'aws:ec2/internetGateway:InternetGateway');
    expect(igw.name).toBe('hyveon-igw');
    expect(igw.inputs.vpcId).toBe(await promiseOf(result.vpc.id));
    expect(igw.inputs.tags).toEqual({ Name: 'hyveon-igw' });
  });

  it('should declare two public subnets with distinct CIDRs, public-IP mapping, and per-index AZs', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineNetwork({ projectName: 'hyveon', vpcCidr: '10.0.0.0/16', provider });

    const subnets = mocks.resources.filter((resource) => resource.type === 'aws:ec2/subnet:Subnet');
    expect(subnets).toHaveLength(2);

    const first = subnets.find((subnet) => subnet.name === 'hyveon-public-0');
    const second = subnets.find((subnet) => subnet.name === 'hyveon-public-1');
    expect(first?.inputs.cidrBlock).toBe('10.0.0.0/24');
    expect(second?.inputs.cidrBlock).toBe('10.0.1.0/24');
    for (const subnet of subnets) {
      expect(subnet.inputs.mapPublicIpOnLaunch).toBe(true);
    }
    expect(first?.inputs.availabilityZone).toBe('us-east-1a');
    expect(second?.inputs.availabilityZone).toBe('us-east-1b');
    expect(first?.inputs.tags).toEqual({ Name: 'hyveon-public-0' });
  });

  it('should declare a public route table with a default route through the internet gateway', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineNetwork({ projectName: 'hyveon', vpcCidr: '10.0.0.0/16', provider });

    const routeTable = findOne(mocks.resources, 'aws:ec2/routeTable:RouteTable');
    expect(routeTable.name).toBe('hyveon-public-rt');
    expect(routeTable.inputs.routes).toEqual([
      { cidrBlock: '0.0.0.0/0', gatewayId: await promiseOf(result.internetGateway.id) },
    ]);
    expect(routeTable.inputs.tags).toEqual({ Name: 'hyveon-public-rt' });
  });

  it('should declare one route-table association per public subnet', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineNetwork({ projectName: 'hyveon', vpcCidr: '10.0.0.0/16', provider });

    const associations = mocks.resources.filter(
      (resource) => resource.type === 'aws:ec2/routeTableAssociation:RouteTableAssociation',
    );
    expect(associations).toHaveLength(2);
    expect(associations.map((association) => association.name).sort()).toEqual([
      'hyveon-public-0-rta',
      'hyveon-public-1-rta',
    ]);
    const routeTableId = await promiseOf(result.routeTable.id);
    for (const association of associations) {
      expect(association.inputs.routeTableId).toBe(routeTableId);
    }
  });
});
