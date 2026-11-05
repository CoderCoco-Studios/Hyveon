/**
 * Tests for the FollowupLambda — the async side of the Discord interaction
 * path that does actual ECS work and PATCHes the Discord webhook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import {
  DescribeNetworkInterfacesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';

const getEffectiveDiscordConfigMock = vi.fn();
const putPendingMock = vi.fn();
vi.mock('@hyveon/shared', async () => {
  const actual = await vi.importActual<typeof import('@hyveon/shared')>('@hyveon/shared');
  return {
    ...actual,
    getEffectiveDiscordConfig: (...args: unknown[]) => getEffectiveDiscordConfigMock(...args),
    putPending: (...args: unknown[]) => putPendingMock(...args),
  };
});

const ecsMock = mockClient(ECSClient);
const ec2Mock = mockClient(EC2Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

process.env['TABLE_NAME'] = 'test-discord';
process.env['ECS_CLUSTER'] = 'test-cluster';
process.env['SUBNET_IDS'] = 'subnet-1,subnet-2';
process.env['SECURITY_GROUP_ID'] = 'sg-abc';
process.env['DOMAIN_NAME'] = 'example.com';
process.env['GAME_NAMES'] = 'palworld,satisfactory';
process.env['AWS_REGION_'] = 'us-east-1';

const { handler } = await import('./handler.js');

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

const PERMISSIVE_CONFIG = {
  clientId: 'app',
  allowedGuilds: ['G1'],
  admins: { userIds: ['U1'], roleIds: [] },
  gamePermissions: {
    palworld: { userIds: ['U1'], roleIds: [], actions: ['start', 'stop', 'status'] },
    satisfactory: { userIds: ['U1'], roleIds: [], actions: ['start', 'stop', 'status'] },
  },
};

function baseEvent(kind: 'start' | 'stop' | 'status' | 'list', game?: string) {
  return {
    kind,
    applicationId: 'app',
    interactionToken: 'tok1',
    userId: 'U1',
    guildId: 'G1',
    roleIds: [] as string[],
    ...(game ? { game } : {}),
  };
}

beforeEach(() => {
  ecsMock.reset();
  ec2Mock.reset();
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  fetchMock.mockReset();
  getEffectiveDiscordConfigMock.mockReset();
  putPendingMock.mockReset();
  getEffectiveDiscordConfigMock.mockResolvedValue(PERMISSIVE_CONFIG);
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('FollowupLambda: start', () => {
  // @spec RT-TASK-LAUNCH-004
  // @spec DISCORD-RUN-002, DISCORD-RUN-003, DISCORD-RUN-009, DISCORD-PEND-001
  it('should RunTask, write a pending row keyed by task ARN, and PATCH the original message', async () => {
    const taskArn = 'arn:aws:ecs:us-east-1:123:task/abc';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn, lastStatus: 'PROVISIONING' }] });

    await handler(baseEvent('start', 'palworld'));

    const runCalls = ecsMock.commandCalls(RunTaskCommand);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.args[0]!.input.taskDefinition).toBe('palworld-server');
    expect(runCalls[0]!.args[0]!.input.propagateTags).toBe('TASK_DEFINITION');
    expect(putPendingMock).toHaveBeenCalledWith('test-discord', expect.objectContaining({
      taskArn,
      applicationId: 'app',
      interactionToken: 'tok1',
      game: 'palworld',
      action: 'start',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/webhooks/app/tok1/messages/@original');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(init.body)).toMatchObject({ content: expect.stringContaining('palworld') });
  });

  // @spec DISCORD-RUN-005
  it('should not write a pending row when RunTask reports no task', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({ tasks: [], failures: [{ reason: 'capacity' }] });

    await handler(baseEvent('start', 'palworld'));

    expect(putPendingMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/Failed to start|capacity/);
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should take the LAUNCH#{game} lease and RunTask with the lease id as clientToken', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn:t1' }] });

    await handler(baseEvent('start', 'palworld'));

    const put = ddbMock.commandCalls(PutCommand)[0]!.args[0]!.input;
    expect(put.TableName).toBe('test-discord');
    expect(put.Item).toMatchObject({ pk: 'LAUNCH#palworld', sk: 'LOCK' });
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk) OR expiresAt < :now');
    const token = ecsMock.commandCalls(RunTaskCommand)[0]!.args[0]!.input.clientToken;
    expect(token).toBe(put.Item!['leaseId']);
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should refuse without RunTask when another start holds the lease', async () => {
    ddbMock.on(PutCommand).rejects(Object.assign(new Error('held'), { name: 'ConditionalCheckFailedException' }));

    await handler(baseEvent('start', 'palworld'));

    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
    expect(putPendingMock).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toBe('❌ A start for palworld is already in progress.');
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should fail closed without RunTask when the lease write errors', async () => {
    ddbMock.on(PutCommand).rejects(new Error('ddb down'));

    await handler(baseEvent('start', 'palworld'));

    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/Exception starting palworld/);
  });

  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  it('should fail closed without RunTask when the running-task pre-check errors', async () => {
    ecsMock.on(ListTasksCommand).rejects(new Error('ecs down'));

    await handler(baseEvent('start', 'palworld'));

    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/Exception starting palworld/);
  });

  // @spec DISCORD-RUN-001
  it('should deny the start when canRun() rejects the caller', async () => {
    getEffectiveDiscordConfigMock.mockResolvedValue({
      ...PERMISSIVE_CONFIG,
      admins: { userIds: [], roleIds: [] },
      gamePermissions: { palworld: { userIds: [], roleIds: [], actions: [] } },
    });

    await handler(baseEvent('start', 'palworld'));

    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0);
    expect(putPendingMock).not.toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content).toMatch(/don't have permission/);
  });
});

describe('FollowupLambda: stop', () => {
  // @spec DISCORD-RUN-006
  it('should StopTask the running task for a game and PATCH a confirmation message', async () => {
    const taskArn = 'arn:task-running';
    ecsMock
      .on(ListTasksCommand)
      .resolves({ taskArns: [taskArn] })
      .on(DescribeTasksCommand)
      .resolves({ tasks: [{ taskArn, lastStatus: 'RUNNING' }] });
    ecsMock.on(StopTaskCommand).resolves({});

    await handler(baseEvent('stop', 'palworld'));

    const stopCalls = ecsMock.commandCalls(StopTaskCommand);
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]!.args[0]!.input.task).toBe(taskArn);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/is stopping/);
  });

  // @spec DISCORD-RUN-006
  it('should surface a friendly message when no running task is found to stop', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    await handler(baseEvent('stop', 'palworld'));
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/not currently running/);
  });
});

describe('FollowupLambda: status', () => {
  // @spec DISCORD-RUN-008
  it('should format the game status line including hostname when the task is running', async () => {
    const taskArn = 'arn:task-running';
    ecsMock
      .on(ListTasksCommand)
      .resolves({ taskArns: [taskArn] })
      .on(DescribeTasksCommand)
      .resolves({
        tasks: [
          {
            taskArn,
            lastStatus: 'RUNNING',
            attachments: [
              {
                type: 'ElasticNetworkInterface',
                details: [{ name: 'networkInterfaceId', value: 'eni-abc' }],
              },
            ],
          },
        ],
      });
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });

    await handler(baseEvent('status', 'palworld'));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content).toContain('palworld');
    expect(body.content).toContain('running');
    expect(body.content).toContain('palworld.example.com');
  });
});

describe('FollowupLambda: list', () => {
  // @spec DISCORD-RUN-007
  it('should only fetch status for games the caller can view, and join lines with newlines', async () => {
    getEffectiveDiscordConfigMock.mockResolvedValue({
      ...PERMISSIVE_CONFIG,
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {
        palworld: { userIds: ['U1'], roleIds: [], actions: ['status'] },
        // satisfactory omitted — U1 should not be able to see it
      },
    });
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });

    await handler(baseEvent('list'));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content).toContain('palworld');
    expect(body.content).not.toContain('satisfactory');
  });

  // @spec DISCORD-RUN-007
  it('should return a helpful message when the caller can see nothing', async () => {
    getEffectiveDiscordConfigMock.mockResolvedValue({
      ...PERMISSIVE_CONFIG,
      admins: { userIds: [], roleIds: [] },
      gamePermissions: {},
    });

    await handler(baseEvent('list'));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content).toMatch(/don't have permission/);
  });
});

describe('FollowupLambda: failure handling', () => {
  // @spec DISCORD-RUN-010
  it('should still PATCH an error reply when the effective-config read throws', async () => {
    getEffectiveDiscordConfigMock.mockRejectedValue(new Error('dynamo down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handler(baseEvent('status', 'palworld'))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.content).toMatch(/Command failed/);
  });

  // @spec DISCORD-RUN-010, DISCORD-RUN-014
  it('should resolve without throwing when the final PATCH rejects', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    fetchMock.mockRejectedValue(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handler(baseEvent('status', 'palworld'))).resolves.toBeUndefined();
  });

  // @spec DISCORD-RUN-011
  it('should never write the interaction token to the logs on a handler failure', async () => {
    getEffectiveDiscordConfigMock.mockRejectedValue(new Error('dynamo down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = { ...baseEvent('status', 'palworld'), interactionToken: 'SECRET-TOKEN-xyz' };

    await handler(event);

    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET-TOKEN-xyz');
  });
});
