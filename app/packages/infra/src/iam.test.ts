import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  defineIamPolicies,
  defineIamRoles,
  gamesWithFileSeeds,
  gamesWithHealthChecks,
  type DefineIamPoliciesArgs,
  type IamRoleResources,
} from './iam.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/**
 * Literal stand-ins for the resource ARNs {@link defineIamPolicies} expects
 * as its deferred-ARN parameters. `dynamodbDiscordTableArn` is deliberately
 * wrapped in `pulumi.output(...)` rather than passed as a bare string when
 * building `DEFERRED_ARGS` below, so at least one deferred parameter is
 * exercised as a real `Output<string>` (matching what `aws.dynamodb.Table.arn`
 * actually is), not just as a plain string that happens to satisfy
 * `pulumi.Input<string>`.
 */
const DEFERRED_ARN_VALUES = {
  efsFileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-mock',
  dynamodbDiscordTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/hyveon-discord',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-discord-public-key-abc123',
  followupLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:hyveon-followup',
  hostedZoneId: 'Z1234567890ABC',
  ecsClusterName: 'hyveon-cluster',
};

/**
 * The deferred-ARN parameters passed to every `defineIamPolicies` call under
 * test — see {@link DEFERRED_ARN_VALUES}'s doc. `gameServers` defaults to
 * {@link FIXTURE_GAME_SERVERS} (no game declares `healthCheck`) and
 * `healthCheckFunctionArn` to `undefined`, matching that default — tests
 * exercising the health-check policy override both.
 */
const DEFERRED_ARGS: Pick<
  DefineIamPoliciesArgs,
  | 'efsFileSystemArn'
  | 'dynamodbDiscordTableArn'
  | 'discordPublicKeySecretArn'
  | 'followupLambdaArn'
  | 'hostedZoneId'
  | 'ecsClusterName'
  | 'gameServers'
  | 'healthCheckFunctionArn'
> = {
  efsFileSystemArn: DEFERRED_ARN_VALUES.efsFileSystemArn,
  dynamodbDiscordTableArn: pulumi.output(DEFERRED_ARN_VALUES.dynamodbDiscordTableArn),
  discordPublicKeySecretArn: DEFERRED_ARN_VALUES.discordPublicKeySecretArn,
  followupLambdaArn: DEFERRED_ARN_VALUES.followupLambdaArn,
  hostedZoneId: DEFERRED_ARN_VALUES.hostedZoneId,
  ecsClusterName: DEFERRED_ARN_VALUES.ecsClusterName,
  gameServers: FIXTURE_GAME_SERVERS,
  healthCheckFunctionArn: undefined,
};

/** Resolves every leaf role/attachment `defineIamRoles` declares, guaranteeing the mock recorder has captured the full role set before assertions run (see `pulumiMocks.ts`'s `promiseOf` doc). */
async function runDefineIamRoles(args: Parameters<typeof defineIamRoles>[0]): Promise<IamRoleResources> {
  const roles = defineIamRoles(args);
  await Promise.all([
    promiseOf(roles.ecsTaskExecutionPolicyAttachment.id),
    promiseOf(roles.watchdogLambdaRole.id),
    promiseOf(roles.followupLambdaRole.id),
    promiseOf(roles.interactionsLambdaRole.id),
    promiseOf(roles.dnsUpdaterLambdaRole.id),
    promiseOf(roles.fileBrowserSchedulerRole.id),
    ...Object.values(roles.efsSeederRoles).map((role) => promiseOf(role.id)),
    ...(roles.healthCheckLambdaRole ? [promiseOf(roles.healthCheckLambdaRole.id)] : []),
  ]);
  return roles;
}

/** Resolves every leaf policy `defineIamPolicies` declares, guaranteeing the mock recorder has captured the full policy set before assertions run. */
async function runDefineIamPolicies(args: Parameters<typeof defineIamPolicies>[0]): Promise<ReturnType<typeof defineIamPolicies>> {
  const policies = defineIamPolicies(args);
  await Promise.all([
    promiseOf(policies.watchdogLambdaPolicy.id),
    promiseOf(policies.followupLambdaPolicy.id),
    promiseOf(policies.interactionsLambdaPolicy.id),
    promiseOf(policies.dnsUpdaterLambdaPolicy.id),
    promiseOf(policies.fileBrowserSchedulerPolicy.id),
    ...Object.values(policies.efsSeederPolicies).map((policy) => promiseOf(policy.id)),
    ...(policies.healthCheckLambdaPolicy ? [promiseOf(policies.healthCheckLambdaPolicy.id)] : []),
  ]);
  return policies;
}

