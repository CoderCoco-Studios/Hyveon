/**
 * Tests for the watchdog Lambda — TypeScript port of watchdog.py.
 *
 * Covers: idle counter increment via ECS task tags, threshold-based shutdown
 * (uniform for every game, including HTTPS-flagged ones now that TLS
 * terminates in-task via a Caddy sidecar), and counter reset when activity is
 * detected. DNS deletion is owned by `@hyveon/lambda-update-dns` reacting to
 * the `STOPPED` state-change event `StopTask` produces, so it isn't asserted
 * here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DescribeTasksCommand,
  ECSClient,
  ListTagsForResourceCommand,
  ListTasksCommand,
  StopTaskCommand,
  TagResourceCommand,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';

const ecsMock = mockClient(ECSClient);
const cwMock = mockClient(CloudWatchClient);

process.env['ECS_CLUSTER'] = 'test-cluster';
process.env['GAME_NAMES'] = 'palworld,foundryvtt';
process.env['IDLE_CHECKS'] = '4';
process.env['MIN_PACKETS'] = '100';
process.env['CHECK_WINDOW_MINUTES'] = '15';
process.env['AWS_REGION_'] = 'us-east-1';

const { handler } = await import('./handler.js');

function runningTask(opts: { taskArn: string; game: string; eniId?: string }) {
  return {
    taskArn: opts.taskArn,
    lastStatus: 'RUNNING',
    group: `family:${opts.game}-server`,
    attachments: [
      {
        type: 'ElasticNetworkInterface',
        details: [{ name: 'networkInterfaceId', value: opts.eniId ?? 'eni-xyz' }],
      },
    ],
  };
}

beforeEach(() => {
  ecsMock.reset();
  cwMock.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('watchdog handler: no tasks', () => {
  it('should be a no-op when no tasks are running', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    const result = await handler();
    expect(result).toEqual({ checked: 0 });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  it('should ignore unknown task families', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: ['arn:1'] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [{ taskArn: 'arn:1', lastStatus: 'RUNNING', group: 'family:stranger-server' }],
    });
    const result = await handler();
    expect(result.checked).toBe(0);
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });
});

describe('watchdog handler: idle counter', () => {
  it('should increment the idle counter when the task is below the packets threshold', async () => {
    const taskArn = 'arn:task/idle';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 10 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '1' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    const tagCalls = ecsMock.commandCalls(TagResourceCommand);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]!.args[0]!.input.tags![0]).toEqual({ key: 'idle_checks', value: '2' });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  it('should reset the counter when packets meet the threshold and counter was non-zero', async () => {
    const taskArn = 'arn:task/active';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '2' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    const tagCalls = ecsMock.commandCalls(TagResourceCommand);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]!.args[0]!.input.tags![0]).toEqual({ key: 'idle_checks', value: '0' });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  it('should not write a tag when the counter was already zero and the task is active', async () => {
    const taskArn = 'arn:task/active';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    expect(ecsMock.commandCalls(TagResourceCommand)).toHaveLength(0);
  });
});

describe('watchdog handler: shutdown threshold', () => {
  it('should stop the task after IDLE_CHECKS consecutive idle windows (direct game)', async () => {
    const taskArn = 'arn:task/dead';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 0 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(StopTaskCommand).resolves({});

    await handler();

    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  it('should stop an HTTPS-flagged game at the threshold, same as any other game', async () => {
    const taskArn = 'arn:task/dead';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'foundryvtt' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 0 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(StopTaskCommand).resolves({});

    await handler();

    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  it('should treat missing CloudWatch datapoints as active (no shutdown of brand-new tasks)', async () => {
    const taskArn = 'arn:task/new';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });

    await handler();

    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });
});
