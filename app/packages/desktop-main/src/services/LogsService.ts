import { Inject, Injectable } from '@nestjs/common';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { CloudProvider, LambdaFunctionKey, LogChunk } from '@hyveon/shared';
import { DEPLOYMENT_CONFIG_DEFAULTS } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { DeploymentConfigService } from './DeploymentConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from './awsCredentialSource.js';
import { CLOUD_PROVIDER } from '../modules/cloud-provider.tokens.js';

/**
 * Local widening of the cloud-agnostic `CloudProvider` contract's
 * `streamWorkloadLogs` signature to accept the optional `pollInterval`
 * parameter that concrete implementations (e.g. `@hyveon/cloud-aws`'s
 * `AwsCloudProvider`) support, without changing the shared interface itself
 * (which stays intentionally cloud-agnostic and free of polling-cadence
 * concerns other providers may not expose).
 */
type CloudProviderWithPollInterval = CloudProvider & {
  streamWorkloadLogs(
    game: string,
    signal: AbortSignal,
    pollInterval?: number,
  ): AsyncIterable<LogChunk>;
};

/**
 * Result of a backward-paging fetch ({@link LogsService.getOlderLogs} /
 * {@link LogsService.getOlderLambdaLogs}) — one page of CloudWatch events
 * strictly older than the caller-supplied boundary, plus enough state to
 * seed the *next* backward call.
 */
export interface OlderLogsPage {
  /** The fetched page's messages, oldest first. */
  lines: string[];
  /**
   * The CloudWatch event timestamp (epoch ms) of the oldest line in this
   * page — pass this back as the next call's `beforeTimestamp` to keep
   * paging further back. Absent when `lines` is empty.
   */
  oldestTimestamp?: number;
  /**
   * `true` when this page came back empty — CloudWatch's retention window
   * (or the log group/stream itself) has nothing older than the requested
   * boundary. Callers should stop issuing further backward calls once this
   * is `true`.
   */
  atOldest: boolean;
}

/**
 * Result of a forward range fetch ({@link LogsService.getLogsInRange} /
 * {@link LogsService.getLambdaLogsInRange}) — every event in the requested
 * `startTime`/`endTime` window across the log group, chronological order,
 * de-duplicated by `eventId`.
 */
export interface LogsRangePage {
  /** The fetched range's messages, oldest first. */
  lines: string[];
}

/** Hard cap on how many events a single {@link LogsRangePage} fetch will accumulate across paged `FilterLogEvents` calls, so a caller that names an overly wide `[startTime, endTime)` window can't pull an unbounded response into memory. */
const MAX_RANGE_EVENTS = 1000;

/**
 * Fetches recent CloudWatch Logs lines for a game's ECS task so the UI can
 * render a tail. Assumes the Pulumi-provisioned log group naming
 * convention `/ecs/{game}-server`.
 */
@Injectable()
export class LogsService {
  private client: CloudWatchLogsClient | null = null;
  private clientCacheKey: string | null = null;

  constructor(
    private readonly config: ConfigService,
    // Shares the same `CloudProvider` instance bound by `CloudProviderModule`
    // (via the `CLOUD_PROVIDER` token) so `streamLogs` delegates to
    // `CloudProvider.streamWorkloadLogs` instead of duplicating its polling
    // logic. Depending only on the cloud-agnostic `CloudProvider` interface
    // (rather than the concrete `AwsCloudProvider` class) keeps this service
    // swappable to another cloud without a call-site change.
    @Inject(CLOUD_PROVIDER)
    private readonly provider: CloudProviderWithPollInterval,
    private readonly store: ElectronStoreService,
    private readonly deploymentConfig: DeploymentConfigService,
  ) {}

  /**
   * Lazily constructs the CloudWatch Logs client, recreating it whenever the
   * freshly-resolved region or credentials signature differs from what the
   * cached client was built with — see `EcsService.getClient`'s matching doc
   * comment for why both matter.
   */
  private getClient(): CloudWatchLogsClient {
    const region = this.config.getRegion();
    const { credentials, signature } = resolveAwsClientCredentialsWithSignature(this.store);
    const cacheKey = `${region}::${signature}`;
    if (!this.client || this.clientCacheKey !== cacheKey) {
      this.client = new CloudWatchLogsClient({ region, credentials });
      this.clientCacheKey = cacheKey;
    }
    return this.client;
  }

