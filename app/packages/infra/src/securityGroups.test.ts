import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { dedupedDirectGamePorts, dedupedInternalGamePorts, defineSecurityGroups, hasHttpsGame } from './securityGroups.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** Resolves every security group `defineSecurityGroups` declares (including the conditional `efsSeeder`, when present), guaranteeing the mock recorder has captured everything before assertions run — see `pulumiMocks.ts`'s file doc. */
async function runDefineSecurityGroups(
  args: Parameters<typeof defineSecurityGroups>[0],
): Promise<ReturnType<typeof defineSecurityGroups>> {
  const result = defineSecurityGroups(args);
  await Promise.all([
    promiseOf(result.gameServers.id),
    promiseOf(result.fileManager.id),
    promiseOf(result.efs.id),
    ...(result.efsSeeder ? [promiseOf(result.efsSeeder.id)] : []),
    ...(result.efsSeederEgressRule ? [promiseOf(result.efsSeederEgressRule.id)] : []),
    ...(result.healthCheck ? [promiseOf(result.healthCheck.id)] : []),
    ...result.healthCheckEgressRules.map((rule) => promiseOf(rule.id)),
  ]);
  return result;
}

/** A `gameServers` map extending {@link FIXTURE_GAME_SERVERS} with one game (`echo`) declaring a `healthCheck` on port 8211. */
const GAME_SERVERS_WITH_HEALTH_CHECK: Record<string, GameServerConfig> = {
  ...FIXTURE_GAME_SERVERS,
  echo: {
    image: 'example/echo:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 8211, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    healthCheck: {
      kind: 'http',
      scheme: 'http',
      port: 8211,
      path: '/status',
      method: 'GET',
      timeoutMs: 2000,
      activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 },
    },
  },
};

