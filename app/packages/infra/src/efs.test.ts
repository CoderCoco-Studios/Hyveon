import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineEfs } from './efs.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** The public subnet IDs passed to every `defineEfs` call under test — plain mock IDs, matching `securityGroups.test.ts`'s `vpcId: 'vpc-mock'` pattern rather than constructing real `aws.ec2.Subnet` resources this module never touches beyond `.id`. */
const MOCK_PUBLIC_SUBNET_IDS = ['subnet-mock-0', 'subnet-mock-1'];

/** Resolves every leaf resource `defineEfs` declares, guaranteeing the mock recorder has captured the full resource set before assertions run (see `pulumiMocks.ts`'s `promiseOf` doc). */
async function runDefineEfs(args: Parameters<typeof defineEfs>[0]): Promise<ReturnType<typeof defineEfs>> {
  const result = defineEfs(args);
  await Promise.all([
    ...result.mountTargets.map((target) => promiseOf(target.id)),
    ...Object.values(result.gameAccessPoints).map((ap) => promiseOf(ap.id)),
    ...Object.values(result.caddyDataAccessPoints).map((ap) => promiseOf(ap.id)),
  ]);
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

describe('defineEfs', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the shared EFS filesystem, encrypted, with the project-prefixed creation token', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineEfs({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
      efsSecurityGroupId: 'sg-efs-mock',
      provider,
    });

    const fs = findByName(mocks.resources, 'hyveon-saves');
    expect(fs.type).toBe('aws:efs/fileSystem:FileSystem');
    expect(fs.inputs.creationToken).toBe('hyveon-saves');
    expect(fs.inputs.encrypted).toBe(true);
    expect(fs.inputs.tags).toEqual({ Name: 'hyveon-saves' });
  });

  it('should declare one mount target per public subnet, referencing the efs security group', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineEfs({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
      efsSecurityGroupId: 'sg-efs-mock',
      provider,
    });

    expect(result.mountTargets).toHaveLength(2);
    const targets = mocks.resources.filter((resource) => resource.type === 'aws:efs/mountTarget:MountTarget');
    expect(targets).toHaveLength(2);
    expect(targets.map((target) => target.inputs.subnetId).sort()).toEqual(['subnet-mock-0', 'subnet-mock-1']);
    for (const target of targets) {
      expect(target.inputs.securityGroups).toEqual(['sg-efs-mock']);
      expect(target.inputs.fileSystemId).toBe(await promiseOf(result.fileSystem.id));
    }
  });

  it('should declare exactly one access point per (game, volume) pair with posix/root-directory attributes byte-faithful to the HCL', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineEfs({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
      efsSecurityGroupId: 'sg-efs-mock',
      provider,
    });

    // Every FIXTURE_GAME_SERVERS entry declares exactly one "saves" volume.
    expect(Object.keys(result.gameAccessPoints).sort()).toEqual(['alpha-saves', 'bravo-saves', 'charlie-saves', 'delta-saves']);

    const alphaAp = findByName(mocks.resources, 'alpha-saves');
    expect(alphaAp.type).toBe('aws:efs/accessPoint:AccessPoint');
    expect(alphaAp.inputs.fileSystemId).toBe(await promiseOf(result.fileSystem.id));
    expect(alphaAp.inputs.posixUser).toEqual({ uid: 1000, gid: 1000 });
    expect(alphaAp.inputs.rootDirectory).toEqual({
      path: '/alpha/saves',
      creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: '0755' },
    });
    expect(alphaAp.inputs.tags).toEqual({ Name: 'alpha-saves' });
  });

  it('should add exactly the new access points for a newly-added game with two volumes', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [{ container: 9999, protocol: 'tcp' }],
        volumes: [
          { name: 'saves', container_path: '/data' },
          { name: 'mods', container_path: '/mods' },
        ],
      },
    };
    const result = await runDefineEfs({
      projectName: 'hyveon',
      gameServers,
      publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
      efsSecurityGroupId: 'sg-efs-mock',
      provider,
    });

    expect(Object.keys(result.gameAccessPoints).sort()).toEqual([
      'alpha-saves',
      'bravo-saves',
      'charlie-saves',
      'delta-saves',
      'echo-mods',
      'echo-saves',
    ]);
    const echoMods = findByName(mocks.resources, 'echo-mods');
    expect(echoMods.inputs.rootDirectory).toMatchObject({ path: '/echo/mods' });
  });

  it('should declare a certificate-storage access point only for the https: true game', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineEfs({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
      efsSecurityGroupId: 'sg-efs-mock',
      provider,
    });

    // Only `delta` has `https: true` in FIXTURE_GAME_SERVERS; `alpha` omits
    // `https`, `bravo` sets it explicitly to `false` — neither gets a cert AP.
    expect(Object.keys(result.caddyDataAccessPoints)).toEqual(['delta']);

    const deltaCert = findByName(mocks.resources, 'delta-caddy-data');
    expect(deltaCert.type).toBe('aws:efs/accessPoint:AccessPoint');
    expect(deltaCert.inputs.fileSystemId).toBe(await promiseOf(result.fileSystem.id));
    expect(deltaCert.inputs.posixUser).toEqual({ uid: 1000, gid: 1000 });
    expect(deltaCert.inputs.rootDirectory).toEqual({
      path: '/delta/caddy-data',
      creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: '0755' },
    });
    expect(deltaCert.inputs.tags).toEqual({ Name: 'delta-certs' });
  });

  it('should declare no certificate-storage access points when no game has https: true', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const { delta: _delta, ...withoutHttpsGame } = FIXTURE_GAME_SERVERS;
    const result = await runDefineEfs({
      projectName: 'hyveon',
      gameServers: withoutHttpsGame,
      publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
      efsSecurityGroupId: 'sg-efs-mock',
      provider,
    });

    expect(result.caddyDataAccessPoints).toEqual({});
  });
});