  /**
   * Async generator that yields new log lines as they arrive for `game`.
   * Delegates to the injected `CloudProvider`'s `streamWorkloadLogs` (bound
   * by `CloudProviderModule` via the `CLOUD_PROVIDER` token), which polls
   * `FilterLogEvents` every `pollInterval` ms (de-duplicated by `eventId`,
   * exiting cleanly when `signal` is aborted) — see
   * `AwsCloudProvider.streamWorkloadLogs`'s TSDoc for the full behaviour this
   * preserves for the AWS implementation. Only the `message` of each yielded
   * `LogChunk` is surfaced here, matching this method's pre-existing
   * `AsyncGenerator<string>` contract.
   */
  async *streamLogs(
    game: string,
    signal: AbortSignal,
    pollInterval = 2000,
  ): AsyncGenerator<string> {
    logger.debug('LogsService.streamLogs: starting log stream', { game, pollInterval });
    for await (const chunk of this.provider.streamWorkloadLogs(game, signal, pollInterval)) {
      yield chunk.message;
    }
  }

  /**
   * Return up to `limit` recent messages from the most recently written log
   * stream in `/ecs/{game}-server`. Errors are folded into a single-element
   * array so the caller always renders *something* — failures in the logs
   * tab shouldn't take the rest of the dashboard down.
   */
  async getRecentLogs(game: string, limit = 50): Promise<string[]> {
    const logGroup = `/ecs/${game}-server`;
    logger.debug('LogsService.getRecentLogs: fetching recent logs', { game, limit, logGroup });
    try {
      const streams = await this.getClient().send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 1,
        }),
      );
      if (!streams.logStreams?.length) {
        return [`No log streams found for ${game}.`];
      }
      const streamName = streams.logStreams[0]!.logStreamName!;
      const events = await this.getClient().send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: streamName,
          limit,
          startFromHead: false,
        }),
      );
      return events.events?.map((e) => e.message ?? '') ?? [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('LogsService.getRecentLogs: failed to fetch logs', { game, logGroup, error: message });
      return [`Error fetching logs for ${game}: ${String(err)}`];
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp` from the most recently written log stream in
   * `/ecs/{game}-server`, for the "load older logs on scroll-up" backfill
   * flow. Backward paging is native CloudWatch behaviour — `GetLogEventsCommand`
   * already returns the `limit` most recent events at or before its `endTime`
   * bound when `startFromHead: false` — so this does not hand-roll pagination
   * over `FilterLogEventsCommand` results the way a forward scan would.
   *
   * @param game - Game name; resolves to log group `/ecs/{game}-server`.
   * @param beforeTimestamp - Epoch-ms exclusive upper bound — only events
   *   strictly older than this are returned. Callers seed this from the
   *   oldest currently-loaded line's timestamp (or `Date.now()` on first entry
   *   into historical mode).
   * @param limit - Maximum number of events to fetch.
   * @returns The older page — see {@link OlderLogsPage}.
   * @throws Error — When the log group has no streams, or the CloudWatch call fails.
   */
  async getOlderLogs(game: string, beforeTimestamp: number, limit = 100): Promise<OlderLogsPage> {
    const logGroup = `/ecs/${game}-server`;
    logger.debug('LogsService.getOlderLogs: fetching older logs', { game, beforeTimestamp, limit, logGroup });
    try {
      const streams = await this.getClient().send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 1,
        }),
      );
      if (!streams.logStreams?.length) {
        throw new Error(`No log streams found for ${game}.`);
      }
      const streamName = streams.logStreams[0]!.logStreamName!;
      const events = await this.getClient().send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: streamName,
          limit,
          startFromHead: false,
          endTime: beforeTimestamp,
        }),
      );
      const lines = events.events?.map((e) => e.message ?? '') ?? [];
      const oldestTimestamp = events.events?.[0]?.timestamp;
      return { lines, oldestTimestamp, atOldest: lines.length === 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('LogsService.getOlderLogs: failed to fetch older logs', { game, beforeTimestamp, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Returns every CloudWatch event in `[startTime, endTime)` across
   * `/ecs/{game}-server` (all log streams, chronological order), for the
   * forward gap-fill flow that runs when the operator scrolls back down past
   * the bottom of a historical window. Pages through `FilterLogEventsCommand`
   * itself, de-duplicating by `eventId` the same way {@link streamLogs}'s
   * underlying poll loop does, and stops early once {@link MAX_RANGE_EVENTS}
   * is reached so a wide range can't return an unbounded response.
   *
   * @param game - Game name; resolves to log group `/ecs/{game}-server`.
   * @param startTime - Epoch-ms inclusive lower bound.
   * @param endTime - Epoch-ms exclusive upper bound.
   * @returns The filled range — see {@link LogsRangePage}.
   * @throws Error — When the CloudWatch call fails.
   */
  async getLogsInRange(game: string, startTime: number, endTime: number): Promise<LogsRangePage> {
    const logGroup = `/ecs/${game}-server`;
    logger.debug('LogsService.getLogsInRange: fetching log range', { game, startTime, endTime, logGroup });
    try {
      const lines = await this.fetchRange(logGroup, startTime, endTime);
      return { lines };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('LogsService.getLogsInRange: failed to fetch log range', { game, startTime, endTime, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Shared forward-range paging loop backing {@link getLogsInRange} and
   * {@link getLambdaLogsInRange} — pages `FilterLogEventsCommand` across the
   * whole log group between `startTime`/`endTime`, de-duplicating by
   * `eventId`, capped at {@link MAX_RANGE_EVENTS}.
   *
   * @param logGroup - Resolved CloudWatch log group name.
   * @param startTime - Epoch-ms inclusive lower bound.
   * @param endTime - Epoch-ms exclusive upper bound.
   * @returns The messages found in range, chronological order.
   */
  private async fetchRange(logGroup: string, startTime: number, endTime: number): Promise<string[]> {
    const seen = new Set<string>();
    const lines: string[] = [];
    let nextToken: string | undefined;
    do {
      const result = await this.getClient().send(
        new FilterLogEventsCommand({ logGroupName: logGroup, startTime, endTime, nextToken }),
      );
      for (const event of result.events ?? []) {
        const id = event.eventId ?? `${event.timestamp}:${event.message}`;
        if (seen.has(id)) continue;
        seen.add(id);
        lines.push(event.message ?? '');
        if (lines.length >= MAX_RANGE_EVENTS) return lines;
      }
      nextToken = result.nextToken;
    } while (nextToken);
    return lines;
  }

  /**
   * Resolves the CloudWatch log group for one of the app's 5 Lambda
   * functions, using the operator's configured `projectName` (falling back
   * to {@link DEPLOYMENT_CONFIG_DEFAULTS}'s project name on any read
   * failure, matching {@link CloudHealthService.getProjectName}'s
   * fallback rationale).
   *
   * @param functionKey - Which Lambda function's log group to resolve.
   * @returns The resolved log group name, e.g. `/aws/lambda/hyveon-watchdog`.
   */
  private async resolveLambdaLogGroup(functionKey: LambdaFunctionKey): Promise<string> {
    let projectName = DEPLOYMENT_CONFIG_DEFAULTS.projectName;
    try {
      const { settings } = await this.deploymentConfig.getTopLevelSettings();
      projectName = settings.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('LogsService.resolveLambdaLogGroup: falling back to the default project name', { functionKey, error: message });
    }
    return `/aws/lambda/${projectName}-${functionKey}`;
  }

  /**
   * Return up to `limit` recent messages from the most recently written log
   * stream in the resolved Lambda log group. Errors and a missing log
   * group/stream are folded into a single-element array, mirroring
   * {@link getRecentLogs}'s no-throw contract.
   *
   * A `ResourceNotFoundException` (the log group itself doesn't exist yet)
   * is an expected configuration state rather than a failure — it's how a
   * conditionally-provisioned function like `health-check` looks before any
   * game in the deployment declares a health check (see
   * `app/packages/infra/src/lambdas.ts`) — so it's reported as an
   * informational line without a `logger.error` call.
   *
   * @param functionKey - Which Lambda function's log group to read from.
   * @param limit - Maximum number of recent log lines to return.
   * @returns The resolved log lines, or a single-element diagnostic array on failure.
   */
  async getRecentLambdaLogs(functionKey: LambdaFunctionKey, limit = 50): Promise<string[]> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.getRecentLambdaLogs: fetching recent logs', { functionKey, limit, logGroup });
    try {
      const streams = await this.getClient().send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 1,
        }),
      );
      if (!streams.logStreams?.length) {
        return [`No log streams found for ${functionKey}.`];
      }
      const streamName = streams.logStreams[0]!.logStreamName!;
      const events = await this.getClient().send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: streamName,
          limit,
          startFromHead: false,
        }),
      );
      return events.events?.map((e) => e.message ?? '') ?? [];
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.warn('LogsService.getRecentLambdaLogs: log group does not exist yet', { functionKey, logGroup });
        return [`No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`];
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('LogsService.getRecentLambdaLogs: failed to fetch logs', { functionKey, logGroup, error: message });
      return [`Error fetching logs for ${functionKey}: ${String(err)}`];
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp` from the most recently written log stream in the
   * resolved Lambda log group — mirrors {@link getOlderLogs} exactly, but
   * against a Lambda function's log group.
   *
   * @param functionKey - Which Lambda function's log group to read from.
   * @param beforeTimestamp - Epoch-ms exclusive upper bound.
   * @param limit - Maximum number of events to fetch.
   * @returns The older page — see {@link OlderLogsPage}.
   * @throws Error — When the log group/streams don't exist, or the CloudWatch call fails.
   */
  async getOlderLambdaLogs(functionKey: LambdaFunctionKey, beforeTimestamp: number, limit = 100): Promise<OlderLogsPage> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.getOlderLambdaLogs: fetching older logs', { functionKey, beforeTimestamp, limit, logGroup });
    try {
      const streams = await this.getClient().send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 1,
        }),
      );
      if (!streams.logStreams?.length) {
        throw new Error(`No log streams found for ${functionKey}.`);
      }
      const streamName = streams.logStreams[0]!.logStreamName!;
      const events = await this.getClient().send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName: streamName,
          limit,
          startFromHead: false,
          endTime: beforeTimestamp,
        }),
      );
      const lines = events.events?.map((e) => e.message ?? '') ?? [];
      const oldestTimestamp = events.events?.[0]?.timestamp;
      return { lines, oldestTimestamp, atOldest: lines.length === 0 };
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.warn('LogsService.getOlderLambdaLogs: log group does not exist yet', { functionKey, logGroup });
        throw new Error(`No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('LogsService.getOlderLambdaLogs: failed to fetch older logs', { functionKey, beforeTimestamp, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Returns every CloudWatch event in `[startTime, endTime)` across the
   * resolved Lambda log group — mirrors {@link getLogsInRange} exactly, but
   * against a Lambda function's log group.
   *
   * @param functionKey - Which Lambda function's log group to read from.
   * @param startTime - Epoch-ms inclusive lower bound.
   * @param endTime - Epoch-ms exclusive upper bound.
   * @returns The filled range — see {@link LogsRangePage}.
   * @throws Error — When the CloudWatch call fails.
   */
  async getLambdaLogsInRange(functionKey: LambdaFunctionKey, startTime: number, endTime: number): Promise<LogsRangePage> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.getLambdaLogsInRange: fetching log range', { functionKey, startTime, endTime, logGroup });
    try {
      const lines = await this.fetchRange(logGroup, startTime, endTime);
      return { lines };
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.warn('LogsService.getLambdaLogsInRange: log group does not exist yet', { functionKey, logGroup });
        throw new Error(`No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('LogsService.getLambdaLogsInRange: failed to fetch log range', { functionKey, startTime, endTime, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Async generator that yields new log lines as they arrive for the resolved
   * Lambda log group. Polls `FilterLogEvents` every `pollInterval` ms,
   * de-duplicating by `eventId` and exiting cleanly when `signal` is aborted —
   * the same poll-loop shape `AwsCloudProvider.streamWorkloadLogs` uses for
   * game logs (see design.md D1 for why this duplicates rather than shares
   * that implementation). A poll failure yields a `[stream error]`-prefixed
   * sentinel line and the loop continues, matching `streamLogs`'s resilience
   * to a transient CloudWatch hiccup.
   *
   * A `ResourceNotFoundException` is handled separately: it means the log
   * group doesn't exist at all (e.g. `health-check` before any game in the
   * deployment declares a health check — see
   * `app/packages/infra/src/lambdas.ts`), which won't spontaneously resolve
   * while the operator is looking at the page. Rather than repeat a
   * `[stream error]` line every `pollInterval` up to the viewer's line cap,
   * this yields one informational line and returns, ending the generator.
   *
   * @param functionKey - Which Lambda function's log group to tail.
   * @param signal - Aborting this signal stops the poll loop and ends the generator.
   * @param pollInterval - Milliseconds to wait between successive `FilterLogEvents` polls.
   */
  async *streamLambdaLogs(
    functionKey: LambdaFunctionKey,
    signal: AbortSignal,
    pollInterval = 2000,
  ): AsyncGenerator<string> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.streamLambdaLogs: starting log stream', { functionKey, logGroup, pollInterval });
    const seen = new Set<string>();
    let startTime: number | undefined;
    while (!signal.aborted) {
      try {
        let nextToken: string | undefined;
        do {
          const result = await this.getClient().send(
            new FilterLogEventsCommand({ logGroupName: logGroup, startTime, nextToken }),
          );
          for (const event of result.events ?? []) {
            const id = event.eventId ?? `${event.timestamp}:${event.message}`;
            if (seen.has(id)) continue;
            seen.add(id);
            if (event.timestamp !== undefined) {
              startTime = startTime === undefined ? event.timestamp : Math.max(startTime, event.timestamp);
            }
            if (signal.aborted) return;
            yield event.message ?? '';
          }
          nextToken = result.nextToken;
        } while (nextToken && !signal.aborted);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof Error && err.name === 'ResourceNotFoundException') {
          logger.warn('LogsService.streamLambdaLogs: log group does not exist yet, stopping poll', { functionKey, logGroup });
          yield `No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        yield `[stream error] ${message}`;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
}
