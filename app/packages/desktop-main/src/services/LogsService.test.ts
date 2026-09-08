import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import { LogsService } from './LogsService.js';
import { createAwsCloudProvider } from './EcsService.js';
import type { ConfigService } from './ConfigService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { deploymentConfigStub } from '../testing/deployment-config.fixture.js';

/** Typed stand-in for the AWS CloudWatch Logs SDK client. */
const cwMock = mockClient(CloudWatchLogsClient);

/**
 * Build a minimal ConfigService stub exposing only the members LogsService
 * (and, transitively, the `AwsCloudProvider` it delegates `streamLogs` to)
 * actually read at runtime.
 */
function makeConfig(): ConfigService {
  return configServiceStub({ outputs: stackOutputs({ subnetIds: ['subnet-a'], efsAccessPoints: {} }) });
}

/**
 * Build a minimal `ElectronStoreService` stub reporting no wizard-configured
 * AWS profile — `resolveAwsClientCredentials` resolves this to `undefined`
 * credentials, letting the globally-patched `cwMock` client intercept calls
 * regardless of what `credentials` the client was constructed with.
 */
function makeStore(): ElectronStoreService {
  const stub: Partial<ElectronStoreService> = { get: vi.fn().mockReturnValue(undefined) };
  return stub as ElectronStoreService;
}

/**
 * Builds a stub {@link DeploymentConfigService} whose `getTopLevelSettings()`
 * resolves with the given project name — mirrors
 * `CloudHealthService.test.ts`'s helper of the same name. Passing no
 * `projectName` override (an empty `settings` object) exercises
 * `resolveLambdaLogGroup`'s fallback to `DEPLOYMENT_CONFIG_DEFAULTS`.
 */
function makeDeploymentConfig(projectName?: string): DeploymentConfigService {
  return deploymentConfigStub({ projectName });
}

/**
 * Constructs a `LogsService` for tests, standing in for the constructor
 * default that used to build an `AwsCloudProvider` internally — the service
 * now requires its `CloudProvider` to be passed explicitly (as Nest's DI
 * does via the `CLOUD_PROVIDER` token in production), so tests wire a real
 * `AwsCloudProvider` built from the same `config` stub. Its internal AWS SDK
 * calls (`FilterLogEventsCommand` for `streamLogs`) are still covered by the
 * globally-patched `cwMock` client, so behaviour is unchanged.
 */
function makeService(config: ConfigService, deploymentConfig: DeploymentConfigService = makeDeploymentConfig()): LogsService {
  const store = makeStore();
  return new LogsService(config, createAwsCloudProvider(config, store), store, deploymentConfig);
}

/** Builds a `DescribeLogStreamsCommand` resolved value listing `names`, newest first. */
function streamsResponse(names: string[]): { logStreams: { logStreamName: string }[] } {
  return { logStreams: names.map((logStreamName) => ({ logStreamName })) };
}