/** Declares the full role set for a `defineIamPolicies` test, awaiting it before returning — the standard "arrange" step shared by every policy test below. */
async function arrangeRoles(gameServers: Record<string, GameServerConfig>): Promise<{ provider: aws.Provider; roles: IamRoleResources }> {
  const provider = new aws.Provider('aws', { region: 'us-east-1' });
  const roles = await runDefineIamRoles({ projectName: 'hyveon', gameServers, provider });
  return { provider, roles };
}

/** Finds the single recorded resource with the given Pulumi logical name, failing loudly if there isn't exactly one. */
function findByName(resources: RecordedResource[], name: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

/** Parses a recorded `aws.iam.RolePolicy`/trust-policy JSON input, whitespace-robust (never string-compared). */
function parsedPolicy(resource: RecordedResource, field: 'policy' | 'assumeRolePolicy'): unknown {
  return JSON.parse(resource.inputs[field] as string);
}

describe('gamesWithFileSeeds', () => {
  it('should return an empty map when no game declares file_seeds', () => {
    expect(gamesWithFileSeeds(FIXTURE_GAME_SERVERS)).toEqual({});
  });

  it('should include only games with at least one file_seeds entry', () => {
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
        file_seeds: [],
      },
    };
    expect(Object.keys(gamesWithFileSeeds(gameServers))).toEqual(['echo']);
  });
});

/** A `gameServers` map extending {@link FIXTURE_GAME_SERVERS} with one game (`echo`) declaring an authenticated `healthCheck` — exercises the health-check role/policy/secretsmanager-scoping shape. */
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
      auth: { secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-echo-token-AbCdEf' },
      activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 },
    },
  },
};

describe('gamesWithHealthChecks', () => {
  it('should return an empty map when no game declares healthCheck', () => {
    expect(gamesWithHealthChecks(FIXTURE_GAME_SERVERS)).toEqual({});
  });

  it('should include only games declaring healthCheck', () => {
    expect(Object.keys(gamesWithHealthChecks(GAME_SERVERS_WITH_HEALTH_CHECK))).toEqual(['echo']);
  });
});

describe('defineIamRoles', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the ECS task-execution role with the ecs-tasks.amazonaws.com trust policy', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIamRoles({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider });

    const role = findByName(mocks.resources, 'hyveon-task-execution');
    expect(role.type).toBe('aws:iam/role:Role');
    expect(role.inputs.name).toBe('hyveon-task-execution');
    expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' } }],
    });
  });

  it('should attach the AmazonECSTaskExecutionRolePolicy managed policy to the task-execution role by name', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIamRoles({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider });

    const attachment = findByName(mocks.resources, 'hyveon-task-execution-attachment');
    expect(attachment.type).toBe('aws:iam/rolePolicyAttachment:RolePolicyAttachment');
    expect(attachment.inputs.policyArn).toBe('arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy');
    expect(attachment.inputs.role).toBe('hyveon-task-execution');
  });

  it('should declare every Lambda role with the lambda.amazonaws.com trust policy and no external ARN dependency', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIamRoles({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider });

    for (const name of ['hyveon-watchdog-lambda', 'hyveon-followup-lambda', 'hyveon-interactions-lambda', 'hyveon-dns-updater-lambda']) {
      const role = findByName(mocks.resources, name);
      expect(role.type).toBe('aws:iam/role:Role');
      expect(role.inputs.name).toBe(name);
      expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
        Version: '2012-10-17',
        Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
      });
    }
  });

  it('should declare no EFS-seeder roles when no game declares file_seeds', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const roles = await runDefineIamRoles({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider });

    expect(roles.efsSeederRoles).toEqual({});
  });

  it('should declare one EFS-seeder role per game with file_seeds', async () => {
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
    const roles = await runDefineIamRoles({ projectName: 'hyveon', gameServers, provider });

    expect(Object.keys(roles.efsSeederRoles)).toEqual(['echo']);
    const role = findByName(mocks.resources, 'hyveon-efs-seeder-echo');
    expect(role.inputs.name).toBe('hyveon-efs-seeder-echo');
    expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    });
  });

  it('should declare the FileBrowser scheduler role with the scheduler.amazonaws.com trust policy', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIamRoles({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider });

    const role = findByName(mocks.resources, 'hyveon-filebrowser-scheduler');
    expect(role.type).toBe('aws:iam/role:Role');
    expect(role.inputs.name).toBe('hyveon-filebrowser-scheduler');
    expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' } }],
    });
  });

  it('should declare no health-check role when no game declares healthCheck', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const roles = await runDefineIamRoles({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider });

    expect(roles.healthCheckLambdaRole).toBeUndefined();
  });

  it('should declare a single shared health-check role when at least one game declares healthCheck', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const roles = await runDefineIamRoles({ projectName: 'hyveon', gameServers: GAME_SERVERS_WITH_HEALTH_CHECK, provider });

    expect(roles.healthCheckLambdaRole).toBeDefined();
    const role = findByName(mocks.resources, 'hyveon-health-check-lambda');
    expect(role.type).toBe('aws:iam/role:Role');
    expect(role.inputs.name).toBe('hyveon-health-check-lambda');
    expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    });
  });
});

