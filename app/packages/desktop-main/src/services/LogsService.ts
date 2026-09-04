import { Inject, Injectable } from '@nestjs/common';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { CloudProvider, LambdaFunctionKey, LogChunk } from '@hyveon/shared';
import { DEPLOYMENT_CONFIG_DEFAULTS, errMessage } from '@hyveon/shared';
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
 * One CloudWatch log event line as returned by any of {@link LogsService}'s
 * paging methods — carries its own timestamp and identity so a caller (the
 * `useLogTail` renderer hook) can always derive its next backward/forward
 * paging boundary from the actual current boundary element of whatever
 * window it has loaded, instead of trusting a separately-tracked scalar that
 * can go stale once client-side eviction happens (see design.md's
 * scroll-backfill forward-cursor fix for the bug this replaced).
 */
export interface LogEventLine {
  /** The log line's text. */
  message: string;
  /** CloudWatch event timestamp, epoch ms. */
  timestamp: number;
  /**
   * `${timestamp}:${message}` identity, synthesized because
   * `GetLogEventsCommand`'s `OutputLogEvent` carries no real `eventId`
   * (unlike `FilterLogEventsCommand`'s `FilteredLogEvent`) — needed by
   * forward-paging callers doing boundary-event exclusion (see
   * {@link fetchAcrossStreams}'s `excludeEventIds` handling).
   */
  eventId: string;
}

/**
 * Result of {@link LogsService.getRecentLogs} / {@link LogsService.getRecentLambdaLogs}
 * — a snapshot of the newest lines in a log group. The oldest line's
 * timestamp (`lines[0]?.timestamp`) seeds a subsequent
 * {@link LogsService.getOlderLogs} call without re-fetching (and
 * duplicating) lines already in this snapshot.
 */
export interface RecentLogsPage {
  /** The fetched snapshot's lines, oldest first. */
  lines: LogEventLine[];
}

/**
 * Result of a backward-paging fetch ({@link LogsService.getOlderLogs} /
 * {@link LogsService.getOlderLambdaLogs}) — one page of CloudWatch events
 * strictly older than the caller-supplied boundary. The oldest line's
 * timestamp (`lines[0]?.timestamp`) seeds the *next* backward call.
 */
export interface OlderLogsPage {
  /** The fetched page's lines, oldest first. */
  lines: LogEventLine[];
  /**
   * `true` only once every stream in the log group has been scanned (i.e.
   * {@link fetchAcrossStreams}'s stream-enumeration cap, {@link MAX_STREAMS_SCANNED},
   * was not hit) and the accumulated result is still empty. When the scan
   * cap was hit before exhausting every stream, this is `false` even on an
   * empty page — see {@link fetchAcrossStreams}'s TSDoc for why a bounded
   * scan can't safely claim "nothing older exists."
   */
  atOldest: boolean;
}

/**
 * Result of a forward-paging fetch ({@link LogsService.getNewerLogs} /
 * {@link LogsService.getNewerLambdaLogs}) — one page of CloudWatch events
 * strictly newer than the caller-supplied boundary. The forward-flavored
 * mirror of {@link OlderLogsPage}. The newest line's timestamp
 * (`lines[lines.length - 1]?.timestamp`) seeds the *next* forward call, and
 * every line sharing that exact timestamp's `eventId` seeds that call's
 * `excludeEventIds` — both now derivable by the caller straight off `lines`
 * rather than carried as separate scalar fields.
 */
export interface NewerLogsPage {
  /** The fetched page's lines, oldest first. */
  lines: LogEventLine[];
  /**
   * `true` when this page came back full (accumulated at least `limit`
   * events before trimming) — there could be more events between the last
   * returned event and now, so the caller should keep paging forward.
   * `false` when every relevant stream was scanned and fewer than `limit`
   * events were found, meaning the caller has caught up to the present.
   */
  hasMore: boolean;
}

/** One CloudWatch log event accumulated by {@link LogsService.fetchAcrossStreams}, before trimming to the requested page size. */
interface AccumulatedEvent {
  message: string;
  timestamp: number;
  /** CloudWatch's own event identity — synthesized from timestamp+message when CloudWatch omits it, matching {@link streamLambdaLogs}'s existing dedup fallback. */
  eventId: string;
}