describe('LogsService', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    service = makeService(makeConfig());
  });

  it('should return a "no streams" line when the log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    const page = await service.getRecentLogs('minecraft');
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]!.message).toMatch(/no log streams/i);
  });

  it('should query the /ecs/{game}-server log group and fetch the newest stream', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 'ecs/stream1' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'line1', timestamp: 100 }, { message: 'line2', timestamp: 200 }],
    });

    const page = await service.getRecentLogs('minecraft', 25);
    expect(page.lines.map((l) => l.message)).toEqual(['line1', 'line2']);
    expect(page.lines[0]!.timestamp).toBe(100);

    const descInput = cwMock.commandCalls(DescribeLogStreamsCommand)[0]!.args[0].input;
    expect(descInput.logGroupName).toBe('/ecs/minecraft-server');
    expect(descInput.orderBy).toBe('LastEventTime');
    expect(descInput.descending).toBe(true);
    expect(descInput.limit).toBe(1);

    const getInput = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(getInput.logGroupName).toBe('/ecs/minecraft-server');
    expect(getInput.logStreamName).toBe('ecs/stream1');
    expect(getInput.limit).toBe(25);
    expect(getInput.startFromHead).toBe(false);
  });

  it('should default the event limit to 50', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 's' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({ events: [] });
    await service.getRecentLogs('minecraft');
    const input = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(input.limit).toBe(50);
  });

  it('should return an empty lines array when events are undefined', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 's' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({});
    const page = await service.getRecentLogs('minecraft');
    expect(page.lines).toEqual([]);
  });

  it('should map a missing event.message to an empty string', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({
      logStreams: [{ logStreamName: 's' }],
    });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'a', timestamp: 100 }, { timestamp: 200 }],
    });
    const page = await service.getRecentLogs('minecraft');
    expect(page.lines.map((l) => l.message)).toEqual(['a', '']);
  });

  it('should return an error line when the API throws', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));
    const page = await service.getRecentLogs('minecraft');
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]!.message).toMatch(/error fetching logs for minecraft/i);
    expect(page.lines[0]!.message).toContain('denied');
  });

  it('should log a warning-level failure via logger.error when the API throws, without letting the raw error escape', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));

    await service.getRecentLogs('minecraft');

    expect(loggerMock.error).toHaveBeenCalledWith(
      'LogsService.getRecentLogs: failed to fetch logs',
      expect.objectContaining({ game: 'minecraft', logGroup: '/ecs/minecraft-server', error: 'denied' }),
    );
  });

  it('should log a debug entry line before fetching recent logs', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });

    await service.getRecentLogs('minecraft', 25);

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'LogsService.getRecentLogs: fetching recent logs',
      expect.objectContaining({ game: 'minecraft', limit: 25 }),
    );
  });
});

