import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { dedupedDirectGamePorts, defineSecurityGroups, hasHttpsGame } from './securityGroups.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** Resolves all three security groups' `id`s, guaranteeing the mock recorder has captured everything `defineSecurityGroups` declares before assertions run — see `pulumiMocks.ts`'s file doc. */
async function runDefineSecurityGroups(
  args: Parameters<typeof defineSecurityGroups>[0],
): Promise<ReturnType<typeof defineSecurityGroups>> {
  const result = defineSecurityGroups(args);
  await Promise.all([promiseOf(result.gameServers.id), promiseOf(result.fileManager.id), promiseOf(result.efs.id)]);
  return result;
}

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

  it('should declare the efs security group with NFS ingress from the game-servers and file-manager groups, and no seeder rule', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecurityGroups({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      vpcId: 'vpc-mock',
      provider,
    });

    const sg = findByName(mocks.resources, 'hyveon-efs-sg');
    expect(sg.type).toBe('aws:ec2/securityGroup:SecurityGroup');
    expect(sg.inputs.namePrefix).toBe('hyveon-efs-sg-');
    expect(sg.inputs.vpcId).toBe('vpc-mock');
    expect(sg.inputs.tags).toEqual({ Name: 'hyveon-efs-sg' });

    // Exactly one ingress rule (NFS from game_servers + file_manager) — the
    // HCL's second, seeder-sourced rule is deliberately not ported here
    // (task 3.6 adds it alongside `aws_security_group.efs_seeder`).
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
});
