/**
 * Tests for the watchdog Lambda.
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
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Uint8ArrayBlobAdapter } from '@smithy/core/serde';

/** Builds a mock InvokeCommand response Payload from a JSON-serializable value, matching the shape the AWS SDK returns. */
function invokePayload(value: unknown) {
  return Uint8ArrayBlobAdapter.fromString(JSON.stringify(value));
}

const ecsMock = mockClient(ECSClient);
const cwMock = mockClient(CloudWatchClient);
const lambdaMock = mockClient(LambdaClient);

process.env['ECS_CLUSTER'] = 'test-cluster';
process.env['GAME_NAMES'] = 'palworld,foundryvtt,checkedgame';
process.env['IDLE_CHECKS'] = '4';
process.env['MIN_PACKETS'] = '100';
process.env['CHECK_WINDOW_MINUTES'] = '15';
process.env['AWS_REGION_'] = 'us-east-1';
process.env['HEALTH_CHECK_FUNCTION_NAME'] = 'health-check-fn';
process.env['HEALTH_CHECKS'] = JSON.stringify({
  checkedgame: {
    kind: 'http',
    scheme: 'http',
    port: 8211,
    path: '/status',
    method: 'GET',
    timeoutMs: 2000,
    activeWhen: { jsonPath: 'players.online', operator: 'greaterThan', value: 0 },
  },
});

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
  lambdaMock.reset();
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

describe('watchdog handler: health-check routing', () => {
  it('should query CloudWatch and never invoke the health-check function for a game without a declared health check', async () => {
    const taskArn = 'arn:task/direct';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'palworld' })] });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Sum: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    await handler();

    expect(cwMock.commandCalls(GetMetricStatisticsCommand)).toHaveLength(1);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it('should invoke the health-check function and never query CloudWatch for a game with a declared health check', async () => {
    const taskArn = 'arn:task/checked';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame' })] });
    lambdaMock.on(InvokeCommand).resolves({
      Payload: invokePayload({ active: true, reason: 'players online', failureDerived: false }),
    });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    expect(cwMock.commandCalls(GetMetricStatisticsCommand)).toHaveLength(0);
  });

  it('should increment the idle counter when the health check reports idle', async () => {
    const taskArn = 'arn:task/checked-idle';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame' })] });
    lambdaMock.on(InvokeCommand).resolves({
      Payload: invokePayload({ active: false, reason: 'no players online', failureDerived: false }),
    });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '1' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    const tagCalls = ecsMock.commandCalls(TagResourceCommand);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]!.args[0]!.input.tags![0]).toEqual({ key: 'idle_checks', value: '2' });
  });

  it('should not increment the idle counter when the health-check invoke fails', async () => {
    const taskArn = 'arn:task/checked-fail';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame' })] });
    lambdaMock.on(InvokeCommand).rejects(new Error('Throttled'));
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '0' }] });

    await handler();

    expect(ecsMock.commandCalls(TagResourceCommand)).toHaveLength(0);
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  it('should not increment the idle counter when the health-check function returns a FunctionError', async () => {
    const taskArn = 'arn:task/checked-error';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame' })] });
    lambdaMock.on(InvokeCommand).resolves({ FunctionError: 'Unhandled', Payload: invokePayload({}) });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '0' }] });

    await handler();

    expect(ecsMock.commandCalls(TagResourceCommand)).toHaveLength(0);
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });
});