describe('defineIamPolicies', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the watchdog Lambda policy with no external ARN dependency', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-watchdog-lambda-policy');
    expect(policy.type).toBe('aws:iam/rolePolicy:RolePolicy');
    expect(policy.inputs.role).toBe(await promiseOf(roles.watchdogLambdaRole.id));
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        {
          Effect: 'Allow',
          Action: ['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:StopTask', 'ecs:TagResource', 'ecs:ListTagsForResource'],
          Resource: '*',
        },
        { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
        { Effect: 'Allow', Action: ['cloudwatch:GetMetricStatistics'], Resource: '*' },
      ],
    });
  });

  it('should grant the followup Lambda policy iam:PassRole on the live task-execution role and dynamodb access on the deferred discord table ARN', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-followup-lambda-policy');
    const ecsTaskExecutionArn = await promiseOf(roles.ecsTaskExecutionRole.arn);
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        { Effect: 'Allow', Action: ['ecs:RunTask', 'ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'], Resource: '*' },
        {
          Effect: 'Allow',
          Action: ['ecs:TagResource'],
          Resource: '*',
          Condition: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
        },
        { Effect: 'Allow', Action: ['iam:PassRole'], Resource: ecsTaskExecutionArn },
        { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: DEFERRED_ARN_VALUES.dynamodbDiscordTableArn },
      ],
    });
  });

  it('should grant the interactions Lambda policy dynamodb, secretsmanager, and lambda:InvokeFunction on their respective deferred ARNs', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-interactions-lambda-policy');
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: DEFERRED_ARN_VALUES.dynamodbDiscordTableArn },
        { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: DEFERRED_ARN_VALUES.discordPublicKeySecretArn },
        { Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: DEFERRED_ARN_VALUES.followupLambdaArn },
      ],
    });
  });

  it('should grant the dns-updater Lambda policy route53 access scoped to the deferred hosted-zone id plus the wildcard change resource, and dynamodb access on the discord table', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-dns-updater-lambda-policy');
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        { Effect: 'Allow', Action: ['ecs:DescribeTasks'], Resource: '*' },
        { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
        {
          Effect: 'Allow',
          Action: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets', 'route53:GetChange'],
          Resource: [`arn:aws:route53:::hostedzone/${DEFERRED_ARN_VALUES.hostedZoneId}`, 'arn:aws:route53:::change/*'],
        },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:DeleteItem'], Resource: DEFERRED_ARN_VALUES.dynamodbDiscordTableArn },
      ],
    });
  });

  it('should declare no EFS-seeder policies when no game declares file_seeds', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    const policies = await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    expect(policies.efsSeederPolicies).toEqual({});
  });

  it('should declare one EFS-seeder policy per role in roles.efsSeederRoles, granting elasticfilesystem access on the deferred EFS filesystem ARN', async () => {
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
    const { provider, roles } = await arrangeRoles(gameServers);
    const policies = await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    expect(Object.keys(policies.efsSeederPolicies)).toEqual(['echo']);
    const policy = findByName(mocks.resources, 'hyveon-efs-seeder-echo-policy');
    expect(policy.inputs.role).toBe(await promiseOf(roles.efsSeederRoles.echo.id));
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        {
          Effect: 'Allow',
          Action: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface'],
          Resource: '*',
        },
        {
          Effect: 'Allow',
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Resource: DEFERRED_ARN_VALUES.efsFileSystemArn,
        },
      ],
    });
  });

  it('should grant the FileBrowser scheduler policy only ecs:StopTask, scoped to tasks in the deferred ECS cluster', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-filebrowser-scheduler-policy');
    expect(policy.type).toBe('aws:iam/rolePolicy:RolePolicy');
    expect(policy.inputs.role).toBe(await promiseOf(roles.fileBrowserSchedulerRole.id));
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ecs:StopTask'],
          Resource: `arn:aws:ecs:*:*:task/${DEFERRED_ARN_VALUES.ecsClusterName}/*`,
        },
      ],
    });
  });

  it('should declare no health-check policy when no game declares healthCheck', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    const policies = await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    expect(policies.healthCheckLambdaPolicy).toBeUndefined();
  });

  it('should grant the health-check policy ec2/ecs access plus secretsmanager scoped to exactly the referenced secret ARNs', async () => {
    const { provider, roles } = await arrangeRoles(GAME_SERVERS_WITH_HEALTH_CHECK);
    const policies = await runDefineIamPolicies({
      projectName: 'hyveon',
      provider,
      roles,
      ...DEFERRED_ARGS,
      gameServers: GAME_SERVERS_WITH_HEALTH_CHECK,
    });

    expect(policies.healthCheckLambdaPolicy).toBeDefined();
    const policy = findByName(mocks.resources, 'hyveon-health-check-lambda-policy');
    expect(policy.inputs.role).toBe(await promiseOf(roles.healthCheckLambdaRole!.id));
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        {
          Effect: 'Allow',
          Action: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface'],
          Resource: '*',
        },
        {
          Effect: 'Allow',
          Action: ['ecs:DescribeTasks'],
          Resource: `arn:aws:ecs:*:*:task/${DEFERRED_ARN_VALUES.ecsClusterName}/*`,
        },
        {
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [GAME_SERVERS_WITH_HEALTH_CHECK.echo.healthCheck!.auth!.secretArn],
        },
      ],
    });
  });

  it('should omit the secretsmanager statement from the health-check policy when no opted-in game references a credential', async () => {
    const gameServers: Record<string, GameServerConfig> = {
      ...FIXTURE_GAME_SERVERS,
      echo: {
        ...GAME_SERVERS_WITH_HEALTH_CHECK.echo,
        healthCheck: { ...GAME_SERVERS_WITH_HEALTH_CHECK.echo.healthCheck!, auth: undefined },
      },
    };
    const { provider, roles } = await arrangeRoles(gameServers);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS, gameServers });

    const policy = findByName(mocks.resources, 'hyveon-health-check-lambda-policy');
    const statements = (parsedPolicy(policy, 'policy') as { Statement: { Action: string[] }[] }).Statement;
    expect(statements.some((s) => s.Action.includes('secretsmanager:GetSecretValue'))).toBe(false);
  });

  it('should grant the watchdog policy lambda:InvokeFunction on the health-check function ARN when provided', async () => {
    const { provider, roles } = await arrangeRoles(GAME_SERVERS_WITH_HEALTH_CHECK);
    const healthCheckFunctionArn = 'arn:aws:lambda:us-east-1:123456789012:function:hyveon-health-check';
    await runDefineIamPolicies({
      projectName: 'hyveon',
      provider,
      roles,
      ...DEFERRED_ARGS,
      gameServers: GAME_SERVERS_WITH_HEALTH_CHECK,
      healthCheckFunctionArn,
    });

    const policy = findByName(mocks.resources, 'hyveon-watchdog-lambda-policy');
    const statements = (parsedPolicy(policy, 'policy') as { Statement: { Action: string[]; Resource: string }[] }).Statement;
    expect(statements).toContainEqual({ Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: healthCheckFunctionArn });
  });

  it('should omit lambda:InvokeFunction from the watchdog policy when no health-check function exists', async () => {
    const { provider, roles } = await arrangeRoles(FIXTURE_GAME_SERVERS);
    await runDefineIamPolicies({ projectName: 'hyveon', provider, roles, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-watchdog-lambda-policy');
    const statements = (parsedPolicy(policy, 'policy') as { Statement: { Action: string[] }[] }).Statement;
    expect(statements.some((s) => s.Action.includes('lambda:InvokeFunction'))).toBe(false);
  });
});