/**
 * Wraps a synthesized informational/error message (no real CloudWatch event
 * behind it — e.g. "no log streams found") in {@link LogEventLine} shape so
 * every `*LogsPage`/`RecentLogsPage` return value can stay uniformly
 * `LogEventLine[]`. Stamped with the current time as its `timestamp` since
 * there is no real CloudWatch timestamp to use; `eventId` is synthesized the
 * same way {@link fetchAcrossStreams} synthesizes one for a real event, for
 * consistency.
 *
 * @param message - The informational or error text to wrap.
 * @returns A {@link LogEventLine} carrying `message` with a synthesized timestamp/eventId.
 */
function syntheticLine(message: string): LogEventLine {
  const timestamp = Date.now();
  return { message, timestamp, eventId: `${timestamp}:${message}` };
}

/**
 * Hard cap on how many log streams a single backward/forward paging call
 * ({@link LogsService.fetchAcrossStreams}) will scan across
 * `DescribeLogStreamsCommand` pagination, so a log group with an unbounded
 * number of streams (e.g. years of ECS task restarts) can't turn one
 * `getOlder`/`getNewer` call into an unbounded number of CloudWatch requests.
 * This is a deliberate, documented bound, not a silent one — see
 * {@link OlderLogsPage.atOldest}'s doc comment for the user-visible
 * consequence of hitting it.
 */