describe('LogsService.getOlderLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    loggerMock.warn.mockReset();
    service = makeService(makeConfig());
  });

  it('should fetch older events bounded by endTime from the newest log stream', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 'ecs/stream1' }] });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'older1', timestamp: 500 }, { message: 'older2', timestamp: 600 }],
    });

    const page = await service.getOlderLogs('minecraft', 1000, 25);

    expect(page.lines.map((l) => l.message)).toEqual(['older1', 'older2']);
    expect(page.lines[0]!.timestamp).toBe(500);
    expect(page.atOldest).toBe(false);

    const getInput = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(getInput.logGroupName).toBe('/ecs/minecraft-server');
    expect(getInput.logStreamName).toBe('ecs/stream1');
    expect(getInput.limit).toBe(25);
    expect(getInput.startFromHead).toBe(false);
    expect(getInput.endTime).toBe(1000);
  });

  it('should report atOldest true when no events come back before the boundary and every stream was scanned', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 's' }] });
    cwMock.on(GetLogEventsCommand).resolves({ events: [] });

    const page = await service.getOlderLogs('minecraft', 1000);

    expect(page.lines).toEqual([]);
    expect(page.atOldest).toBe(true);
  });

  it('should throw when the log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });

    await expect(service.getOlderLogs('minecraft', 1000)).rejects.toThrow(/no log streams/i);
  });

  it('should throw a plain Error and log a warning when the CloudWatch call fails', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));

    await expect(service.getOlderLogs('minecraft', 1000)).rejects.toThrow('denied');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'LogsService.getOlderLogs: failed to fetch older logs',
      expect.objectContaining({ game: 'minecraft', error: 'denied' }),
    );
  });

  it('should accumulate events across multiple log streams when the newest stream alone does not fill the requested limit', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-new', 'stream-old']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-new' })
      .resolves({ events: [{ message: 'from-new', timestamp: 900 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-old' })
      .resolves({ events: [{ message: 'from-old-1', timestamp: 500 }, { message: 'from-old-2', timestamp: 600 }] });

    const page = await service.getOlderLogs('minecraft', 1000, 10);

    // Restarting the game server orphans older history in a stream
    // DescribeLogStreams' single-newest-stream query never looked at — the
    // accumulated result must include events from every scanned stream,
    // oldest first.
    expect(page.lines.map((l) => l.message)).toEqual(['from-old-1', 'from-old-2', 'from-new']);
    expect(page.lines[0]!.timestamp).toBe(500);
    expect(page.atOldest).toBe(false);
  });

  it('should trim accumulated cross-stream events to the requested limit, keeping those closest to beforeTimestamp', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-a', 'stream-b']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-a' })
      .resolves({ events: [{ message: 'a1', timestamp: 700 }, { message: 'a2', timestamp: 800 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-b' })
      .resolves({ events: [{ message: 'b1', timestamp: 100 }, { message: 'b2', timestamp: 200 }] });

    const page = await service.getOlderLogs('minecraft', 1000, 2);

    expect(page.lines.map((l) => l.message)).toEqual(['a1', 'a2']);
    expect(page.lines[0]!.timestamp).toBe(700);
  });

  it('should stop scanning further streams once the accumulated count reaches the requested limit', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-a', 'stream-b']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-a' })
      .resolves({ events: [{ message: 'a1', timestamp: 700 }, { message: 'a2', timestamp: 800 }] });

    await service.getOlderLogs('minecraft', 1000, 2);

    expect(cwMock.commandCalls(GetLogEventsCommand, { logStreamName: 'stream-b' })).toHaveLength(0);
  });

  it('should not report atOldest when the scan cap was hit before every stream was exhausted', async () => {
    // 50 streams fills the scan cap on the first DescribeLogStreams page, so
    // pagination's nextToken (if any) is never consulted — atOldest must not
    // be reported as true even though this page came back empty.
    const names = Array.from({ length: 50 }, (_, i) => `stream-${i}`);
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: names.map((logStreamName) => ({ logStreamName })), nextToken: 'more' });
    cwMock.on(GetLogEventsCommand).resolves({ events: [] });

    const page = await service.getOlderLogs('minecraft', 1000, 10);

    expect(page.lines).toEqual([]);
    expect(page.atOldest).toBe(false);
  });

  it('should paginate DescribeLogStreamsCommand via nextToken', async () => {
    cwMock
      .on(DescribeLogStreamsCommand)
      .resolvesOnce({ logStreams: [{ logStreamName: 'stream-a' }], nextToken: 'page2' })
      .resolves({ logStreams: [{ logStreamName: 'stream-b' }] });
    cwMock.on(GetLogEventsCommand).resolves({ events: [] });

    await service.getOlderLogs('minecraft', 1000, 10);

    expect(cwMock.commandCalls(DescribeLogStreamsCommand)).toHaveLength(2);
    const secondCall = cwMock.commandCalls(DescribeLogStreamsCommand)[1]!.args[0].input;
    expect(secondCall.nextToken).toBe('page2');
  });
});

