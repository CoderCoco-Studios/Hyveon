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
      const message = err instanceof Error ? err.message : String(err);
      logger.error('LogsService.getRecentLambdaLogs: failed to fetch logs', { functionKey, logGroup, error: message });
      return [`Error fetching logs for ${functionKey}: ${String(err)}`];
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
        const result = await this.getClient().send(
          new FilterLogEventsCommand({ logGroupName: logGroup, startTime }),
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (signal.aborted) return;
        yield `[stream error] ${message}`;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
}
