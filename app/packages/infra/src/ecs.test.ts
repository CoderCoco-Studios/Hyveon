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

  // @spec IAC-PROGRAM-ECS-001
  it('should declare the ECS cluster with containerInsights enabled and the project-prefixed name', async () => {
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
    expect(cluster.inputs.settings).toEqual([{ name: 'containerInsights', value: 'enabled' }]);
    expect(cluster.inputs.tags).toEqual({ Name: 'hyveon-cluster' });
  });

  // @spec IAC-PROGRAM-ECS-004
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
    expect(logGroups).toHaveLength(8);
    const alphaLog = findByName(mocks.resources, 'alpha-server-logs');
    expect(alphaLog.inputs.name).toBe('/ecs/alpha-server');
    expect(alphaLog.inputs.retentionInDays).toBe(7);
    expect(alphaLog.inputs.tags).toEqual({ Name: 'alpha-logs', Game: 'alpha' });
  });

  // @spec IAC-PROGRAM-ECS-004
  it('should pre-create one /ecs/filebrowser-{game} log group per game with 7-day retention', async () => {
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

    expect(Object.keys(result.fileManagerLogGroups).sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    const alphaLog = findByName(mocks.resources, 'alpha-filebrowser-logs');
    expect(alphaLog.type).toBe('aws:cloudwatch/logGroup:LogGroup');
    expect(alphaLog.inputs.name).toBe('/ecs/filebrowser-alpha');
    expect(alphaLog.inputs.retentionInDays).toBe(7);
    expect(alphaLog.inputs.tags).toEqual({ Name: 'alpha-filebrowser-logs', Game: 'alpha' });
  });

  // @spec IAC-PROGRAM-FANOUT-001
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

  // @spec IAC-PROGRAM-ECS-003, IAC-PROGRAM-IAM-001
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

  // @spec IAC-PROGRAM-ECS-005
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

  // @spec IAC-PROGRAM-ECS-006, IAC-PROGRAM-ECS-007
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

  // @spec IAC-PROGRAM-ECS-006
  // @spec GAME-PORT-011
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

  it('should exclude a case-variant "ICMP" port entry from portMappings too', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      echo: {
        image: 'example/echo:latest',
        cpu: 1024,
        memory: 2048,
        ports: [
          { container: 8, protocol: 'ICMP' },
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

  // @spec IAC-PROGRAM-TLS-001, IAC-PROGRAM-TLS-003
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

  // @spec IAC-PROGRAM-ECS-006, IAC-PROGRAM-TLS-001
  it('should map webPort plus tcp/udp extras (not icmp) and proxy each https game to its own webPort', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const common = { image: 'example/game:latest', cpu: 1024, memory: 2048, https: true, volumes: [{ name: 'saves', container_path: '/data' }] };
    const gameServers: Record<string, GameServerConfig> = {
      web1: { ...common, webPort: 30000, ports: [{ container: 30001, protocol: 'udp' }] },
      web2: { ...common, webPort: 30010, ports: [{ container: 30010, protocol: 'tcp' }] },
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

    const web1 = parsedContainerDefinitions(findByName(mocks.resources, 'web1-server'));
    expect(web1[0].portMappings).toEqual([
      { containerPort: 30000, hostPort: 30000, protocol: 'tcp' },
      { containerPort: 30001, hostPort: 30001, protocol: 'udp' },
    ]);
    expect(web1[1].command).toContain('localhost:30000');

    // A tcp extra duplicating webPort is mapped once.
    const web2 = parsedContainerDefinitions(findByName(mocks.resources, 'web2-server'));
    expect(web2[0].portMappings).toEqual([{ containerPort: 30010, hostPort: 30010, protocol: 'tcp' }]);
    expect(web2[1].command).toContain('localhost:30010');
  });

  // @spec IAC-PROGRAM-TLS-004
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

  // @spec IAC-PROGRAM-ECS-002
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

  // @spec IAC-PROGRAM-TOKEN-001
  // @spec GAME-TOKEN-005
  it('should substitute the public-address token with the game hostname at build time', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      alpha: {
        ...FIXTURE_GAME_SERVERS.alpha,
        environment: [{ name: 'PUBLIC_HOST', value: '${hyveon.network.public-address}' }],
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

    const containers = parsedContainerDefinitions(findByName(mocks.resources, 'alpha-server'));
    expect(containers[0].environment).toEqual([{ name: 'PUBLIC_HOST', value: 'alpha.example.com' }]);
    expect(containers[0]).not.toHaveProperty('entryPoint');
  });

  // @spec IAC-PROGRAM-TOKEN-003
  // @spec GAME-TOKEN-007
  it('should inject the wrapper entryPoint and command for an ipv4-token game', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      alpha: {
        ...FIXTURE_GAME_SERVERS.alpha,
        environment: [{ name: 'SERVER_IP', value: '${hyveon.network.public-ipv4}' }],
        command: ['/start.sh'],
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

    const containers = parsedContainerDefinitions(findByName(mocks.resources, 'alpha-server'));
    expect(containers[0].command).toEqual(['/start.sh']);
    expect(containers[0].entryPoint).toEqual(['/bin/sh', '-c', expect.stringContaining('checkip.amazonaws.com')]);
    // the raw token stays in the task definition for the wrapper to substitute at boot
    expect(containers[0].environment).toEqual([{ name: 'SERVER_IP', value: '${hyveon.network.public-ipv4}' }]);
  });

  // @spec IAC-PROGRAM-TOKEN-004, IAC-PROGRAM-TOKEN-007
  // @spec GAME-TOKEN-010, GAME-TOKEN-013
  it('should pass command through without tokens and without a wrapper', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      alpha: { ...FIXTURE_GAME_SERVERS.alpha, command: ['/opt/server/start.sh', '--port', '8211'] },
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

    const containers = parsedContainerDefinitions(findByName(mocks.resources, 'alpha-server'));
    expect(containers[0].command).toEqual(['/opt/server/start.sh', '--port', '8211']);
    expect(containers[0]).not.toHaveProperty('entryPoint');
  });

  describe('pinnedHostname', () => {
    const ALPHA_ABSENT_FIELD_CONTAINERS =
      '[{"name":"alpha","image":"example/alpha:latest","essential":true,"portMappings":[{"containerPort":25565,"hostPort":25565,"protocol":"tcp"}],"environment":[],"mountPoints":[{"sourceVolume":"alpha-saves","containerPath":"/data","readOnly":false}],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/alpha-server","awslogs-region":"us-east-1","awslogs-stream-prefix":"ecs"}}}]';
    const DELTA_ABSENT_FIELD_CONTAINERS =
      '[{"name":"delta","image":"example/delta:latest","essential":true,"portMappings":[{"containerPort":8080,"hostPort":8080,"protocol":"tcp"}],"environment":[],"mountPoints":[{"sourceVolume":"delta-saves","containerPath":"/data","readOnly":false}],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/delta-server","awslogs-region":"us-east-1","awslogs-stream-prefix":"ecs"}}},{"name":"caddy","image":"caddy:2-alpine","essential":true,"portMappings":[{"containerPort":443,"hostPort":443,"protocol":"tcp"},{"containerPort":80,"hostPort":80,"protocol":"tcp"}],"command":["caddy","reverse-proxy","--from","delta.example.com","--to","localhost:8080"],"mountPoints":[{"sourceVolume":"delta-caddy-data","containerPath":"/data","readOnly":false}],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-group":"/ecs/delta-server","awslogs-region":"us-east-1","awslogs-stream-prefix":"caddy"}}}]';
    const SHIM_REQUIRE = '--require=/hyveon/hostname-shim/hostname-shim.js';

    /** Builds the ECS resources for `gameServers` against fresh mocks and returns the recorder. */
    async function arrangeDefineEcs(gameServers: Record<string, GameServerConfig>): Promise<RecordedResource[]> {
      const provider = new aws.Provider('aws', { region: 'us-east-1' });
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
      return mocks.resources;
    }

    // @spec IAC-PROGRAM-HOST-001, IAC-PROGRAM-HOST-002, IAC-PROGRAM-HOST-003
    // @spec GAME-HOST-006, GAME-HOST-009
    it('should give an opted-in game the init container, dependsOn, read-only mount, and ephemeral volume', async () => {
      const resources = await arrangeDefineEcs({
        ...FIXTURE_GAME_SERVERS,
        alpha: { ...FIXTURE_GAME_SERVERS.alpha, pinnedHostname: 'foundry' },
      });

      const alphaTd = findByName(resources, 'alpha-server');
      const containers = parsedContainerDefinitions(alphaTd);
      expect(containers.map((container) => container.name)).toEqual(['alpha', 'hostname-shim']);

      const [game, shim] = containers;
      expect(game.dependsOn).toEqual([{ containerName: 'hostname-shim', condition: 'SUCCESS' }]);
      expect(game.mountPoints).toEqual([
        { sourceVolume: 'alpha-saves', containerPath: '/data', readOnly: false },
        { sourceVolume: 'alpha-hostname-shim', containerPath: '/hyveon/hostname-shim', readOnly: true },
      ]);
      expect(game.environment).toEqual([{ name: 'NODE_OPTIONS', value: SHIM_REQUIRE }]);
      expect(shim.essential).toBe(false);
      expect(shim.logConfiguration).toEqual({
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/ecs/alpha-server',
          'awslogs-region': 'us-east-1',
          'awslogs-stream-prefix': 'hostname-shim',
        },
      });

      const shimVolume = (alphaTd.inputs.volumes as Array<Record<string, unknown>>).find(
        (volume) => volume.name === 'alpha-hostname-shim',
      );
      expect(shimVolume).toEqual({ name: 'alpha-hostname-shim' });
    });

    // @spec IAC-PROGRAM-HOST-004
    // @spec GAME-HOST-007
    it('should leave the caddy definition unchanged for an https game', async () => {
      const resources = await arrangeDefineEcs({
        ...FIXTURE_GAME_SERVERS,
        delta: { ...FIXTURE_GAME_SERVERS.delta, pinnedHostname: 'foundry' },
      });

      const containers = parsedContainerDefinitions(findByName(resources, 'delta-server'));
      const baseline = JSON.parse(DELTA_ABSENT_FIELD_CONTAINERS) as Array<Record<string, unknown>>;
      expect(containers.find((container) => container.name === 'caddy')).toEqual(
        baseline.find((container) => container.name === 'caddy'),
      );
    });

    // @spec IAC-PROGRAM-HOST-005
    // @spec GAME-HOST-008
    it('should not affect other games when one opts in', async () => {
      const resources = await arrangeDefineEcs({
        ...FIXTURE_GAME_SERVERS,
        alpha: { ...FIXTURE_GAME_SERVERS.alpha, pinnedHostname: 'foundry' },
      });

      const bravoTd = findByName(resources, 'bravo-server');
      expect(bravoTd.inputs.containerDefinitions).not.toContain('hostname-shim');
      expect(bravoTd.inputs.containerDefinitions).not.toContain('NODE_OPTIONS');
      expect(JSON.stringify(bravoTd.inputs.volumes)).not.toContain('hostname-shim');
    });

    // @spec IAC-PROGRAM-HOST-005
    it('should emit byte-identical container definitions and volumes when the field is absent', async () => {
      const resources = await arrangeDefineEcs(FIXTURE_GAME_SERVERS);

      const alphaTd = findByName(resources, 'alpha-server');
      expect(alphaTd.inputs.containerDefinitions).toBe(ALPHA_ABSENT_FIELD_CONTAINERS);
      expect(alphaTd.inputs.volumes).toHaveLength(1);
      expect(findByName(resources, 'delta-server').inputs.containerDefinitions).toBe(DELTA_ABSENT_FIELD_CONTAINERS);
      expect(findByName(resources, 'delta-server').inputs.volumes).toHaveLength(2);
    });

    // @spec IAC-PROGRAM-HOST-008
    // @spec GAME-HOST-010
    it('should coexist with the ipv4 boot wrapper and keep the token in the merged NODE_OPTIONS', async () => {
      const resources = await arrangeDefineEcs({
        ...FIXTURE_GAME_SERVERS,
        alpha: {
          ...FIXTURE_GAME_SERVERS.alpha,
          pinnedHostname: 'foundry',
          command: ['/start.sh'],
          environment: [{ name: 'NODE_OPTIONS', value: '--title=${hyveon.network.public-ipv4}' }],
        },
      });

      const [game] = parsedContainerDefinitions(findByName(resources, 'alpha-server'));
      expect(game.entryPoint).toEqual(['/bin/sh', '-c', expect.stringContaining('checkip.amazonaws.com')]);
      expect(game.command).toEqual(['/start.sh']);
      expect(game.environment).toEqual([
        { name: 'NODE_OPTIONS', value: `${SHIM_REQUIRE} --title=\${hyveon.network.public-ipv4}` },
      ]);
    });
  });

  // @spec GAME-TOKEN-006
  it('should throw naming the game and token when a public-address token is used but the hosted zone is empty', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const gameServers: Record<string, GameServerConfig> = {
      alpha: {
        ...FIXTURE_GAME_SERVERS.alpha,
        environment: [{ name: 'PUBLIC_HOST', value: '${hyveon.network.public-address}' }],
      },
    };
    const efs = await arrangeEfs(gameServers, provider);

    expect(() =>
      defineEcs({
        projectName: 'hyveon',
        awsRegion: 'us-east-1',
        hostedZoneName: '',
        gameServers,
        efs,
        executionRoleArn: 'arn:aws:iam::123456789012:role/hyveon-task-execution',
        provider,
      }),
    ).toThrow(/alpha.*\$\{hyveon\.network\.public-address\}/);
  });
});