describe('LogsService.getNewerLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    loggerMock.warn.mockReset();
    service = makeService(makeConfig());
  });

  it('should fetch newer events bounded by startTime, oldest first', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 'ecs/stream1' }] });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'newer1', timestamp: 1100 }, { message: 'newer2', timestamp: 1200 }],
    });

    const page = await service.getNewerLogs('minecraft', 1000, 25);

    expect(page.lines.map((l) => l.message)).toEqual(['newer1', 'newer2']);
    expect(page.lines[page.lines.length - 1]!.timestamp).toBe(1200);
    expect(page.hasMore).toBe(false);

    const getInput = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(getInput.logGroupName).toBe('/ecs/minecraft-server');
    expect(getInput.startFromHead).toBe(true);
    expect(getInput.startTime).toBe(1000);
  });

  it('should accumulate events across multiple log streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-a', 'stream-b']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-a' })
      .resolves({ events: [{ message: 'a1', timestamp: 1100 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-b' })
      .resolves({ events: [{ message: 'b1', timestamp: 1200 }] });

    const page = await service.getNewerLogs('minecraft', 1000, 10);

    expect(page.lines.map((l) => l.message)).toEqual(['a1', 'b1']);
  });

  it('should report hasMore true when the accumulated page came back full', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 's' }] });
    cwMock.on(GetLogEventsCommand).resolves({
      events: [{ message: 'a', timestamp: 1100 }, { message: 'b', timestamp: 1200 }],
    });

    const page = await service.getNewerLogs('minecraft', 1000, 2);

    expect(page.hasMore).toBe(true);
    expect(page.lines.map((l) => l.message)).toEqual(['a', 'b']);
  });

  it('should report every eventId at the newest timestamp so a caller can exclude them on the next call', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 's' }] });
    // Two distinct events share the exact same millisecond timestamp.
    cwMock.on(GetLogEventsCommand).resolves({
      events: [
        { message: 'a', timestamp: 1000 },
        { message: 'b1', timestamp: 1100 },
        { message: 'b2', timestamp: 1100 },
      ],
    });

    const page = await service.getNewerLogs('minecraft', 900, 10);

    const newestTimestamp = page.lines[page.lines.length - 1]!.timestamp;
    expect(newestTimestamp).toBe(1100);
    expect(page.lines.filter((l) => l.timestamp === newestTimestamp).map((l) => l.eventId)).toEqual([
      '1100:b1',
      '1100:b2',
    ]);
  });

  it('should exclude previously-delivered boundary events when excludeEventIds is passed, since startTime is inclusive', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 's' }] });
    cwMock.on(GetLogEventsCommand).resolves({
      // startTime is inclusive, so a naive re-query at afterTimestamp=1100
      // would return 'b' (already delivered by the previous page) again,
      // alongside the genuinely new 'c'.
      events: [
        { message: 'b', timestamp: 1100 },
        { message: 'c', timestamp: 1200 },
      ],
    });

    const page = await service.getNewerLogs('minecraft', 1100, 10, ['1100:b']);

    expect(page.lines.map((l) => l.message)).toEqual(['c']);
  });

  it('should deliver both events when two different streams each have an event sharing the same synthesized eventId, instead of dropping the second as a false-positive duplicate', async () => {
    // Bug 1 regression: the synthesized `${timestamp}:${message}` eventId is
    // a global identity, not a per-stream one. Two different streams can
    // each have an event with the exact same timestamp and message (e.g. a
    // repeated static heartbeat line). A Set-based exclusion would treat the
    // second stream's event as "already delivered" (because it shares the
    // same key as the first stream's event, delivered on a previous call)
    // and drop it, permanently losing a genuinely-undelivered event.
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-a', 'stream-b']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-a' })
      .resolves({ events: [{ message: 'same', timestamp: 1000 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-b' })
      .resolves({ events: [{ message: 'same', timestamp: 1000 }] });

    const page1 = await service.getNewerLogs('minecraft', 900, 1);
    expect(page1.lines).toHaveLength(1);
    expect(page1.lines[0]!.eventId).toBe('1000:same');

    const page2 = await service.getNewerLogs('minecraft', 1000, 10, [page1.lines[0]!.eventId]);

    // The second stream's byte-identical event must still be delivered —
    // it is a genuinely different CloudWatch event, not the one excluded.
    expect(page2.lines).toHaveLength(1);
    expect(page2.lines[0]!.eventId).toBe('1000:same');
  });

  it('should trim to the oldest `limit` events when accumulation exceeds the requested limit', async () => {
    // Realistic recency ordering: the newest-listed stream has the later
    // timestamps, matching DescribeLogStreams' descending-by-LastEventTime
    // order this whole multi-stream design relies on.
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-new', 'stream-old']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-old' })
      .resolves({ events: [{ message: 'a1', timestamp: 1000 }, { message: 'a2', timestamp: 1100 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-new' })
      .resolves({ events: [{ message: 'b1', timestamp: 1200 }, { message: 'b2', timestamp: 1300 }] });

    const page = await service.getNewerLogs('minecraft', 900, 2);

    expect(page.lines.map((l) => l.message)).toEqual(['a1', 'a2']);
    expect(page.lines[page.lines.length - 1]!.timestamp).toBe(1100);
  });

  it('should prefer an older stream\'s boundary-adjacent events over a newer stream\'s much-later events', async () => {
    // Reproduces the restart scenario: an older, since-rotated stream has
    // events right after `afterTimestamp`, while the newest (currently
    // active) stream only has much-later events because it just started.
    // Scanning newest-first and breaking once `limit` is reached would
    // wrongly fill the page from the newest stream's later events and never
    // even query the older stream that actually holds the boundary-adjacent
    // history.
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-new', 'stream-old']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-new' })
      .resolves({ events: [{ message: 'far-future-1', timestamp: 5000 }, { message: 'far-future-2', timestamp: 5001 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-old' })
      .resolves({ events: [{ message: 'boundary-1', timestamp: 901 }, { message: 'boundary-2', timestamp: 902 }] });

    const page = await service.getNewerLogs('minecraft', 900, 2);

    expect(page.lines.map((l) => l.message)).toEqual(['boundary-1', 'boundary-2']);
    expect(page.lines[page.lines.length - 1]!.timestamp).toBe(902);
  });

  it('should throw when the log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });

    await expect(service.getNewerLogs('minecraft', 1000)).rejects.toThrow(/no log streams/i);
  });

  it('should throw a plain Error and log a warning when the CloudWatch call fails', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));

    await expect(service.getNewerLogs('minecraft', 1000)).rejects.toThrow('denied');
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'LogsService.getNewerLogs: failed to fetch newer logs',
      expect.objectContaining({ game: 'minecraft', error: 'denied' }),
    );
  });
});