const MAX_STREAMS_SCANNED = 50;

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
   * Return up to `limit` recent lines (each carrying its own CloudWatch
   * timestamp) from the most recently written log stream in
   * `/ecs/{game}-server`. Errors are folded into a single synthesized
   * {@link LogEventLine} so the caller always renders *something* — failures
   * in the logs tab shouldn't take the rest of the dashboard down.
   *
   * @param game - Game name; resolves to log group `/ecs/{game}-server`.
   * @param limit - Maximum number of recent log lines to return.
   * @returns The recent snapshot — see {@link RecentLogsPage}.
   */
  async getRecentLogs(game: string, limit = 50): Promise<RecentLogsPage> {
    const logGroup = `/ecs/${game}-server`;
    logger.debug('LogsService.getRecentLogs: fetching recent logs', { game, limit, logGroup });
    try {
      return await this.getRecentFromLogGroup(logGroup, limit, game);
    } catch (err) {
      if (err instanceof Error && err.message === `No log streams found for ${game}.`) {
        return { lines: [syntheticLine(err.message)] };
      }
      const message = errMessage(err);
      logger.error('LogsService.getRecentLogs: failed to fetch logs', { game, logGroup, error: message });
      return { lines: [syntheticLine(`Error fetching logs for ${game}: ${String(err)}`)] };
    }
  }

  /**
   * Shared recent-snapshot fetch backing {@link getRecentLogs} and
   * {@link getRecentLambdaLogs}: lists the newest log stream in `logGroup`
   * and returns up to `limit` of its most recent events, oldest first, plus
   * the oldest event's timestamp.
   *
   * @param limit - Maximum number of recent log lines to return.
   * @param entityLabel - Game name or Lambda `functionKey`, used only to
   *   phrase the "no streams" error the same way the pre-dedup game/Lambda
   *   methods each phrased it themselves.
   * @returns The recent snapshot — see {@link RecentLogsPage}.
   * @throws Error — When the log group has no streams, or the CloudWatch call fails.
   */
  private async getRecentFromLogGroup(logGroup: string, limit: number, entityLabel: string): Promise<RecentLogsPage> {
    const streams = await this.getClient().send(
      new DescribeLogStreamsCommand({
        logGroupName: logGroup,
        orderBy: 'LastEventTime',
        descending: true,
        limit: 1,
      }),
    );
    if (!streams.logStreams?.length) {
      throw new Error(`No log streams found for ${entityLabel}.`);
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
    const lines: LogEventLine[] = (events.events ?? [])
      .filter((e): e is typeof e & { timestamp: number } => e.timestamp !== undefined)
      .map((e) => ({ message: e.message ?? '', timestamp: e.timestamp, eventId: `${e.timestamp}:${e.message ?? ''}` }));
    return { lines };
  }

  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp`, paging backward across every log stream in
   * `/ecs/{game}-server` — not just the newest one — for the "load older
   * logs on scroll-up" backfill flow.
   *
   * @remarks
   * CloudWatch Logs starts a new log stream every time an ECS task restarts.
   * Restarting a game server therefore orphans older history in a stream
   * that a single-newest-stream query would never look at — this method
   * scans backward across every stream the log group reports (bounded by
   * {@link MAX_STREAMS_SCANNED}) so that history survives a restart.
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
      return await this.fetchAcrossStreams(logGroup, 'older', beforeTimestamp, limit);
    } catch (err) {
      const message = errMessage(err);
      logger.warn('LogsService.getOlderLogs: failed to fetch older logs', { game, beforeTimestamp, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly newer than
   * `afterTimestamp`, paging forward across every log stream in
   * `/ecs/{game}-server` — the multi-stream-aware, paged replacement for the
   * old single "fetch everything to now" range fetch, used when the operator
   * scrolls back down through a historical window.
   *
   * @param game - Game name; resolves to log group `/ecs/{game}-server`.
   * @param afterTimestamp - Epoch-ms inclusive lower bound (`GetLogEventsCommand`'s
   *   `startTime` is inclusive) — combined with `excludeEventIds` to return
   *   only events strictly newer than the caller's actual position.
   * @param limit - Maximum number of events to fetch.
   * @param excludeEventIds - `eventId`s already delivered at `afterTimestamp`
   *   by a previous call (the caller derives these from that call's
   *   `lines` — every line whose `timestamp` equals the newest one, mapped
   *   to its `eventId`) — filtered out of this page (as a multiset; see
   *   {@link fetchAcrossStreams}'s `@remarks`) so the inclusive `startTime`
   *   bound doesn't duplicate them.
   * @returns The newer page — see {@link NewerLogsPage}.
   * @throws Error — When the log group has no streams, or the CloudWatch call fails.
   */
  async getNewerLogs(
    game: string,
    afterTimestamp: number,
    limit = 100,
    excludeEventIds: string[] = [],
  ): Promise<NewerLogsPage> {
    const logGroup = `/ecs/${game}-server`;
    logger.debug('LogsService.getNewerLogs: fetching newer logs', { game, afterTimestamp, limit, logGroup });
    try {
      return await this.fetchAcrossStreams(logGroup, 'newer', afterTimestamp, limit, excludeEventIds);
    } catch (err) {
      const message = errMessage(err);
      logger.warn('LogsService.getNewerLogs: failed to fetch newer logs', { game, afterTimestamp, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Shared multi-stream paging loop backing {@link getOlderLogs} /
   * {@link getOlderLambdaLogs} (`direction: 'older'`) and {@link getNewerLogs} /
   * {@link getNewerLambdaLogs} (`direction: 'newer'`).
   *
   * @remarks
   * Lists up to {@link MAX_STREAMS_SCANNED} streams in `logGroup` (newest
   * first), then pages `GetLogEventsCommand` against each in turn,
   * accumulating events until at least `limit` are collected, sorts by
   * timestamp, and trims to the `limit` closest to `boundaryTimestamp` — no
   * unbounded page ever reaches the caller.
   *
   * `'older'` walks streams newest-to-oldest: the events closest to a
   * backward boundary are, by construction, in the newest streams that could
   * contain them. `'newer'` walks the *reverse* — oldest-to-newest — because
   * the events closest to a forward boundary typically sit in whichever
   * stream was active just after it, often an older, since-rotated stream;
   * iterating newest-first for `'newer'` could fill `limit` from the current
   * stream's much-later events and break before ever querying the older
   * stream that actually holds the boundary-adjacent history.
   *
   * `'older'`'s `atOldest` is `true` only once every stream in the group has
   * genuinely been scanned (`DescribeLogStreamsCommand` pagination exhausted
   * without hitting {@link MAX_STREAMS_SCANNED}) and the trimmed result is
   * still empty — a group larger than the scan cap never reports
   * `atOldest: true`, since this scan can't actually confirm it reached the
   * boundary.
   *
   * `excludeEventIds` is filtered as a **multiset** (occurrence-counted), not
   * a `Set`. The synthesized `eventId` (`${timestamp}:${message}`) is a
   * *global* dedupe key, not a per-stream one — two different streams can
   * each hold a genuinely distinct event sharing that exact key (e.g. a
   * repeated static heartbeat line straddling a rotated-stream boundary). A
   * `Set`-based exclusion would treat both as "already delivered" and drop
   * the second, undelivered one. Counting occurrences instead — one count
   * consumed per matching accumulated event — preserves the *count* of real
   * events sharing a key, even though which specific duplicate-content event
   * is "the one already seen" is unknowable (and irrelevant, since same-key
   * events are byte-identical by construction).
   *
   * @param direction - `'older'` pages backward from `boundaryTimestamp`;
   *   `'newer'` pages forward from it.
   * @param boundaryTimestamp - Epoch-ms bound (`beforeTimestamp`, exclusive,
   *   for `'older'`; `afterTimestamp`, inclusive, for `'newer'`).
   * @param limit - Maximum number of events to return.
   * @param excludeEventIds - `'newer'` only — `eventId`s to filter out of
   *   the accumulated result (already delivered by a previous call at this
   *   exact `boundaryTimestamp`). Ignored for `'older'`.
   * @returns An {@link OlderLogsPage}-shaped result for `'older'`, or a
   *   {@link NewerLogsPage}-shaped result for `'newer'`.
   */
  private async fetchAcrossStreams(
    logGroup: string,
    direction: 'older',
    boundaryTimestamp: number,
    limit: number,
  ): Promise<OlderLogsPage>;
  private async fetchAcrossStreams(
    logGroup: string,
    direction: 'newer',
    boundaryTimestamp: number,
    limit: number,
    excludeEventIds: string[],
  ): Promise<NewerLogsPage>;
  private async fetchAcrossStreams(
    logGroup: string,
    direction: 'older' | 'newer',
    boundaryTimestamp: number,
    limit: number,
    excludeEventIds: string[] = [],
  ): Promise<OlderLogsPage | NewerLogsPage> {
    const { streams, exhausted } = await this.listStreams(logGroup);
    if (!streams.length) {
      throw new Error(`No log streams found in ${logGroup}.`);
    }
    // Multiset (occurrence-counted) exclusion — see this method's `@remarks`
    // for why a `Set` is wrong here (Bug 1: cross-stream eventId collisions).
    const excludedCounts = new Map<string, number>();
    for (const id of excludeEventIds) {
      excludedCounts.set(id, (excludedCounts.get(id) ?? 0) + 1);
    }

    const accumulated: AccumulatedEvent[] = [];
    // See this method's `@remarks` for why 'newer' must walk the reverse
    // (oldest-first) order of the newest-first `streams` list.
    const orderedStreams = direction === 'newer' ? [...streams].reverse() : streams;
    for (const stream of orderedStreams) {
      if (accumulated.length >= limit) break;
      const remaining = limit - accumulated.length;
      const events = await this.getClient().send(
        new GetLogEventsCommand(
          direction === 'older'
            ? {
                logGroupName: logGroup,
                logStreamName: stream,
                limit: remaining,
                startFromHead: false,
                endTime: boundaryTimestamp,
              }
            : {
                logGroupName: logGroup,
                logStreamName: stream,
                // Over-fetch by the total excluded count (not just the
                // number of distinct keys) so filtering duplicates back out
                // below still leaves up to `remaining` real events.
                limit: remaining + excludeEventIds.length,
                startFromHead: true,
                startTime: boundaryTimestamp,
              },
        ),
      );
      for (const e of events.events ?? []) {
        if (e.timestamp === undefined) continue;
        // GetLogEventsCommand's OutputLogEvent carries no eventId (unlike
        // FilterLogEventsCommand's FilteredLogEvent) — synthesize one from
        // timestamp+message, matching this file's existing dedup fallback
        // (see streamLambdaLogs/fetchRange's `event.eventId ?? ...` pattern).
        const eventId = `${e.timestamp}:${e.message}`;
        if (direction === 'newer') {
          const remainingExcluded = excludedCounts.get(eventId) ?? 0;
          if (remainingExcluded > 0) {
            excludedCounts.set(eventId, remainingExcluded - 1);
            continue;
          }
        }
        accumulated.push({ message: e.message ?? '', timestamp: e.timestamp, eventId });
      }
    }

    accumulated.sort((a, b) => a.timestamp - b.timestamp);
    const full = accumulated.length >= limit;
    const trimmed = direction === 'older' ? accumulated.slice(-limit) : accumulated.slice(0, limit);
    const lines: LogEventLine[] = trimmed.map((e) => ({ message: e.message, timestamp: e.timestamp, eventId: e.eventId }));

    if (direction === 'older') {
      return {
        lines,
        atOldest: lines.length === 0 && exhausted,
      };
    }
    return {
      lines,
      hasMore: full,
    };
  }

  /**
   * Lists up to {@link MAX_STREAMS_SCANNED} streams in `logGroup`, newest
   * first, paginating `DescribeLogStreamsCommand` via `nextToken` until
   * either the cap is hit or pagination naturally ends.
   *
   * @returns `streams` — the resolved stream names, newest first; `exhausted`
   *   — `true` when pagination ended naturally (every stream in the group
   *   was listed) before the cap was hit, `false` when the cap was hit
   *   first.
   */
  private async listStreams(logGroup: string): Promise<{ streams: string[]; exhausted: boolean }> {
    const streams: string[] = [];
    let nextToken: string | undefined;
    let exhausted = true;
    do {
      const result = await this.getClient().send(
        new DescribeLogStreamsCommand({
          logGroupName: logGroup,
          orderBy: 'LastEventTime',
          descending: true,
          limit: 50,
          nextToken,
        }),
      );
      for (const s of result.logStreams ?? []) {
        if (s.logStreamName) streams.push(s.logStreamName);
        if (streams.length >= MAX_STREAMS_SCANNED) {
          exhausted = !result.nextToken;
          return { streams, exhausted };
        }
      }
      nextToken = result.nextToken;
    } while (nextToken);
    return { streams, exhausted };
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
      const message = errMessage(err);
      logger.warn('LogsService.resolveLambdaLogGroup: falling back to the default project name', { functionKey, error: message });
    }
    return `/aws/lambda/${projectName}-${functionKey}`;
  }

  /**
   * Return up to `limit` recent lines (each carrying its own CloudWatch
   * timestamp), from the most recently written log stream in the resolved
   * Lambda log group. Errors and a missing log group/stream are folded into
   * a single synthesized {@link LogEventLine}, mirroring
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
   * @returns The recent snapshot — see {@link RecentLogsPage}.
   */
  async getRecentLambdaLogs(functionKey: LambdaFunctionKey, limit = 50): Promise<RecentLogsPage> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.getRecentLambdaLogs: fetching recent logs', { functionKey, limit, logGroup });
    try {
      return await this.getRecentFromLogGroup(logGroup, limit, functionKey);
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.warn('LogsService.getRecentLambdaLogs: log group does not exist yet', { functionKey, logGroup });
        return { lines: [syntheticLine(`No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`)] };
      }
      if (err instanceof Error && err.message === `No log streams found for ${functionKey}.`) {
        return { lines: [syntheticLine(err.message)] };
      }
      const message = errMessage(err);
      logger.error('LogsService.getRecentLambdaLogs: failed to fetch logs', { functionKey, logGroup, error: message });
      return { lines: [syntheticLine(`Error fetching logs for ${functionKey}: ${String(err)}`)] };
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp`, paging backward across every log stream in the
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
      return await this.fetchAcrossStreams(logGroup, 'older', beforeTimestamp, limit);
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.warn('LogsService.getOlderLambdaLogs: log group does not exist yet', { functionKey, logGroup });
        throw new Error(`No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`);
      }
      const message = errMessage(err);
      logger.warn('LogsService.getOlderLambdaLogs: failed to fetch older logs', { functionKey, beforeTimestamp, logGroup, error: message });
      throw new Error(message);
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly newer than
   * `afterTimestamp`, paging forward across every log stream in the
   * resolved Lambda log group — mirrors {@link getNewerLogs} exactly, but
   * against a Lambda function's log group.
   *
   * @param functionKey - Which Lambda function's log group to read from.
   * @param afterTimestamp - Epoch-ms inclusive lower bound — see
   *   {@link getNewerLogs}'s matching parameter doc for why.
   * @param limit - Maximum number of events to fetch.
   * @param excludeEventIds - `eventId`s already delivered at `afterTimestamp`
   *   by a previous call — see {@link getNewerLogs}'s matching parameter doc.
   * @returns The newer page — see {@link NewerLogsPage}.
   * @throws Error — When the log group/streams don't exist, or the CloudWatch call fails.
   */
  async getNewerLambdaLogs(
    functionKey: LambdaFunctionKey,
    afterTimestamp: number,
    limit = 100,
    excludeEventIds: string[] = [],
  ): Promise<NewerLogsPage> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.getNewerLambdaLogs: fetching newer logs', { functionKey, afterTimestamp, limit, logGroup });
    try {
      return await this.fetchAcrossStreams(logGroup, 'newer', afterTimestamp, limit, excludeEventIds);
    } catch (err) {
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        logger.warn('LogsService.getNewerLambdaLogs: log group does not exist yet', { functionKey, logGroup });
        throw new Error(`No log group for ${functionKey} yet — it hasn't been provisioned or hasn't logged anything.`);
      }
      const message = errMessage(err);
      logger.warn('LogsService.getNewerLambdaLogs: failed to fetch newer logs', { functionKey, afterTimestamp, logGroup, error: message });
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
        const message = errMessage(err);
        yield `[stream error] ${message}`;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
}
