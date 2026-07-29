import * as aws from '@pulumi/aws';
import type { GameServerConfig } from '@hyveon/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineIam, gamesWithFileSeeds, type DefineIamArgs } from './iam.js';
import { FIXTURE_GAME_SERVERS } from './testing/fixtures.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** The deferred-ARN parameters `defineIam` requires but no earlier dispatch (3.1/3.4) yet supplies for real — literal mock values standing in for task 3.2/3.6/3.8/3.9's eventual resource outputs. */
const DEFERRED_ARGS = {
  efsFileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-mock',
  dynamodbDiscordTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/hyveon-discord',
  discordPublicKeySecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-discord-public-key-abc123',
  followupLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:hyveon-followup',
  hostedZoneId: 'Z1234567890ABC',
} satisfies Pick<
  DefineIamArgs,
  'efsFileSystemArn' | 'dynamodbDiscordTableArn' | 'discordPublicKeySecretArn' | 'followupLambdaArn' | 'hostedZoneId'
>;

/**
 * Resolves every leaf resource `defineIam` declares — each policy/attachment
 * id, which transitively resolves its owning role via the mock recorder
 * (see `pulumiMocks.ts`'s `promiseOf` doc) — guaranteeing the full resource
 * set has been captured before assertions run.
 */
async function runDefineIam(args: Parameters<typeof defineIam>[0]): Promise<ReturnType<typeof defineIam>> {
  const result = defineIam(args);
  await Promise.all([
    promiseOf(result.ecsTaskExecutionPolicyAttachment.id),
    promiseOf(result.watchdogLambdaPolicy.id),
    promiseOf(result.followupLambdaPolicy.id),
    promiseOf(result.interactionsLambdaPolicy.id),
    promiseOf(result.dnsUpdaterLambdaPolicy.id),
    ...Object.values(result.efsSeederPolicies).map((policy) => promiseOf(policy.id)),
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

describe('defineIam', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the ECS task-execution role with the ecs-tasks.amazonaws.com trust policy', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIam({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider, ...DEFERRED_ARGS });

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
    await runDefineIam({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider, ...DEFERRED_ARGS });

    const attachment = findByName(mocks.resources, 'hyveon-task-execution-attachment');
    expect(attachment.type).toBe('aws:iam/rolePolicyAttachment:RolePolicyAttachment');
    expect(attachment.inputs.policyArn).toBe('arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy');
    expect(attachment.inputs.role).toBe('hyveon-task-execution');
  });

  it('should declare the watchdog Lambda role/policy with no external ARN dependency', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIam({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider, ...DEFERRED_ARGS });

    const role = findByName(mocks.resources, 'hyveon-watchdog-lambda');
    expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    });

    const policy = findByName(mocks.resources, 'hyveon-watchdog-lambda-policy');
    expect(policy.type).toBe('aws:iam/rolePolicy:RolePolicy');
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
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineIam({
      projectName: 'hyveon',
      gameServers: FIXTURE_GAME_SERVERS,
      provider,
      ...DEFERRED_ARGS,
    });

    const policy = findByName(mocks.resources, 'hyveon-followup-lambda-policy');
    const ecsTaskExecutionArn = await promiseOf(result.ecsTaskExecutionRole.arn);
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        { Effect: 'Allow', Action: ['ecs:RunTask', 'ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'], Resource: '*' },
        { Effect: 'Allow', Action: ['iam:PassRole'], Resource: ecsTaskExecutionArn },
        { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: DEFERRED_ARGS.dynamodbDiscordTableArn },
      ],
    });
  });

  it('should grant the interactions Lambda policy dynamodb, secretsmanager, and lambda:InvokeFunction on their respective deferred ARNs', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIam({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider, ...DEFERRED_ARGS });

    const policy = findByName(mocks.resources, 'hyveon-interactions-lambda-policy');
    expect(parsedPolicy(policy, 'policy')).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:aws:logs:*:*:*' },
        { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: DEFERRED_ARGS.dynamodbDiscordTableArn },
        { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: DEFERRED_ARGS.discordPublicKeySecretArn },
        { Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: DEFERRED_ARGS.followupLambdaArn },
      ],
    });
  });

  it('should grant the dns-updater Lambda policy route53 access scoped to the deferred hosted-zone id plus the wildcard change resource, and dynamodb access on the discord table', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineIam({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider, ...DEFERRED_ARGS });

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
          Resource: [`arn:aws:route53:::hostedzone/${DEFERRED_ARGS.hostedZoneId}`, 'arn:aws:route53:::change/*'],
        },
        { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:DeleteItem'], Resource: DEFERRED_ARGS.dynamodbDiscordTableArn },
      ],
    });
  });

  it('should declare no EFS-seeder roles/policies when no game declares file_seeds', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineIam({ projectName: 'hyveon', gameServers: FIXTURE_GAME_SERVERS, provider, ...DEFERRED_ARGS });

    expect(result.efsSeederRoles).toEqual({});
    expect(result.efsSeederPolicies).toEqual({});
  });

  it('should declare one EFS-seeder role/policy per game with file_seeds, granting elasticfilesystem access on the deferred EFS filesystem ARN', async () => {
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
    const result = await runDefineIam({ projectName: 'hyveon', gameServers, provider, ...DEFERRED_ARGS });

    expect(Object.keys(result.efsSeederRoles)).toEqual(['echo']);
    expect(Object.keys(result.efsSeederPolicies)).toEqual(['echo']);

    const role = findByName(mocks.resources, 'hyveon-efs-seeder-echo');
    expect(role.inputs.name).toBe('hyveon-efs-seeder-echo');
    expect(parsedPolicy(role, 'assumeRolePolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
    });

    const policy = findByName(mocks.resources, 'hyveon-efs-seeder-echo-policy');
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
          Resource: DEFERRED_ARGS.efsFileSystemArn,
        },
      ],
    });
  });
});