describe('LogsService.streamLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    service = makeService(makeConfig());
  });

  it('should log a debug entry line before starting the log stream', async () => {
    const ac = new AbortController();
    ac.abort();

    const gen = service.streamLogs('minecraft', ac.signal, 0);
    await gen.next(); // already-aborted signal yields nothing, but the debug entry log fires first

    expect(loggerMock.debug).toHaveBeenCalledWith(
      'LogsService.streamLogs: starting log stream',
      expect.objectContaining({ game: 'minecraft', pollInterval: 0 }),
    );
  });

  it('should terminate immediately when signal is already aborted before the first poll', async () => {
    const ac = new AbortController();
    ac.abort();

    const lines: string[] = [];
    for await (const line of service.streamLogs('minecraft', ac.signal, 0)) {
      lines.push(line);
    }

    expect(lines).toEqual([]);
    expect(cwMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });

  it('should yield log lines from the first poll and terminate on abort', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({
      events: [
        { eventId: 'e1', timestamp: 1000, message: 'line1' },
        { eventId: 'e2', timestamp: 2000, message: 'line2' },
      ],
    });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: l1 } = await gen.next();
    const { value: l2 } = await gen.next();
    ac.abort();
    const { done } = await gen.next();

    expect(l1).toBe('line1');
    expect(l2).toBe('line2');
    expect(done).toBe(true);
  });

  it('should yield new events from successive polls', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'first' }] })
      .resolves({ events: [{ eventId: 'e2', timestamp: 2000, message: 'second' }] });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: l1 } = await gen.next();
    const { value: l2 } = await gen.next();
    ac.abort();
    await gen.return(undefined);

    expect(l1).toBe('first');
    expect(l2).toBe('second');
  });

  it('should de-duplicate events with the same eventId across polls', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'line1' }] })
      .resolvesOnce({
        events: [
          { eventId: 'e1', timestamp: 1000, message: 'line1' }, // already seen
          { eventId: 'e2', timestamp: 2000, message: 'line2' }, // new
        ],
      });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: l1 } = await gen.next(); // first poll yields 'line1'
    const { value: l2 } = await gen.next(); // second poll skips duplicate, yields 'line2'
    ac.abort();
    await gen.return(undefined);

    expect(l1).toBe('line1');
    expect(l2).toBe('line2');
  });

  it('should query the /ecs/{game}-server log group', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({
      events: [{ eventId: 'e1', timestamp: 1000, message: 'hello' }],
    });

    const ac = new AbortController();
    const gen = service.streamLogs('valheim', ac.signal, 0);

    await gen.next(); // first poll runs and yields 'hello'
    ac.abort();
    await gen.return(undefined);

    const calls = cwMock.commandCalls(FilterLogEventsCommand);
    expect(calls[0]!.args[0].input.logGroupName).toBe('/ecs/valheim-server');
  });

  it('should yield a stream-error sentinel and continue when a poll throws', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .rejectsOnce(new Error('throttled'))
      .resolves({ events: [{ eventId: 'e1', timestamp: 1000, message: 'recovered' }] });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: errLine } = await gen.next(); // first poll throws
    const { value: okLine } = await gen.next(); // second poll succeeds
    ac.abort();
    await gen.return(undefined);

    expect(errLine).toMatch(/\[stream error\].*throttled/);
    expect(okLine).toBe('recovered');
  });

  it('should map a missing event.message to an empty string', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({
      events: [{ eventId: 'e1', timestamp: 1000 }], // no message field
    });

    const ac = new AbortController();
    const gen = service.streamLogs('minecraft', ac.signal, 0);

    const { value: line } = await gen.next();
    ac.abort();
    await gen.return(undefined);

    expect(line).toBe('');
  });
});

