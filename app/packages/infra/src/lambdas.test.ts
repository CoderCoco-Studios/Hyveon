import path from 'node:path';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineEfs, type EfsResources } from './efs.js';
import { defineIamRoles, type IamRoleResources } from './iam.js';
import { bundlePath, defineLambdas, type DefineLambdasArgs, type LambdaResources } from './lambdas.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/**
 * A literal placeholder path standing in for `DefineLambdasArgs.lambdaBundlesDir`
 * — never a real directory on disk. `pulumi.asset.FileAsset`/`AssetArchive`
 * construction wraps their given path in `Promise.resolve(...)` without ever
 * touching the filesystem (confirmed by reading `@pulumi/pulumi`'s
 * `asset/*.js`), and `installPulumiMocks` intercepts every resource
 * registration before any real engine or upload is involved — so no test in
 * this file needs a real bundle file to exist on disk. See `lambdas.ts`'s
 * file doc, "The lambda-bundle path contract".
 */
const LAMBDA_BUNDLES_DIR = '/fixtures/lambda-bundles';

/** Literal values standing in for the DynamoDB/Secrets Manager/Route 53 resource outputs {@link defineLambdas} requires as parameters. */
const DEFERRED_VALUES = {
  dynamodbDiscordTableName: 'hyveon-discord',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-discord-public-key-abc123',
  hostedZoneId: 'Z1234567890ABC',
};

/** Non-deferred network/ECS mock inputs — plain strings, matching the "mock ID string" style `ecs.test.ts`/`securityGroups.test.ts` already use for inputs that don't need a real backing resource in these tests. */
const MOCK_NETWORK_INPUTS = {
  publicSubnetIds: ['subnet-mock-0', 'subnet-mock-1'],
  gameServersSecurityGroupId: 'sg-game-servers-mock',
  ecsClusterName: 'hyveon-cluster',
  ecsClusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/hyveon-cluster',
};

/**
 * Mock id standing in for `securityGroups.ts`'s `SecurityGroupResources.efsSeeder?.id`
 * — `defineLambdas` does not construct this security group itself (see
 * `lambdas.ts`'s file doc); tests that exercise the EFS-seeder path pass
 * this plain string rather than a real `defineSecurityGroups` call.
 */
const MOCK_EFS_SEEDER_SECURITY_GROUP_ID = 'sg-efs-seeder-mock';

/** Resolves every leaf role/attachment `defineIamRoles` declares before returning — see `iam.test.ts`'s identically-named helper. */
async function arrangeRoles(gameServers: Record<string, GameServerConfig>, provider: aws.Provider): Promise<IamRoleResources> {
  const roles = defineIamRoles({ projectName: 'hyveon', gameServers, provider });
  await Promise.all([
    promiseOf(roles.ecsTaskExecutionPolicyAttachment.id),
    promiseOf(roles.watchdogLambdaRole.id),
    promiseOf(roles.followupLambdaRole.id),
    promiseOf(roles.interactionsLambdaRole.id),
    promiseOf(roles.dnsUpdaterLambdaRole.id),
    ...Object.values(roles.efsSeederRoles).map((role) => promiseOf(role.id)),
  ]);
  return roles;
}