/** Finds the single recorded resource with the given Pulumi logical name, failing loudly if there isn't exactly one. */
function findByName(resources: RecordedResource[], name: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

describe('dedupedDirectGamePorts', () => {
  it('should collapse two games sharing the same port and protocol into one entry', () => {
    expect(dedupedDirectGamePorts(FIXTURE_GAME_SERVERS)).toEqual([
      { port: 25565, protocol: 'tcp' },
      { port: 7777, protocol: 'udp' },
    ]);
  });

  it('should treat an omitted https field the same as https: false', () => {
    const gameServers: Record<string, GameServerConfig> = {
      onlyGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 1234, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        // `https` intentionally omitted.
      },
    };
    expect(dedupedDirectGamePorts(gameServers)).toEqual([{ port: 1234, protocol: 'tcp' }]);
  });

  it('should exclude ports belonging to an https: true game', () => {
    const gameServers: Record<string, GameServerConfig> = {
      httpsGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 8080, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        https: true,
      },
    };
    expect(dedupedDirectGamePorts(gameServers)).toEqual([]);
  });

  it('should exclude ports declared visibility: "internal"', () => {
    const gameServers: Record<string, GameServerConfig> = {
      mixedGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [
          { container: 25565, protocol: 'tcp' },
          { container: 8212, protocol: 'tcp', visibility: 'internal' },
        ],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    expect(dedupedDirectGamePorts(gameServers)).toEqual([{ port: 25565, protocol: 'tcp' }]);
  });

  it('should treat visibility: "public" the same as omitting visibility', () => {
    const gameServers: Record<string, GameServerConfig> = {
      onlyGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 1234, protocol: 'tcp', visibility: 'public' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    expect(dedupedDirectGamePorts(gameServers)).toEqual([{ port: 1234, protocol: 'tcp' }]);
  });
});

describe('dedupedInternalGamePorts', () => {
  it('should return only ports declared visibility: "internal"', () => {
    const gameServers: Record<string, GameServerConfig> = {
      mixedGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [
          { container: 25565, protocol: 'tcp' },
          { container: 8212, protocol: 'tcp', visibility: 'internal' },
        ],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    expect(dedupedInternalGamePorts(gameServers)).toEqual([{ port: 8212, protocol: 'tcp' }]);
  });

  it('should exclude ports belonging to an https: true game', () => {
    const gameServers: Record<string, GameServerConfig> = {
      httpsGame: {
        image: 'example/game:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 8212, protocol: 'tcp', visibility: 'internal' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        https: true,
      },
    };
    expect(dedupedInternalGamePorts(gameServers)).toEqual([]);
  });

  it('should return an empty array when no game declares an internal port', () => {
    expect(dedupedInternalGamePorts(FIXTURE_GAME_SERVERS)).toEqual([]);
  });
});

describe('hasHttpsGame', () => {
  it('should return true when at least one game has https: true', () => {
    expect(hasHttpsGame(FIXTURE_GAME_SERVERS)).toBe(true);
  });

  it('should return false when no game has https: true', () => {
    const { delta: _delta, ...withoutHttpsGame } = FIXTURE_GAME_SERVERS;
    expect(hasHttpsGame(withoutHttpsGame)).toBe(false);
  });
});

describe('defineSecurityGroups', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the game-servers security group with a deduplicated ingress rule per distinct port and the 443/80 HTTPS rules', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      vpcId: 'vpc-mock',
      provider,
    });

    const sg = findByName(mocks.resources, 'hyveon-sg');
    expect(sg.type).toBe('aws:ec2/securityGroup:SecurityGroup');
    expect(sg.inputs.namePrefix).toBe('hyveon-sg-');
    expect(sg.inputs.vpcId).toBe('vpc-mock');
    expect(sg.inputs.tags).toEqual({ Name: 'hyveon-sg' });

    // Exactly one rule per distinct (port, protocol) pair across alpha/bravo
    // (deduplicated) and charlie, plus the 443/80 HTTPS-sidecar rules
    // triggered by delta's `https: true` — never a rule for delta's own
    // 8080/tcp container port.
    expect(sg.inputs.ingress).toEqual([
      { description: 'Game port 25565/tcp', fromPort: 25565, toPort: 25565, protocol: 'tcp', cidrBlocks: ['0.0.0.0/0'] },
      { description: 'Game port 7777/udp', fromPort: 7777, toPort: 7777, protocol: 'udp', cidrBlocks: ['0.0.0.0/0'] },
      {
        description: 'Caddy sidecar (HTTPS/ACME) port 443/tcp',
        fromPort: 443,
        toPort: 443,
        protocol: 'tcp',
        cidrBlocks: ['0.0.0.0/0'],
      },
      {
        description: 'Caddy sidecar (HTTPS/ACME) port 80/tcp',
        fromPort: 80,
        toPort: 80,
        protocol: 'tcp',
        cidrBlocks: ['0.0.0.0/0'],
      },
    ]);
    expect(sg.inputs.egress).toEqual([{ fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: ['0.0.0.0/0'] }]);
  });

  it('should ingress a visibility: "internal" port from the VPC CIDR block instead of the open internet', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 8212, protocol: 'tcp', visibility: 'internal' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    await runDefineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-mock', provider });

    const sg = findByName(mocks.resources, 'hyveon-sg');
    const ingress = sg.inputs.ingress as Array<{ description: string; fromPort: number; cidrBlocks?: string[] }>;
    const internalRule = ingress.find((rule) => rule.fromPort === 8212);
    expect(internalRule).toBeDefined();
    expect(internalRule?.cidrBlocks).toEqual(['10.0.0.0/16']);
    expect(ingress.some((rule) => rule.fromPort === 8212 && rule.cidrBlocks?.includes('0.0.0.0/0'))).toBe(false);
  });

  it('should declare no 443/80 HTTPS rules when no game has https: true', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const { delta: _delta, ...withoutHttpsGame } = FIXTURE_GAME_SERVERS;
    await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: withoutHttpsGame,
      vpcId: 'vpc-mock',
      provider,
    });

    const sg = findByName(mocks.resources, 'hyveon-sg');
    const ingress = sg.inputs.ingress as Array<{ description: string }>;
    expect(ingress.some((rule) => rule.description.includes('Caddy sidecar'))).toBe(false);
  });

  it('should declare the file-manager security group with its fixed port-8080 ingress rule', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      vpcId: 'vpc-mock',
      provider,
    });

    const sg = findByName(mocks.resources, 'hyveon-filemgr-sg');
    expect(sg.type).toBe('aws:ec2/securityGroup:SecurityGroup');
    expect(sg.inputs.namePrefix).toBe('hyveon-filemgr-sg-');
    expect(sg.inputs.ingress).toEqual([
      { description: 'FileBrowser web UI', fromPort: 8080, toPort: 8080, protocol: 'tcp', cidrBlocks: ['0.0.0.0/0'] },
    ]);
    expect(sg.inputs.egress).toEqual([{ fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: ['0.0.0.0/0'] }]);
    expect(sg.inputs.tags).toEqual({ Name: 'hyveon-filemgr-sg' });
  });

  it('should declare the efs security group with NFS ingress from the game-servers and file-manager groups only, and no efsSeeder group, when no game declares file_seeds', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      vpcId: 'vpc-mock',
      provider,
    });

    expect(result.efsSeeder).toBeUndefined();
    expect(mocks.resources.some((resource) => resource.name === 'hyveon-efs-seeder-sg')).toBe(false);

    const sg = findByName(mocks.resources, 'hyveon-efs-sg');
    expect(sg.type).toBe('aws:ec2/securityGroup:SecurityGroup');
    expect(sg.inputs.namePrefix).toBe('hyveon-efs-sg-');
    expect(sg.inputs.vpcId).toBe('vpc-mock');
    expect(sg.inputs.tags).toEqual({ Name: 'hyveon-efs-sg' });

    // Exactly one ingress rule (NFS from game_servers + file_manager) — no
    // seeder-sourced entry when no game declares file_seeds.
    expect(sg.inputs.ingress).toEqual([
      {
        description: 'NFS from game servers',
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        securityGroups: [await promiseOf(result.gameServers.id), await promiseOf(result.fileManager.id)],
      },
    ]);
    expect(sg.inputs.egress).toEqual([{ fromPort: 0, toPort: 0, protocol: '-1', cidrBlocks: ['0.0.0.0/0'] }]);
  });

  it('should declare the shared efs_seeder security group and a second in-line efs ingress entry sourced from it when a game declares file_seeds', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 1234, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        file_seeds: [{ path: '/data/config.yml', content: 'foo: bar' }],
      },
    };
    const result = await runDefineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-mock', provider });

    expect(result.efsSeeder).toBeDefined();
    const seederSg = findByName(mocks.resources, 'hyveon-efs-seeder-sg');
    expect(seederSg.type).toBe('aws:ec2/securityGroup:SecurityGroup');
    expect(seederSg.inputs.namePrefix).toBe('hyveon-efs-seeder-sg-v2-');
    expect(seederSg.inputs.vpcId).toBe('vpc-mock');
    expect(seederSg.inputs.description).toBe('EFS seeder Lambdas — outbound NFS to EFS only');
    // No inline egress on the seeder group itself — its one egress need is a
    // standalone `SecurityGroupRule`, asserted in its own test below (issue #349).
    expect(seederSg.inputs.egress).toBeUndefined();

    // The seeder's INGRESS-side rule (into `efs`) must still be a second
    // in-line entry in `efs`'s own `ingress` array, never a standalone rule
    // on `efs` itself — see this file's doc for why mixing the two on the
    // SAME group is unsafe. This is a distinct concern from the seeder
    // group's own standalone EGRESS rule, asserted below.
    const efsSg = findByName(mocks.resources, 'hyveon-efs-sg');
    expect(efsSg.inputs.ingress).toEqual([
      {
        description: 'NFS from game servers',
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        securityGroups: [await promiseOf(result.gameServers.id), await promiseOf(result.fileManager.id)],
      },
      {
        description: 'NFS from EFS seeder Lambdas',
        fromPort: 2049,
        toPort: 2049,
        protocol: 'tcp',
        securityGroups: [await promiseOf(result.efsSeeder?.id ?? Promise.reject(new Error('expected an efsSeeder security group')))],
      },
    ]);
  });

  it('should scope the efs_seeder security group egress to NFS-only against the efs security group via a standalone rule, when a game declares file_seeds', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 1234, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        file_seeds: [{ path: '/data/config.yml', content: 'foo: bar' }],
      },
    };
    const result = await runDefineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-mock', provider });

    expect(result.efsSeederEgressRule).toBeDefined();
    const rule = findByName(mocks.resources, 'hyveon-efs-seeder-egress');
    expect(rule.type).toBe('aws:ec2/securityGroupRule:SecurityGroupRule');
    expect(rule.inputs.type).toBe('egress');
    expect(rule.inputs.fromPort).toBe(2049);
    expect(rule.inputs.toPort).toBe(2049);
    expect(rule.inputs.protocol).toBe('tcp');
    expect(rule.inputs.securityGroupId).toBe(await promiseOf(result.efsSeeder!.id));
    expect(rule.inputs.sourceSecurityGroupId).toBe(await promiseOf(result.efs.id));

    // Exactly one standalone SecurityGroupRule in the whole graph — the
    // seeder's own egress. Its ingress-side counterpart into `efs` stays a
    // second in-line entry in `efs`'s own array (asserted above), never a
    // second standalone rule.
    expect(mocks.resources.filter((resource) => resource.type === 'aws:ec2/securityGroupRule:SecurityGroupRule')).toHaveLength(1);
  });

  it('should declare no efsSeederEgressRule when no game declares file_seeds', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecurityGroups({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, vpcId: 'vpc-mock', provider });

    expect(result.efsSeederEgressRule).toBeUndefined();
    expect(mocks.resources.some((resource) => resource.type === 'aws:ec2/securityGroupRule:SecurityGroupRule')).toBe(false);
  });

  it('should add only one new ingress rule when a new game entry reuses an existing port', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 25565, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    await runDefineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-mock', provider });

    const sg = findByName(mocks.resources, 'hyveon-sg');
    const ingress = sg.inputs.ingress as Array<{ fromPort: number }>;
    expect(ingress.filter((rule) => rule.fromPort === 25565)).toHaveLength(1);
  });

  it('should declare no health-check security group or egress rules when no game declares healthCheck', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      vpcId: 'vpc-mock',
      provider,
    });

    expect(result.healthCheck).toBeUndefined();
    expect(result.healthCheckEgressRules).toEqual([]);
    expect(mocks.resources.some((resource) => resource.name === 'hyveon-health-check-sg')).toBe(false);
  });

  it('should declare the health-check security group with no inline egress, and a matching ingress entry on the game-servers group, when a game declares healthCheck', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: GAME_SERVERS_WITH_HEALTH_CHECK,
      vpcId: 'vpc-mock',
      provider,
    });

    expect(result.healthCheck).toBeDefined();
    const healthCheckSg = findByName(mocks.resources, 'hyveon-health-check-sg');
    expect(healthCheckSg.type).toBe('aws:ec2/securityGroup:SecurityGroup');
    expect(healthCheckSg.inputs.namePrefix).toBe('hyveon-health-check-sg-');
    expect(healthCheckSg.inputs.vpcId).toBe('vpc-mock');
    // No inline egress — its egress need is a standalone `SecurityGroupRule`, asserted below.
    expect(healthCheckSg.inputs.egress).toBeUndefined();

    const gameServersSg = findByName(mocks.resources, 'hyveon-sg');
    const ingress = gameServersSg.inputs.ingress as Array<{ description: string; fromPort: number; securityGroups?: string[] }>;
    const healthCheckIngress = ingress.find((rule) => rule.description === 'Health-check Lambda — port 8211/tcp');
    expect(healthCheckIngress).toBeDefined();
    expect(healthCheckIngress?.fromPort).toBe(8211);
    expect(healthCheckIngress?.securityGroups).toEqual([await promiseOf(result.healthCheck!.id)]);
  });

  it('should scope the health-check security group egress to declared ports only, via a standalone rule per port', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: GAME_SERVERS_WITH_HEALTH_CHECK,
      vpcId: 'vpc-mock',
      provider,
    });

    expect(result.healthCheckEgressRules).toHaveLength(1);
    const rule = findByName(mocks.resources, 'hyveon-health-check-egress-8211');
    expect(rule.type).toBe('aws:ec2/securityGroupRule:SecurityGroupRule');
    expect(rule.inputs.type).toBe('egress');
    expect(rule.inputs.fromPort).toBe(8211);
    expect(rule.inputs.toPort).toBe(8211);
    expect(rule.inputs.protocol).toBe('tcp');
    expect(rule.inputs.securityGroupId).toBe(await promiseOf(result.healthCheck!.id));
    expect(rule.inputs.sourceSecurityGroupId).toBe(await promiseOf(result.gameServers.id));
  });

  it('should declare only one egress rule per distinct health-check port across multiple games', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...GAME_SERVERS_WITH_HEALTH_CHECK,
      foxtrot: {
        image: 'example/foxtrot:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 8211, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
        healthCheck: { ...GAME_SERVERS_WITH_HEALTH_CHECK.echo.healthCheck! },
      },
    };
    const result = await runDefineSecurityGroups({ projectName: 'hyveon', gameServers, vpcId: 'vpc-mock', provider });

    expect(result.healthCheckEgressRules).toHaveLength(1);
    expect(
      mocks.resources.filter((resource) => resource.type === 'aws:ec2/securityGroupRule:SecurityGroupRule'),
    ).toHaveLength(1);
  });
});