describe('LogsService — Lambda log methods', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    loggerMock.error.mockReset();
    service = makeService(makeConfig());
  });

  it('should resolve the default project name to /aws/lambda/hyveon-watchdog for functionKey "watchdog"', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    await service.getRecentLambdaLogs('watchdog');
    const input = cwMock.commandCalls(DescribeLogStreamsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/lambda/hyveon-watchdog');
  });

  it('should resolve a custom project name to /aws/lambda/acme-health-check for functionKey "health-check"', async () => {
    const deploymentConfig = makeDeploymentConfig('acme');
    service = makeService(makeConfig(), deploymentConfig);
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    await service.getRecentLambdaLogs('health-check');
    const input = cwMock.commandCalls(DescribeLogStreamsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/lambda/acme-health-check');
  });

  it('should return a "no log streams" line when the Lambda log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    const page = await service.getRecentLambdaLogs('followup');
    expect(page.lines.map((l) => l.message)).toEqual(['No log streams found for followup.']);
  });

  it('should return an error line and log via logger.error when the CloudWatch call throws', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));
    const page = await service.getRecentLambdaLogs('interactions');
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]!.message).toMatch(/error fetching logs for interactions/i);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'LogsService.getRecentLambdaLogs: failed to fetch logs',
      expect.objectContaining({ functionKey: 'interactions', error: 'denied' }),
    );
  });

  it('should return an informational line (not an error) and skip logger.error when the Lambda log group does not exist yet', async () => {
    const notFound = Object.assign(new Error('The specified log group does not exist.'), {
      name: 'ResourceNotFoundException',
    });
    cwMock.on(DescribeLogStreamsCommand).rejects(notFound);
    const page = await service.getRecentLambdaLogs('health-check');
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]!.message).not.toMatch(/error fetching logs/i);
    expect(page.lines[0]!.message).toMatch(/no log group/i);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });
});

describe('LogsService.getOlderLambdaLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    loggerMock.warn.mockReset();
    service = makeService(makeConfig());
  });

  it('should fetch older events bounded by endTime from the newest Lambda log stream', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 'stream1' }] });
    cwMock.on(GetLogEventsCommand).resolves({ events: [{ message: 'older', timestamp: 500 }] });

    const page = await service.getOlderLambdaLogs('watchdog', 1000, 10);

    expect(page.lines.map((l) => l.message)).toEqual(['older']);
    expect(page.lines[0]!.timestamp).toBe(500);
    expect(page.atOldest).toBe(false);
    const input = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/lambda/hyveon-watchdog');
    expect(input.endTime).toBe(1000);
  });

  it('should accumulate events across multiple Lambda log streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves(streamsResponse(['stream-new', 'stream-old']));
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-new' })
      .resolves({ events: [{ message: 'from-new', timestamp: 900 }] });
    cwMock
      .on(GetLogEventsCommand, { logStreamName: 'stream-old' })
      .resolves({ events: [{ message: 'from-old', timestamp: 500 }] });

    const page = await service.getOlderLambdaLogs('watchdog', 1000, 10);

    expect(page.lines.map((l) => l.message)).toEqual(['from-old', 'from-new']);
  });

  it('should throw an informational error when the Lambda log group does not exist yet', async () => {
    const notFound = Object.assign(new Error('The specified log group does not exist.'), {
      name: 'ResourceNotFoundException',
    });
    cwMock.on(DescribeLogStreamsCommand).rejects(notFound);

    await expect(service.getOlderLambdaLogs('health-check', 1000)).rejects.toThrow(/no log group/i);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'LogsService.getOlderLambdaLogs: log group does not exist yet',
      expect.objectContaining({ functionKey: 'health-check' }),
    );
  });

  it('should throw when the log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });

    await expect(service.getOlderLambdaLogs('watchdog', 1000)).rejects.toThrow(/no log streams/i);
  });
});

