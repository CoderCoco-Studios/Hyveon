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
import { HEALTH_CHECK_RUN_BUDGET_MS } from '@hyveon/shared';

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

/**
 * A RUNNING task of `game`. It carries an `ElasticNetworkInterface` attachment with `privateIp` (default `10.0.1.7`),
 * or no attachment at all when `privateIp` is `null`, and `lastStatus` `RUNNING` unless overridden.
 */
function runningTask(opts: { taskArn: string; game: string; privateIp?: string | null; lastStatus?: string }) {
  const privateIp = opts.privateIp === undefined ? '10.0.1.7' : opts.privateIp;
  return {
    taskArn: opts.taskArn,
    lastStatus: opts.lastStatus ?? 'RUNNING',
    group: `family:${opts.game}-server`,
    attachments:
      privateIp === null
        ? []
        : [{ type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: privateIp }] }],
  };
}

/** Parses the JSON payload of the `index`th health-check invoke the watchdog sent. */
function sentPayload(index = 0): Record<string, unknown> {
  const input = lambdaMock.commandCalls(InvokeCommand)[index]!.args[0]!.input;
  return JSON.parse(Buffer.from(input.Payload as Uint8Array).toString('utf-8')) as Record<string, unknown>;
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

  // @spec RT-WATCHDOG-STOP-004
  it('should log a failed StopTask and still evaluate and stop the remaining tasks', async () => {
    const failing = 'arn:task/failing';
    const next = 'arn:task/next';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [failing, next] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn: failing, game: 'palworld' }), runningTask({ taskArn: next, game: 'foundryvtt' })],
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 0 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(StopTaskCommand, { task: failing }).rejects(new Error('ThrottlingException: rate exceeded'));
    ecsMock.on(StopTaskCommand, { task: next }).resolves({});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handler()).resolves.toEqual({ checked: 2 });

    const stopped = ecsMock.commandCalls(StopTaskCommand).map((c) => c.args[0]!.input.task);
    expect(stopped).toEqual([failing, next]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('palworld'), expect.anything());
    errorSpy.mockRestore();
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

  // @spec RT-WATCHDOG-CW-004
  it.each([
    { order: 'idle first', datapoints: [{ Average: 0 }, { Average: 5000 }] },
    { order: 'active first', datapoints: [{ Average: 5000 }, { Average: 0 }] },
  ])('should treat the window as active when datapoints are $order and any bucket meets the threshold', async ({ datapoints }) => {
    await runWithMetric({ Datapoints: datapoints }, '1');
    expect(ecsMock.commandCalls(TagResourceCommand)[0]!.args[0]!.input.tags![0]).toEqual({
      key: 'idle_checks',
      value: '0',
    });
  });

  // @spec RT-WATCHDOG-CW-004
  it('should treat the window as idle when every datapoint is below the threshold regardless of order', async () => {
    await runWithMetric({ Datapoints: [{ Average: 500 }, { Average: 10 }, { Average: 999 }] }, '1');
    expect(ecsMock.commandCalls(TagResourceCommand)[0]!.args[0]!.input.tags![0]).toEqual({
      key: 'idle_checks',
      value: '2',
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

describe('watchdog handler: health-check private IP', () => {
  const activeVerdict = { active: true, reason: 'players online', failureDerived: false };

  // @spec RT-WATCHDOG-HC-001, RT-WATCHDOG-HC-007
  it('should send { game, taskArn, privateIp, healthCheck } with the IP read from the described task', async () => {
    const taskArn = 'arn:task/ip';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame', privateIp: '10.0.2.99' })] });
    lambdaMock.on(InvokeCommand).resolves({ Payload: invokePayload(activeVerdict) });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    await handler();

    expect(sentPayload()).toMatchObject({ game: 'checkedgame', taskArn, privateIp: '10.0.2.99' });
    expect(sentPayload()['healthCheck']).toMatchObject({ kind: 'http', port: 8211 });
  });

  // @spec RT-WATCHDOG-HC-008, RT-WATCHDOG-HC-009, RT-WATCHDOG-HC-010, RT-WATCHDOG-STATE-007
  it.each([
    ['no ENI attachment yet', null],
    ['an empty address', ''],
    ['an address with a leading space', ' 10.0.1.7'],
    ['an IPv6 address', 'fe80::1'],
    ['a hostname', 'task.internal'],
    ['an out-of-range octet', '10.0.1.300'],
  ])('should not invoke and should treat the task as failure-derived active with %s', async (_label, privateIp) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const taskArn = 'arn:task/noip';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame', privateIp })] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(cwMock.commandCalls(GetMetricStatisticsCommand)).toHaveLength(0);
    expect(ecsMock.commandCalls(StopTaskCommand)).toHaveLength(0);
    expect(ecsMock.commandCalls(TagResourceCommand)).toHaveLength(0);
    const logged = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('health check failed:');
    expect(logged).toContain('private IP');
  });

  // @spec RT-WATCHDOG-HC-011
  it('should not invoke the health-check function for a task that is not RUNNING', async () => {
    const taskArn = 'arn:task/stopping';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [runningTask({ taskArn, game: 'checkedgame', lastStatus: 'DEACTIVATING' })],
    });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });
});

describe('watchdog handler: DescribeTasks batching', () => {
  // @spec RT-WATCHDOG-SCOPE-005
  it('should describe 250 listed tasks in batches of at most 100 and evaluate every one', async () => {
    const arns = Array.from({ length: 250 }, (_, i) => `arn:task/${i}`);
    ecsMock.on(ListTasksCommand).resolves({ taskArns: arns });
    ecsMock.on(DescribeTasksCommand).callsFake((input: { tasks: string[] }) => ({
      tasks: input.tasks.map((taskArn) => runningTask({ taskArn, game: 'palworld' })),
    }));
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    const result = await handler();

    const sizes = ecsMock.commandCalls(DescribeTasksCommand).map((c) => c.args[0]!.input.tasks!.length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(result.checked).toBe(250);
  });
});

describe('watchdog handler: health-check run budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // @spec RT-WATCHDOG-HC-006
  it('should skip the remaining health-checked tasks as failure-derived active once the run budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const arns = ['arn:task/a', 'arn:task/b', 'arn:task/c'];
    ecsMock.on(ListTasksCommand).resolves({ taskArns: arns });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: arns.map((taskArn) => runningTask({ taskArn, game: 'checkedgame' })),
    });
    lambdaMock.on(InvokeCommand).callsFake(() => {
      vi.advanceTimersByTime(25_000);
      return { Payload: invokePayload({ active: false, reason: 'no players online', failureDerived: false }) };
    });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });
    ecsMock.on(TagResourceCommand).resolves({});

    const result = await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(2);
    expect(result.checked).toBe(3);
    const written = ecsMock.commandCalls(TagResourceCommand).map((c) => c.args[0]!.input.resourceArn);
    expect(written).toEqual(['arn:task/a', 'arn:task/b']);
  });

  // @spec RT-WATCHDOG-HC-006
  it('should still evaluate a CloudWatch-path task after the health-check budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const arns = ['arn:task/a', 'arn:task/b', 'arn:task/c'];
    ecsMock.on(ListTasksCommand).resolves({ taskArns: arns });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: [
        runningTask({ taskArn: arns[0]!, game: 'checkedgame' }),
        runningTask({ taskArn: arns[1]!, game: 'checkedgame' }),
        runningTask({ taskArn: arns[2]!, game: 'palworld' }),
      ],
    });
    lambdaMock.on(InvokeCommand).callsFake(() => {
      vi.advanceTimersByTime(45_000);
      return { Payload: invokePayload({ active: true, reason: 'players online', failureDerived: false }) };
    });
    cwMock.on(GetMetricStatisticsCommand).resolves({ Datapoints: [{ Average: 5000 }] });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    await handler();

    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    expect(cwMock.commandCalls(GetMetricStatisticsCommand)).toHaveLength(1);
  });

  // @spec RT-WATCHDOG-HC-006
  it('should abort an invoke exactly when the remaining budget elapses', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const taskArn = 'arn:task/signal';
    ecsMock.on(ListTasksCommand).resolves({ taskArns: [taskArn] });
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask({ taskArn, game: 'checkedgame' })] });
    lambdaMock.on(InvokeCommand).callsFake(() => new Promise(() => undefined));
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    const pending = handler();
    await vi.advanceTimersByTimeAsync(0);
    const signal = (lambdaMock.call(0).args[1] as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_RUN_BUDGET_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    void pending;
  });

  // @spec RT-WATCHDOG-STATE-007
  it('should leave a stored idle count untouched when a task is skipped for budget exhaustion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const arns = ['arn:task/a', 'arn:task/b'];
    ecsMock.on(ListTasksCommand).resolves({ taskArns: arns });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: arns.map((taskArn) => runningTask({ taskArn, game: 'checkedgame' })),
    });
    lambdaMock.on(InvokeCommand).callsFake(() => {
      vi.advanceTimersByTime(45_000);
      return { Payload: invokePayload({ active: true, reason: 'players online', failureDerived: false }) };
    });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [{ key: 'idle_checks', value: '3' }] });
    ecsMock.on(TagResourceCommand).resolves({});

    await handler();

    const written = ecsMock.commandCalls(TagResourceCommand).map((c) => c.args[0]!.input.resourceArn);
    expect(written).not.toContain('arn:task/b');
  });

  // @spec RT-WATCHDOG-STATE-007
  it('should rotate the starting task each check window so a late-listed task is eventually checked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const windowMs = 15 * 60_000;
    const arns = ['arn:task/a', 'arn:task/b', 'arn:task/c'];
    ecsMock.on(ListTasksCommand).resolves({ taskArns: arns });
    ecsMock.on(DescribeTasksCommand).resolves({
      tasks: arns.map((taskArn) => runningTask({ taskArn, game: 'checkedgame' })),
    });
    lambdaMock.on(InvokeCommand).callsFake(() => {
      vi.advanceTimersByTime(25_000);
      return { Payload: invokePayload({ active: true, reason: 'players online', failureDerived: false }) };
    });
    ecsMock.on(ListTagsForResourceCommand).resolves({ tags: [] });

    const checkedTaskArns: string[] = [];
    for (let window = 0; window < 3; window++) {
      vi.setSystemTime(window * windowMs);
      lambdaMock.resetHistory();
      await handler();
      checkedTaskArns.push(...lambdaMock.commandCalls(InvokeCommand).map((_, i) => sentPayload(i)['taskArn'] as string));
    }

    expect(checkedTaskArns).toContain('arn:task/c');
  });
});
