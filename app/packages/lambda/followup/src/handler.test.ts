/**
 * Tests for the FollowupLambda — the async side of the Discord interaction
 * path that does actual ECS work and PATCHes the Discord webhook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
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

  it('should not write a pending row when RunTask reports no task', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    ecsMock.on(RunTaskCommand).resolves({ tasks: [], failures: [{ reason: 'capacity' }] });

    await handler(baseEvent('start', 'palworld'));

    expect(putPendingMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/Failed to start|capacity/);
  });

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

  it('should surface a friendly message when no running task is found to stop', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    await handler(baseEvent('stop', 'palworld'));
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toMatch(/not currently running/);
  });
});

describe('FollowupLambda: status', () => {
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