describe('LogsService.getNewerLambdaLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    loggerMock.warn.mockReset();
    service = makeService(makeConfig());
  });

  it('should fetch newer events bounded by startTime for the resolved Lambda log group', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [{ logStreamName: 'stream1' }] });
    cwMock.on(GetLogEventsCommand).resolves({ events: [{ message: 'newer', timestamp: 1200 }] });

    const page = await service.getNewerLambdaLogs('watchdog', 1000, 10);

    expect(page.lines.map((l) => l.message)).toEqual(['newer']);
    expect(page.lines[page.lines.length - 1]!.timestamp).toBe(1200);
    const input = cwMock.commandCalls(GetLogEventsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/lambda/hyveon-watchdog');
    expect(input.startTime).toBe(1000);
    expect(input.startFromHead).toBe(true);
  });

  it('should throw an informational error when the Lambda log group does not exist yet', async () => {
    const notFound = Object.assign(new Error('The specified log group does not exist.'), {
      name: 'ResourceNotFoundException',
    });
    cwMock.on(DescribeLogStreamsCommand).rejects(notFound);

    await expect(service.getNewerLambdaLogs('health-check', 1000)).rejects.toThrow(/no log group/i);
  });

  it('should throw when the log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });

    await expect(service.getNewerLambdaLogs('watchdog', 1000)).rejects.toThrow(/no log streams/i);
  });
});

describe('LogsService.streamLambdaLogs', () => {
  /** Service under test, freshly constructed per test. */
  let service: LogsService;

  beforeEach(() => {
    cwMock.reset();
    loggerMock.debug.mockReset();
    service = makeService(makeConfig());
  });

  it('should yield new log lines for the resolved Lambda log group without duplicating events', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'first' }] })
      .resolves({
        events: [
          { eventId: 'e1', timestamp: 1000, message: 'first' }, // already seen
          { eventId: 'e2', timestamp: 2000, message: 'second' }, // new
        ],
      });
    const ac = new AbortController();
    const gen = service.streamLambdaLogs('dns-updater', ac.signal, 0);
    const { value: l1 } = await gen.next();
    const { value: l2 } = await gen.next();
    ac.abort();
    await gen.return(undefined);
    expect(l1).toBe('first');
    expect(l2).toBe('second');
    expect(cwMock.commandCalls(FilterLogEventsCommand)[0]!.args[0].input.logGroupName).toBe('/aws/lambda/hyveon-dns-updater');
  });

  it('should exit cleanly with no further FilterLogEvents calls once the signal is aborted', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({ events: [] });
    const ac = new AbortController();
    ac.abort();
    const lines: string[] = [];
    for await (const line of service.streamLambdaLogs('watchdog', ac.signal, 0)) lines.push(line);
    expect(lines).toEqual([]);
    expect(cwMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });

  it('should yield a single informational message and stop polling when the Lambda log group does not exist yet', async () => {
    const notFound = Object.assign(new Error('The specified log group does not exist.'), {
      name: 'ResourceNotFoundException',
    });
    cwMock.on(FilterLogEventsCommand).rejects(notFound);
    const ac = new AbortController();
    const lines: string[] = [];
    for await (const line of service.streamLambdaLogs('health-check', ac.signal, 0)) lines.push(line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\[stream error\]/);
    expect(lines[0]).toMatch(/no log group/i);
    expect(cwMock.commandCalls(FilterLogEventsCommand)).toHaveLength(1);
  });
});
