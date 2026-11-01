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
process.env['MIN_BYTES_PER_SECOND'] = '1000';
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

/** A RUNNING task with no ENI attachment, since the watchdog identifies tasks by family alone. */
function runningTask(opts: { taskArn: string; game: string }) {
  return {
    taskArn: opts.taskArn,
    lastStatus: 'RUNNING',
    group: `family:${opts.game}-server`,
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
  // @spec RT-WATCHDOG-SCOPE-002
  it('should be a no-op when no tasks are running', async () => {
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
    const result = await handler();
    expect(result).toEqual({ checked: 0 });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  // @spec RT-WATCHDOG-SCOPE-004
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
  // @spec RT-WATCHDOG-CW-004, RT-WATCHDOG-STATE-003
  it('should increment the idle counter when the task is below the bytes-per-second threshold', async () => {
    const taskArn = 'arn:task/idle';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 10 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '1' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    const tagCalls = ecsMock.commandCalls(TagResourceCommand);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]!.args[0]!.input.tags![0]).toEqual({ key: 'idle_checks', value: '2' });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  // @spec RT-WATCHDOG-STATE-004
  it('should reset the counter when throughput meets the threshold and counter was non-zero', async () => {
    const taskArn = 'arn:task/active';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '2' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    const tagCalls = ecsMock.commandCalls(TagResourceCommand);
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0]!.args[0]!.input.tags![0]).toEqual({ key: 'idle_checks', value: '0' });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  // @spec RT-WATCHDOG-STATE-005
  it('should not write a tag when the counter was already zero and the task is active', async () => {
    const taskArn = 'arn:task/active';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    expect(ecsMock.commandCalls(TagResourceCommand)).toHaveLength(0);
  });
});

describe('watchdog handler: shutdown threshold', () => {
  // @spec RT-WATCHDOG-STOP-001
  it('should stop the task after IDLE_CHECKS consecutive idle windows (direct game)', async () => {
    const taskArn = 'arn:task/dead';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'palworld' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 0 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(StopTaskCommand).resolves({});

    await handler();

    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  // @spec RT-WATCHDOG-SCOPE-006, RT-WATCHDOG-STOP-001
  it('should stop an HTTPS-flagged game at the threshold, same as any other game', async () => {
    const taskArn = 'arn:task/dead';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'foundryvtt' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 0 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(StopTaskCommand).resolves({});

    await handler();

    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  // @spec RT-WATCHDOG-CW-005
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

describe('watchdog handler: Container Insights traffic verdict', () => {
  /** Runs one palworld task through the handler with the given CloudWatch response. */
  async function runWithMetric(resp: object | Error, idleTag = '3') {
    const taskArn = 'arn:task/cw';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'palworld' })] });
    if (resp instanceof Error) cwMock.on(GetMetricStatisticsCommand).rejects(resp);
    else cwMock.on(GetMetricStatisticsCommand).resolves(resp);
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: idleTag }] });
    ecsMock.on(TagResourceCommand).resolves({});
    ecsMock.on(StopTaskCommand).resolves({});
    return handler();
  }

  // @spec RT-WATCHDOG-CW-001
  it('should query ECS/ContainerInsights NetworkRxBytes by cluster and task-definition family', async () => {
    const before = Date.now();
    await runWithMetric({ Datapoints: [{ Average: 5000 }] });
    const input = cwMock.commandCalls(GetMetricStatisticsCommand)[0]!.args[0]!.input;
    expect(input.Namespace).toBe('ECS/ContainerInsights');
    expect(input.MetricName).toBe('NetworkRxBytes');
    expect(input.Dimensions).toEqual([
      { Name: 'ClusterName', Value: 'test-cluster' },
      { Name: 'TaskDefinitionFamily', Value: 'palworld-server' },
    ]);
    expect(input.Statistics).toEqual(['Average']);
    expect(input.Period).toBe(15 * 60);
    expect(input.EndTime!.getTime() - input.StartTime!.getTime()).toBe(15 * 60_000);
    expect(input.EndTime!.getTime()).toBeGreaterThanOrEqual(before);
  });

  // @spec RT-WATCHDOG-CW-002, RT-WATCHDOG-CW-007
  it('should evaluate a task that has no ENI attachment and make no EC2 call', async () => {
    const result = await runWithMetric({ Datapoints: [{ Average: 0 }] });
    expect(result.checked).toBe(1);
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  // @spec RT-WATCHDOG-CW-004
  it.each([
    { average: 999, idle: true },
    { average: 1000, idle: false },
    { average: 1001, idle: false },
  ])('should treat an Average of $average as idle=$idle against a threshold of 1000', async ({ average, idle }) => {
    await runWithMetric({ Datapoints: [{ Average: average }] }, '1');
    expect(ecsMock.commandCalls(TagResourceCommand)[0]!.args[0]!.input.tags![0]).toEqual({
      key: 'idle_checks',
      value: idle ? '2' : '0',
    });
  });

  // @spec RT-WATCHDOG-CW-005
  it('should treat a datapoint without an Average as active', async () => {
    await runWithMetric({ Datapoints: [{}] });
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
  });

  // @spec RT-WATCHDOG-CW-006
  it('should treat a failing CloudWatch query as active and warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runWithMetric(new Error('Throttled'));
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // @spec RT-WATCHDOG-LOG-001
  it('should log the real rxBytesPerSecond and threshold on an idle window', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWithMetric({ Datapoints: [{ Average: 42 }] }, '1');
    expect(log).toHaveBeenCalledWith('palworld: idle check 2/4 (rxBytesPerSecond=42, threshold=1000)');
    log.mockRestore();
  });
});

describe('watchdog handler: environment defaults', () => {
  // @spec RT-WATCHDOG-CFG-002
  it('should default IDLE_CHECKS, MIN_BYTES_PER_SECOND and CHECK_WINDOW_MINUTES to 4, 1000 and 15', async () => {
    const saved = {
      IDLE_CHECKS: process.env['IDLE_CHECKS'],
      MIN_BYTES_PER_SECOND: process.env['MIN_BYTES_PER_SECOND'],
      CHECK_WINDOW_MINUTES: process.env['CHECK_WINDOW_MINUTES'],
    };
    delete process.env['IDLE_CHECKS'];
    delete process.env['MIN_BYTES_PER_SECOND'];
    delete process.env['CHECK_WINDOW_MINUTES'];
    try {
      vi.resetModules();
      const fresh = await import('./handler.js');
      const taskArn = 'arn:task/defaults';
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
      ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'palworld' })] });
      cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 999 }] });
      ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
      ecsMock.on(StopTaskCommand).resolves({});
      await fresh.handler();
      expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(1);
      expect(ecsMock.commandCalls(StopTaskCommand)[0]!.args[0]!.input.reason).toBe('Watchdog: idle for 60 minutes');
      expect(cwMock.commandCalls(GetMetricStatisticsCommand)[0]!.args[0]!.input.Period).toBe(900);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('watchdog handler: health-check routing', () => {
  // @spec RT-WATCHDOG-ROUTE-002, RT-WATCHDOG-ROUTE-003
  it('should query CloudWatch and never invoke the health-check function for a game without a declared health check', async () => {
    const taskArn = 'arn:task/direct';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'palworld' })] });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    await handler();

    expect(cwMock.commandCalls(GetMetricStatisticsCommand)).toHaveLength(1);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  // @spec RT-WATCHDOG-ROUTE-001, RT-WATCHDOG-ROUTE-003, RT-WATCHDOG-HC-001
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

  // @spec RT-WATCHDOG-HC-002
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

  // @spec RT-WATCHDOG-HC-004, RT-WATCHDOG-STATE-007
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

  // @spec RT-WATCHDOG-HC-004, RT-WATCHDOG-STATE-007
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
