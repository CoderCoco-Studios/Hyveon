/**
 * VPC / networking resources: the VPC itself, its internet gateway, two
 * public subnets, the shared public route table, and the per-subnet route
 * table associations.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** Every resource {@link defineNetwork} declares, keyed by role. */
export interface NetworkResources {
  /** The VPC. */
  vpc: aws.ec2.Vpc;
  /** The internet gateway attached to {@link vpc}. */
  internetGateway: aws.ec2.InternetGateway;
  /**
   * The public subnets, in index order. Always {@link PUBLIC_SUBNET_COUNT}
   * entries — a fixed constant rather than a count derived from any
   * configuration input.
   */
  publicSubnets: aws.ec2.Subnet[];
  /** The shared public route table. */
  routeTable: aws.ec2.RouteTable;
  /** One association per entry in {@link publicSubnets}, same order. */
  routeTableAssociations: aws.ec2.RouteTableAssociation[];
}

/** Arguments {@link defineNetwork} needs to declare the networking resources. */
export interface DefineNetworkArgs {
  /** Project name — every resource name/tag below is `${projectName}-...`. */
  projectName: string;
  /** The VPC's CIDR block, and the base range {@link cidrSubnet} carves the public subnets out of. */
  vpcCidr: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Number of public subnets to declare — a hardcoded constant, not driven by
 * any configuration variable, so it stays a hardcoded constant here too
 * rather than becoming a spurious `DeploymentConfig` field.
 */
const PUBLIC_SUBNET_COUNT = 2;

/**
 * Derives one subnet's CIDR block from a base IPv4 CIDR block, network-bit
 * count, and subnet index — the same arithmetic Terraform's built-in
 * `cidrsubnet` function performs, since Pulumi has no built-in equivalent.
 * `vpcCidr` flows into this program as a plain captured string
 * (`DeploymentConfig`, not `pulumi.Config`), so this runs synchronously in
 * plain JS rather than through `pulumi.Output.apply`.
 *
 * Only handles well-formed IPv4 CIDR blocks whose host bits are already
 * zero — true of every `vpcCidr` the app's config validation accepts,
 * including the default `"10.0.0.0/16"`.
 *
 * @param baseCidr - The base IPv4 CIDR block (e.g. `"10.0.0.0/16"`).
 * @param newBits - Additional network bits to carve out (e.g. `8` turns a
 *   `/16` into a `/24`).
 * @param netNum - Which of the resulting `2 ** newBits` subnets to return,
 *   0-indexed.
 * @returns The resulting subnet CIDR block (e.g. `"10.0.1.0/24"`).
 */
export function cidrSubnet(baseCidr: string, newBits: number, netNum: number): string {
  const [address, prefixLenRaw] = baseCidr.split('/');
  const prefixLen = Number(prefixLenRaw);
  const newPrefixLen = prefixLen + newBits;
  if (newPrefixLen > 32) {
    throw new Error(`cidrSubnet: newbits ${newBits} leaves no room in ${baseCidr} for netnum ${netNum}`);
  }

  const octets = address.split('.').map(Number);
  const baseInt = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
  const hostBits = 32 - newPrefixLen;
  const subnetInt = baseInt + netNum * 2 ** hostBits;

  const a = Math.floor(subnetInt / 256 ** 3) % 256;
  const b = Math.floor(subnetInt / 256 ** 2) % 256;
  const c = Math.floor(subnetInt / 256) % 256;
  const d = subnetInt % 256;
  return `${a}.${b}.${c}.${d}/${newPrefixLen}`;
}

/**
 * Declares the VPC, internet gateway, public subnets, route table, and
 * route-table associations. Must be called from inside the Pulumi
 * inline-program closure (see `program.ts`'s {@link createInfraProgram}),
 * never at module scope.
 *
 * @param args - Naming and provider inputs — see {@link DefineNetworkArgs}.
 * @returns The declared resources — see {@link NetworkResources}.
 */
export function defineNetwork(args: DefineNetworkArgs): NetworkResources {
  const { projectName, vpcCidr, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  const vpc = new aws.ec2.Vpc(
    `${projectName}-vpc`,
    {
      cidrBlock: vpcCidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: `${projectName}-vpc` },
    },
    opts,
  );

  const internetGateway = new aws.ec2.InternetGateway(
    `${projectName}-igw`,
    {
      vpcId: vpc.id,
      tags: { Name: `${projectName}-igw` },
    },
    opts,
  );

  // Available AZ names — queried once and indexed per subnet below.
  const availabilityZoneNames = aws.getAvailabilityZonesOutput({ state: 'available' }, { provider }).names;

  const publicSubnets: aws.ec2.Subnet[] = [];
  for (let index = 0; index < PUBLIC_SUBNET_COUNT; index += 1) {
    publicSubnets.push(
      new aws.ec2.Subnet(
        `${projectName}-public-${index}`,
        {
          vpcId: vpc.id,
          cidrBlock: cidrSubnet(vpcCidr, 8, index),
          availabilityZone: availabilityZoneNames.apply((names) => names[index]),
          mapPublicIpOnLaunch: true,
          tags: { Name: `${projectName}-public-${index}` },
        },
        opts,
      ),
    );
  }

  const routeTable = new aws.ec2.RouteTable(
    `${projectName}-public-rt`,
    {
      vpcId: vpc.id,
      routes: [{ cidrBlock: '0.0.0.0/0', gatewayId: internetGateway.id }],
      tags: { Name: `${projectName}-public-rt` },
    },
    opts,
  );

  const routeTableAssociations = publicSubnets.map(
    (subnet, index) =>
      new aws.ec2.RouteTableAssociation(
        `${projectName}-public-${index}-rta`,
        {
          subnetId: subnet.id,
          routeTableId: routeTable.id,
        },
        opts,
      ),
  );

  return { vpc, internetGateway, publicSubnets, routeTable, routeTableAssociations };
}