/** Resolves every leaf resource `defineEfs` declares before returning — see `ecs.test.ts`'s identically-named helper. */
async function arrangeEfs(gameServers: Record<string, GameServerConfig>, provider: aws.Provider): Promise<EfsResources> {
  const efs = defineEfs({
    projectName: 'hyveon',
    gameServers,
    publicSubnets: MOCK_NETWORK_INPUTS.publicSubnetIds,
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

/** Declares the role set and EFS resources `defineLambdas` needs, awaiting both before returning — the standard "arrange" step shared by every test below. */
async function arrangeDependencies(
  gameServers: Record<string, GameServerConfig>,
): Promise<{ provider: aws.Provider; roles: IamRoleResources; efs: EfsResources }> {
  const provider = new aws.Provider('aws', { region: 'us-east-1' });
  const roles = await arrangeRoles(gameServers, provider);
  const efs = await arrangeEfs(gameServers, provider);
  return { provider, roles, efs };
}

/**
 * Full `defineLambdas` args, with per-test overrides for `gameServers`/`roles`/`efs`/`provider`
 * (required) plus anything else (optional — e.g. `watchdogIntervalMinutes`,
 * `efsSeederSecurityGroupId`). `efsSeederSecurityGroupId` defaults to
 * `undefined`, correct for every fixture without `file_seeds`; tests that
 * exercise the EFS-seeder path override it to {@link MOCK_EFS_SEEDER_SECURITY_GROUP_ID}.
 */
function buildArgs(
  overrides: Pick<DefineLambdasArgs, 'gameServers' | 'roles' | 'efs' | 'provider'> & Partial<DefineLambdasArgs>,
): DefineLambdasArgs {
  return {
    projectName: 'hyveon',
    awsRegion: 'us-east-1',
    hostedZoneName: 'example.com',
    dnsTtl: 30,
    watchdogIntervalMinutes: 15,
    watchdogIdleChecks: 4,
    watchdogMinPackets: 100,
    lambdaBundlesDir: LAMBDA_BUNDLES_DIR,
    efsSeederSecurityGroupId: undefined,
    ...MOCK_NETWORK_INPUTS,
    ...DEFERRED_VALUES,
    ...overrides,
  };
}

/** Resolves every leaf resource `defineLambdas` declares, guaranteeing the mock recorder has captured the full set before assertions run (see `pulumiMocks.ts`'s `promiseOf` doc). */
async function runDefineLambdas(args: DefineLambdasArgs): Promise<LambdaResources> {
  const result = defineLambdas(args);
  await Promise.all([
    promiseOf(result.interactionsFunction.id),
    promiseOf(result.interactionsLogGroup.id),
    promiseOf(result.interactionsFunctionUrl.id),
    promiseOf(result.interactionsUrlInvokeUrlPermission.id),
    promiseOf(result.interactionsUrlInvokePermission.id),
    promiseOf(result.followupFunction.id),
    promiseOf(result.followupLogGroup.id),
    promiseOf(result.watchdogFunction.id),
    promiseOf(result.watchdogLogGroup.id),
    promiseOf(result.watchdogScheduleRule.id),
    promiseOf(result.watchdogScheduleTarget.id),
    promiseOf(result.watchdogEventBridgePermission.id),
    promiseOf(result.dnsUpdaterFunction.id),
    promiseOf(result.dnsUpdaterLogGroup.id),
    promiseOf(result.ecsTaskChangeRule.id),
    promiseOf(result.dnsUpdaterEventTarget.id),
    promiseOf(result.dnsUpdaterEventBridgePermission.id),
    ...Object.values(result.efsSeederLogGroups).map((lg) => promiseOf(lg.id)),
    ...Object.values(result.efsSeederFunctions).map((fn) => promiseOf(fn.id)),
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

/**
 * Finds the single recorded resource with the given Pulumi logical name AND
 * type, failing loudly if there isn't exactly one. Needed wherever an
 * EFS-seeder Lambda function's logical name collides with its own IAM
 * role's logical name — both are `${projectName}-efs-seeder-${game}`,
 * matching the HCL exactly (`aws_iam_role.efs_seeder`'s and
 * `aws_lambda_function.efs_seeder`'s `name` are the identical string; no
 * problem on the AWS side, since IAM role names and Lambda function names
 * live in different namespaces, but ambiguous for a name-only lookup here).
 */
function findByNameAndType(resources: RecordedResource[], name: string, type: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name && resource.type === type);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "${type}" resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

/** A game-server map exercising `connect_message`/ports-derived env vars: `withMessage` has both a message and a port; `noMessage` has a port but no message. */
const CONNECT_MESSAGE_FIXTURE: Record<string, GameServerConfig> = {
  withMessage: {
    image: 'example/with-message:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    connect_message: 'Connect at {host}:{port}',
  },
  noMessage: {
    image: 'example/no-message:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 7777, protocol: 'udp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
  },
};

describe('bundlePath', () => {
  it('should join the bundles dir, the lambda directory name, dist, and handler.cjs', () => {
    expect(bundlePath('/some/dir', 'interactions')).toBe(path.join('/some/dir', 'interactions', 'dist', 'handler.cjs'));
  });

  it('should use the lambda directory name verbatim, distinct from any other naming convention', () => {
    expect(bundlePath(LAMBDA_BUNDLES_DIR, 'update-dns')).toBe(path.join(LAMBDA_BUNDLES_DIR, 'update-dns', 'dist', 'handler.cjs'));
  });
});

describe('defineLambdas', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  describe('followup function', () => {
    it('should set name/role/handler/runtime/timeout/memorySize exactly per the HCL', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      const result = await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-followup');
      expect(fn.type).toBe('aws:lambda/function:Function');
      expect(fn.inputs.name).toBe('hyveon-followup');
      expect(fn.inputs.role).toBe(await promiseOf(roles.followupLambdaRole.arn));
      expect(fn.inputs.handler).toBe('handler.handler');
      expect(fn.inputs.runtime).toBe('nodejs24.x');
      expect(fn.inputs.timeout).toBe(60);
      expect(fn.inputs.memorySize).toBe(256);
      expect(fn.inputs.tags).toEqual({ Name: 'hyveon-followup' });
      expect(await promiseOf(result.followupFunction.name)).toBe('hyveon-followup');
    });

    it('should set every environment variable exactly per the HCL, including the AWS_REGION_ trailing underscore', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-followup');
      const variables = (fn.inputs.environment as { variables: Record<string, unknown> }).variables;
      expect(variables).toEqual({
        AWS_REGION_: 'us-east-1',
        TABLE_NAME: DEFERRED_VALUES.dynamodbDiscordTableName,
        ECS_CLUSTER: MOCK_NETWORK_INPUTS.ecsClusterName,
        SUBNET_IDS: MOCK_NETWORK_INPUTS.publicSubnetIds.join(','),
        SECURITY_GROUP_ID: MOCK_NETWORK_INPUTS.gameServersSecurityGroupId,
        DOMAIN_NAME: 'example.com',
        GAME_NAMES: 'alpha,bravo,charlie,delta',
        CONNECT_MESSAGES: '{}',
        GAME_PORTS: JSON.stringify({ alpha: 25565, bravo: 25565, charlie: 7777, delta: 8080 }),
      });
      expect('AWS_REGION' in variables).toBe(false);
    });

    it('should declare its log group at /aws/lambda/{project}-followup with 7-day retention', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const logGroup = findByName(mocks.resources, 'hyveon-followup-logs');
      expect(logGroup.type).toBe('aws:cloudwatch/logGroup:LogGroup');
      expect(logGroup.inputs.name).toBe('/aws/lambda/hyveon-followup');
      expect(logGroup.inputs.retentionInDays).toBe(7);
      expect(logGroup.inputs.tags).toEqual({ Name: 'hyveon-followup-logs' });
    });

    it('should source its code from the followup bundle directory, zipped as a single handler.cjs entry', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-followup');
      const code = fn.inputs.code as pulumi.asset.AssetArchive;
      expect(code).toBeInstanceOf(pulumi.asset.AssetArchive);
      const assets = await code.assets;
      expect(Object.keys(assets)).toEqual(['handler.cjs']);
      const handlerAsset = assets['handler.cjs'] as pulumi.asset.FileAsset;
      expect(await handlerAsset.path).toBe(bundlePath(LAMBDA_BUNDLES_DIR, 'followup'));
    });
  });

  describe('interactions function, function URL, and permissions', () => {
    it('should set name/role/handler/runtime/timeout/memorySize exactly per the HCL', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      const result = await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-interactions');
      expect(fn.type).toBe('aws:lambda/function:Function');
      expect(fn.inputs.name).toBe('hyveon-interactions');
      expect(fn.inputs.role).toBe(await promiseOf(roles.interactionsLambdaRole.arn));
      expect(fn.inputs.handler).toBe('handler.handler');
      expect(fn.inputs.runtime).toBe('nodejs24.x');
      expect(fn.inputs.timeout).toBe(10);
      expect(fn.inputs.memorySize).toBe(256);
      expect(await promiseOf(result.interactionsFunction.name)).toBe('hyveon-interactions');
    });

    it('should set FOLLOWUP_LAMBDA_NAME to the live followup function name and every other environment variable per the HCL', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-interactions');
      const variables = (fn.inputs.environment as { variables: Record<string, unknown> }).variables;
      expect(variables).toEqual({
        AWS_REGION_: 'us-east-1',
        TABLE_NAME: DEFERRED_VALUES.dynamodbDiscordTableName,
        DISCORD_PUBLIC_KEY_SECRET_ARN: DEFERRED_VALUES.discordPublicKeySecretArn,
        FOLLOWUP_LAMBDA_NAME: 'hyveon-followup',
        GAME_NAMES: 'alpha,bravo,charlie,delta',
        HOSTED_ZONE_NAME: 'example.com',
      });
    });

    it('should declare a NONE-auth function URL scoped to Discord CORS', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const url = findByName(mocks.resources, 'hyveon-interactions-url');
      expect(url.type).toBe('aws:lambda/functionUrl:FunctionUrl');
      expect(url.inputs.authorizationType).toBe('NONE');
      expect(url.inputs.cors).toEqual({
        allowOrigins: ['https://discord.com'],
        allowMethods: ['POST'],
        allowHeaders: ['content-type', 'x-signature-ed25519', 'x-signature-timestamp'],
      });
    });

    it('should declare both the InvokeFunctionUrl and InvokeFunction public permissions with their exact statement ids', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const urlPermission = findByName(mocks.resources, 'hyveon-interactions-url-invoke-url');
      expect(urlPermission.type).toBe('aws:lambda/permission:Permission');
      expect(urlPermission.inputs).toMatchObject({
        statementId: 'FunctionURLInvokeUrlAllowPublicAccess',
        action: 'lambda:InvokeFunctionUrl',
        principal: '*',
        functionUrlAuthType: 'NONE',
      });

      const invokePermission = findByName(mocks.resources, 'hyveon-interactions-url-invoke');
      expect(invokePermission.type).toBe('aws:lambda/permission:Permission');
      expect(invokePermission.inputs).toMatchObject({
        statementId: 'FunctionURLInvokeAllowPublicAccess',
        action: 'lambda:InvokeFunction',
        principal: '*',
      });
      expect(invokePermission.inputs.functionUrlAuthType).toBeUndefined();
    });
  });

  describe('watchdog function and EventBridge schedule', () => {
    it('should set name/role/handler/runtime/timeout exactly per the HCL, with no memorySize', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-watchdog');
      expect(fn.inputs.role).toBe(await promiseOf(roles.watchdogLambdaRole.arn));
      expect(fn.inputs.timeout).toBe(60);
      expect(fn.inputs.memorySize).toBeUndefined();
    });

    it('should set every environment variable exactly per the HCL', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-watchdog');
      const variables = (fn.inputs.environment as { variables: Record<string, unknown> }).variables;
      expect(variables).toEqual({
        ECS_CLUSTER: MOCK_NETWORK_INPUTS.ecsClusterName,
        GAME_NAMES: 'alpha,bravo,charlie,delta',
        IDLE_CHECKS: '4',
        MIN_PACKETS: '100',
        CHECK_WINDOW_MINUTES: '15',
        AWS_REGION_: 'us-east-1',
      });
    });

    it('should use the plural "minutes" schedule expression for an interval greater than 1', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider, watchdogIntervalMinutes: 15 }));

      const rule = findByName(mocks.resources, 'hyveon-watchdog-schedule');
      expect(rule.type).toBe('aws:cloudwatch/eventRule:EventRule');
      expect(rule.inputs.scheduleExpression).toBe('rate(15 minutes)');
      expect(rule.inputs.description).toBe('Check for idle game servers every 15 minute(s)');
    });

    it('should use the singular "minute" schedule expression for a 1-minute interval', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider, watchdogIntervalMinutes: 1 }));

      const rule = findByName(mocks.resources, 'hyveon-watchdog-schedule');
      expect(rule.inputs.scheduleExpression).toBe('rate(1 minute)');
    });

    it('should target the watchdog function from the schedule rule with the exact target id', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      const result = await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const target = findByName(mocks.resources, 'hyveon-watchdog-target');
      expect(target.type).toBe('aws:cloudwatch/eventTarget:EventTarget');
      expect(target.inputs.targetId).toBe('GameServerWatchdog');
      expect(target.inputs.rule).toBe(await promiseOf(result.watchdogScheduleRule.name));
      expect(target.inputs.arn).toBe(await promiseOf(result.watchdogFunction.arn));
    });

    it('should grant events.amazonaws.com permission scoped to the schedule rule ARN', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      const result = await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const permission = findByName(mocks.resources, 'hyveon-watchdog-eventbridge');
      expect(permission.inputs).toMatchObject({ statementId: 'AllowWatchdogEventBridge', action: 'lambda:InvokeFunction', principal: 'events.amazonaws.com' });
      expect(permission.inputs.sourceArn).toBe(await promiseOf(result.watchdogScheduleRule.arn));
    });
  });

  describe('dns-updater function and EventBridge ECS-state-change rule', () => {
    it('should set name/role/handler/runtime/timeout exactly per the HCL, with no memorySize', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-dns-updater');
      expect(fn.inputs.role).toBe(await promiseOf(roles.dnsUpdaterLambdaRole.arn));
      expect(fn.inputs.timeout).toBe(60);
      expect(fn.inputs.memorySize).toBeUndefined();
    });

    it('should source its code from the update-dns bundle directory, not dns-updater', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-dns-updater');
      const code = fn.inputs.code as pulumi.asset.AssetArchive;
      const assets = await code.assets;
      const handlerAsset = assets['handler.cjs'] as pulumi.asset.FileAsset;
      expect(await handlerAsset.path).toBe(bundlePath(LAMBDA_BUNDLES_DIR, 'update-dns'));
    });

    it('should set every environment variable exactly per the HCL, including the deferred HOSTED_ZONE_ID', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-dns-updater');
      const variables = (fn.inputs.environment as { variables: Record<string, unknown> }).variables;
      expect(variables).toEqual({
        HOSTED_ZONE_ID: DEFERRED_VALUES.hostedZoneId,
        DOMAIN_NAME: 'example.com',
        GAME_NAMES: 'alpha,bravo,charlie,delta',
        DNS_TTL: '30',
        AWS_REGION_: 'us-east-1',
        TABLE_NAME: DEFERRED_VALUES.dynamodbDiscordTableName,
        CONNECT_MESSAGES: '{}',
        GAME_PORTS: JSON.stringify({ alpha: 25565, bravo: 25565, charlie: 7777, delta: 8080 }),
      });
    });

    it('should declare an event pattern matching RUNNING/STOPPED ECS Task State Change events on the live cluster ARN', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const rule = findByName(mocks.resources, 'hyveon-task-state-change');
      expect(rule.type).toBe('aws:cloudwatch/eventRule:EventRule');
      expect(rule.inputs.description).toBe('Triggers DNS update when any game server task starts or stops');
      expect(JSON.parse(rule.inputs.eventPattern as string)).toEqual({
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: { clusterArn: [MOCK_NETWORK_INPUTS.ecsClusterArn], lastStatus: ['RUNNING', 'STOPPED'] },
      });
    });

    it('should target the dns-updater function from the rule with the exact target id, and grant events.amazonaws.com permission scoped to the rule ARN', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      const result = await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      const target = findByName(mocks.resources, 'hyveon-dns-updater-target');
      expect(target.inputs.targetId).toBe('GameServerDnsUpdater');
      expect(target.inputs.arn).toBe(await promiseOf(result.dnsUpdaterFunction.arn));

      const permission = findByName(mocks.resources, 'hyveon-dns-updater-eventbridge');
      expect(permission.inputs).toMatchObject({ statementId: 'AllowDnsUpdaterEventBridge', action: 'lambda:InvokeFunction', principal: 'events.amazonaws.com' });
      expect(permission.inputs.sourceArn).toBe(await promiseOf(result.ecsTaskChangeRule.arn));
    });
  });

  describe('CONNECT_MESSAGES / GAME_PORTS derivation', () => {
    it('should omit a game with no connect_message from CONNECT_MESSAGES but include its first port in GAME_PORTS', async () => {
      const { provider, roles, efs } = await arrangeDependencies(CONNECT_MESSAGE_FIXTURE);
      await runDefineLambdas(buildArgs({ gameServers: CONNECT_MESSAGE_FIXTURE, roles, efs, provider }));

      const fn = findByName(mocks.resources, 'hyveon-followup');
      const variables = (fn.inputs.environment as { variables: Record<string, unknown> }).variables;
      expect(JSON.parse(variables.CONNECT_MESSAGES as string)).toEqual({ withMessage: 'Connect at {host}:{port}' });
      expect(JSON.parse(variables.GAME_PORTS as string)).toEqual({ withMessage: 25565, noMessage: 7777 });
    });
  });

  describe('efs-seeder per-game log groups and functions', () => {
    it('should declare no log groups or functions when no game declares file_seeds', async () => {
      const { provider, roles, efs } = await arrangeDependencies(FIXTURE_GAME_SERVERS);
      const result = await runDefineLambdas(buildArgs({ gameServers: FIXTURE_GAME_SERVERS, roles, efs, provider }));

      expect(result.efsSeederLogGroups).toEqual({});
      expect(result.efsSeederFunctions).toEqual({});
    });

    it('should throw when a game declares file_seeds but no efsSeederSecurityGroupId was supplied', async () => {
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
      const { provider, roles, efs } = await arrangeDependencies(gameServers);

      expect(() => defineLambdas(buildArgs({ gameServers, roles, efs, provider, efsSeederSecurityGroupId: undefined }))).toThrow(
        /efsSeederSecurityGroupId is undefined/,
      );
    });

    it('should declare one log group/function per game with file_seeds, wired to the externally-supplied security group id', async () => {
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
      const { provider, roles, efs } = await arrangeDependencies(gameServers);
      const result = await runDefineLambdas(
        buildArgs({ gameServers, roles, efs, provider, efsSeederSecurityGroupId: MOCK_EFS_SEEDER_SECURITY_GROUP_ID }),
      );

      expect(Object.keys(result.efsSeederLogGroups)).toEqual(['echo']);
      const logGroup = findByName(mocks.resources, 'hyveon-efs-seeder-echo-logs');
      expect(logGroup.inputs.name).toBe('/aws/lambda/hyveon-efs-seeder-echo');
      expect(logGroup.inputs.retentionInDays).toBe(7);

      expect(Object.keys(result.efsSeederFunctions)).toEqual(['echo']);
      const fn = findByNameAndType(mocks.resources, 'hyveon-efs-seeder-echo', 'aws:lambda/function:Function');
      expect(fn.inputs.role).toBe(await promiseOf(roles.efsSeederRoles.echo.arn));
      expect(fn.inputs.handler).toBe('handler.handler');
      expect(fn.inputs.runtime).toBe('nodejs24.x');
      expect(fn.inputs.timeout).toBe(60);
      expect((fn.inputs.environment as { variables: Record<string, unknown> }).variables).toEqual({ AWS_REGION_: 'us-east-1' });

      expect(fn.inputs.vpcConfig).toEqual({
        subnetIds: MOCK_NETWORK_INPUTS.publicSubnetIds,
        securityGroupIds: [MOCK_EFS_SEEDER_SECURITY_GROUP_ID],
      });

      const accessPointArn = await promiseOf(efs.gameAccessPoints['echo-saves'].arn);
      expect(fn.inputs.fileSystemConfig).toEqual({ arn: accessPointArn, localMountPath: '/mnt/efs' });

      const code = fn.inputs.code as pulumi.asset.AssetArchive;
      const assets = await code.assets;
      const handlerAsset = assets['handler.cjs'] as pulumi.asset.FileAsset;
      expect(await handlerAsset.path).toBe(bundlePath(LAMBDA_BUNDLES_DIR, 'efs-seeder'));
    });

    it('should declare one seeder function per role in roles.efsSeederRoles, never drifting from that set', async () => {
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
        foxtrot: {
          image: 'example/foxtrot:latest',
          cpu: 1024,
          memory: 2048,
          ports: [{ container: 4321, protocol: 'tcp' }],
          volumes: [{ name: 'saves', container_path: '/data' }],
          file_seeds: [{ path: '/data/other.yml', content: 'baz: qux' }],
        },
      };
      const { provider, roles, efs } = await arrangeDependencies(gameServers);
      const result = await runDefineLambdas(
        buildArgs({ gameServers, roles, efs, provider, efsSeederSecurityGroupId: MOCK_EFS_SEEDER_SECURITY_GROUP_ID }),
      );

      expect(Object.keys(result.efsSeederFunctions).sort()).toEqual(Object.keys(roles.efsSeederRoles).sort());
      expect(Object.keys(result.efsSeederFunctions).sort()).toEqual(['echo', 'foxtrot']);
    });
  });
});
