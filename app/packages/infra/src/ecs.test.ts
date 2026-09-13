import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineEcs } from './ecs.js';
import { defineEfs, type EfsResources } from './efs.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

const MOCK_PUBLIC_SUBNET_IDS = ['subnet-mock-0', 'subnet-mock-1'];

/** Resolves every leaf resource `defineEfs` declares, guaranteeing the mock recorder has captured the full EFS resource set before the dependent `defineEcs` call under test runs. */
async function arrangeEfs(gameServers: Record<string, GameServerConfig>, provider: aws.Provider): Promise<EfsResources> {
  const efs = defineEfs({
    projectName: 'hyveon',
    gameServers,
    publicSubnets: MOCK_PUBLIC_SUBNET_IDS,
    efsSecurityGroupId: 'sg-efs-mock',
    provider,
  });
  await Promise.all([
    ...efs.mountTargets.map((target) => promiseOf(target.id)),
    ...Object.values(efs.gameAccessPoints).map((ap) => promiseOf(ap.id)),
    ...Object.values(efs.caddyDataAccessPoints).map((ap) => promiseOf(ap.id)),
  ]);
  return efs;
}

/** Resolves every leaf resource `defineEcs` declares, guaranteeing the mock recorder has captured the full resource set before assertions run (see `pulumiMocks.ts`'s `promiseOf` doc). */
async function runDefineEcs(args: Parameters<typeof defineEcs>[0]): Promise<ReturnType<typeof defineEcs>> {
  const result = defineEcs(args);
  await Promise.all([
    promiseOf(result.cluster.id),
    ...Object.values(result.logGroups).map((lg) => promiseOf(lg.id)),
    ...Object.values(result.taskDefinitions).map((td) => promiseOf(td.id)),
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

/** Parses a recorded `aws.ecs.TaskDefinition`'s `containerDefinitions` JSON input into its container-object array. */
function parsedContainerDefinitions(resource: RecordedResource): Array<Record<string, unknown>> {
  return JSON.parse(resource.inputs.containerDefinitions as string) as Array<Record<string, unknown>>;
}

describe('defineEcs', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the ECS cluster with containerInsights disabled and the project-prefixed name', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const cluster = findByName(mocks.resources, 'hyveon-cluster');
    expect(cluster.type).toBe('aws:ecs/cluster:Cluster');
    expect(cluster.inputs.name).toBe('hyveon-cluster');
    expect(cluster.inputs.settings).toEqual([{ name: 'containerInsights', value: 'disabled' }]);
    expect(cluster.inputs.tags).toEqual({ Name: 'hyveon-cluster' });
  });

  it('should declare exactly one log group per game, named /ecs/{game}-server with 7-day retention', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    const result = await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    expect(Object.keys(result.logGroups).sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    const logGroups = mocks.resources.filter((resource) => resource.type === 'aws:cloudwatch/logGroup:LogGroup');
    expect(logGroups).toHaveLength(4);
    const alphaLog = findByName(mocks.resources, 'alpha-server-logs');
    expect(alphaLog.inputs.name).toBe('/ecs/alpha-server');
    expect(alphaLog.inputs.retentionInDays).toBe(7);
    expect(alphaLog.inputs.tags).toEqual({ Name: 'alpha-logs', Game: 'alpha' });
  });

  it('should derive per-game task definitions purely from the game-server map, one per game', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    const result = await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    expect(Object.keys(result.taskDefinitions).sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    const taskDefs = mocks.resources.filter((resource) => resource.type === 'aws:ecs/taskDefinition:TaskDefinition');
    expect(taskDefs).toHaveLength(4);
  });

  it('should set family/networkMode/requiresCompatibilities/cpu/memory/executionRoleArn exactly per the HCL, cpu/memory as strings', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const alphaTd = findByName(mocks.resources, 'alpha-server');
    expect(alphaTd.type).toBe('aws:ecs/taskDefinition:TaskDefinition');
    expect(alphaTd.inputs.family).toBe('alpha-server');
    expect(alphaTd.inputs.networkMode).toBe('awsvpc');
    expect(alphaTd.inputs.requiresCompatibilities).toEqual(['FARGATE']);
    expect(alphaTd.inputs.cpu).toBe('1024');
    expect(alphaTd.inputs.memory).toBe('2048');
    expect(alphaTd.inputs.executionRoleArn).toBe('arn:aws:iam::123456789012:role/hyveon-task-execution');
    expect(alphaTd.inputs.tags).toEqual({ Name: 'alpha-server', Game: 'alpha' });
  });

  it('should embed the volume block referencing the matching game access point, transit encryption enabled, iam disabled', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const alphaTd = findByName(mocks.resources, 'alpha-server');
    expect(alphaTd.inputs.volumes).toEqual([
      {
        name: 'alpha-saves',
        efsVolumeConfiguration: {
          fileSystemId: await promiseOf(efs.fileSystem.id),
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: await promiseOf(efs.gameAccessPoints['alpha-saves'].id),
            iam: 'DISABLED',
          },
        },
      },
    ]);
  });

  it('should embed the parsed container definitions with image, ports, environment, mount points, and log configuration for a non-https game', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const alphaTd = findByName(mocks.resources, 'alpha-server');
    const containers = parsedContainerDefinitions(alphaTd);
    expect(containers).toHaveLength(1);
    expect(containers[0]).toEqual({
      name: 'alpha',
      image: 'example/alpha:latest',
      essential: true,
      portMappings: [{ containerPort: 25565, hostPort: 25565, protocol: 'tcp' }],
      environment: [],
      mountPoints: [{ sourceVolume: 'alpha-saves', containerPath: '/data', readOnly: false }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/ecs/alpha-server',
          'awslogs-region': 'us-east-1',
          'awslogs-stream-prefix': 'ecs',
        },
      },
    });
  });

  it('should exclude icmp port entries from portMappings, keeping only tcp/udp entries', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [
          { container: 8, protocol: 'icmp' },
          { container: 8211, protocol: 'udp' },
        ],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    const efs = await arrangeEfs(gameServers, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const echoTd = findByName(mocks.resources, 'echo-server');
    const containers = parsedContainerDefinitions(echoTd);
    expect(containers[0].portMappings).toEqual([{ containerPort: 8211, hostPort: 8211, protocol: 'udp' }]);
  });

  it('should default a game with environment omitted to an empty environment array (matching GameServerConfig.environment\'s optional-field default)', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      onlyGame: {
        image: 'example/game:latest',
        cpu: 512,
        memory: 1024,
        ports: [{ container: 1234, protocol: 'tcp' }],
        volumes: [{ name: 'saves', container_path: '/data' }],
      },
    };
    const efs = await arrangeEfs(gameServers, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const td = findByName(mocks.resources, 'onlyGame-server');
    const containers = parsedContainerDefinitions(td);
    expect(containers[0].environment).toEqual([]);
  });

  it('should include the Caddy sidecar container and its cert volume only for an https: true game', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const deltaTd = findByName(mocks.resources, 'delta-server');
    const containers = parsedContainerDefinitions(deltaTd);
    expect(containers).toHaveLength(2);
    expect(containers[0].name).toBe('delta');

    const caddy = containers[1];
    expect(caddy).toEqual({
      name: 'caddy',
      image: 'caddy:2-alpine',
      essential: true,
      portMappings: [
        { containerPort: 443, hostPort: 443, protocol: 'tcp' },
        { containerPort: 80, hostPort: 80, protocol: 'tcp' },
      ],
      command: ['caddy', 'reverse-proxy', '--from', 'delta.example.com', '--to', 'localhost:8080'],
      mountPoints: [{ sourceVolume: 'delta-caddy-data', containerPath: '/data', readOnly: false }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/ecs/delta-server',
          'awslogs-region': 'us-east-1',
          'awslogs-stream-prefix': 'caddy',
        },
      },
    });

    expect(deltaTd.inputs.volumes).toEqual(
      expect.arrayContaining([
        {
          name: 'delta-caddy-data',
          efsVolumeConfiguration: {
            fileSystemId: await promiseOf(efs.fileSystem.id),
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: await promiseOf(efs.caddyDataAccessPoints.delta.id),
              iam: 'DISABLED',
            },
          },
        },
      ]),
    );
  });

  it('should declare no Caddy sidecar container or cert volume for a non-https game', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const alphaTd = findByName(mocks.resources, 'alpha-server');
    const containers = parsedContainerDefinitions(alphaTd);
    expect(containers.some((container) => container.name === 'caddy')).toBe(false);
    const volumes = alphaTd.inputs.volumes as Array<{ name: string }>;
    expect(volumes.some((volume) => volume.name.includes('caddy'))).toBe(false);
  });

  it('should never declare an aws.ecs.Service — task definitions only, per the no-persistent-service invariant', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const efs = await arrangeEfs(FIXTURE_GAME_SERVERS, provider);
    await runDefineEcs({
      projectName: 'hyveon',
      awsRegion: 'us-east-1',
      hostedZoneName: 'example.com',
      gameServers: FIXTURE_GAME_SERVERS,
      efs,
      executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
      provider,
    });

    const types = mocks.resources.map((resource) => resource.type);
    expect(types).not.toContain('aws:ecs/service:Service');
  });
});
