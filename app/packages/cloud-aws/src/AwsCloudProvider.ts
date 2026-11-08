import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
  type ECSClientConfig,
} from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import type {
  CloudProvider,
  LogChunk,
  StartOpts,
  WorkloadHandle,
  WorkloadStatus,
} from '@hyveon/shared';
import {
  LOG_TAIL_LOOKBACK_MS,
  getTaskEniId,
  noLogGroupMessage,
  resolveEniPublicIp,
  sleepInterruptible,
} from '@hyveon/shared';
import { startInProgressMessage, startWithLease } from '@hyveon/shared/aws/startLease';
import { createCachedAwsClient } from './cachedClient.js';

/**
/**
 * Thrown by {@link AwsCloudProvider.startWorkload} / {@link
 * AwsCloudProvider.stopWorkload} for expected precondition refusals — a task
 * is already running, nothing is running to stop, or the infra program
 * hasn't been applied yet — as opposed to a genuine AWS/SDK failure. Callers (e.g.
 * `EcsService`) can `instanceof`-check for this type to route these refusals
 * to `warn`-level logging instead of `error`, without relying on message
 * string matching that would silently break if the message wording changes.
 */
export class WorkloadGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkloadGuardError';
  }
}

/**
 * Thrown by {@link AwsCloudProvider.startWorkload} when ECS's `RunTask`
 * response comes back with zero launched tasks and an explicit failure
 * reason (e.g. `CAPACITY`, `RESOURCE:FARGATE`) — a genuine AWS-side launch
 * failure, as opposed to a precondition refusal ({@link WorkloadGuardError}).
 * Kept as a distinct, separately-`instanceof`-checkable type instead of
 * reusing `WorkloadGuardError` so callers (e.g. `EcsService`) can still
 * surface `err.message` unprefixed — message strings are part of the contract `EcsService`
 * surfaces to the operator, so this class must keep returning the same `StartResult.message`
 * text — while continuing to log this at `error` level (not `warn`), since
 * this is not an expected/normal operator situation the way a guard refusal
 * is.
 */
export class WorkloadLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkloadLaunchError';
  }
}

/**
 * Narrow, Pulumi-stack-outputs-shaped subset of configuration
 * {@link AwsCloudProvider} needs to drive ECS + EC2 for the workload methods.
 * Kept local to this package (not imported from desktop-main's
 * `ConfigService`) so `@hyveon/cloud-aws` has zero dependency on the desktop
 * app — callers are responsible for resolving these fields from wherever
 * they live (a deployed Pulumi stack's outputs today) and handing them to
 * {@link AwsCloudProvider} via its constructor.
 */
export interface AwsCloudProviderConfig {
  /** AWS region the ECS/EC2 clients should target. */
  region: string;
  /**
   * Credentials the ECS/EC2/CloudWatch Logs clients should authenticate
   * with. Omitting it leaves the SDK's own default provider chain in
   * effect, which resolves nothing in a GUI-launched Electron process — see
   * `desktop-main`'s `resolveAwsClientCredentials`, the real caller's
   * source for this field.
   */
  credentials?: ECSClientConfig['credentials'];
  /**
   * A cheap, comparable fingerprint of `credentials`, changing whenever the
   * underlying AWS profile selection/pasted key/credential kind changes —
   * see `desktop-main`'s `resolveAwsClientCredentialsWithSignature`, the real
   * caller's source for this field. `credentials` itself can't be compared
   * to detect a rotation: a `fromIni()`-backed profile allocates a new
   * provider function on every resolve, so `!==` always looks "changed"
   * even when nothing moved. Lazily-cached clients ({@link getEcsClient} and
   * friends) key on this alongside `region` so a same-region credentials
   * rotation still rebuilds the client instead of staying pinned to a stale
   * key indefinitely.
   */
  credentialsSignature?: string;
  /** Name of the ECS cluster game-server tasks run in. */
  ecsClusterName: string;
  /** Comma-separated subnet IDs used for the Fargate network configuration. */
  subnetIds: string;
  /** Security group ID attached to game-server tasks. */
  securityGroupId: string;
  /** Discord single-table name (`outputs.discordTableName`) hosting the cross-process start lease. */
  discordTableName: string;
  /** Root domain used to build a game's public hostname (`{game}.{domain}`). */
  domainName?: string;
}

/**
 * Minimal logging seam {@link AwsCloudProvider} accepts so swallowed
 * ListTasks/DescribeTasks/DescribeNetworkInterfaces failures remain
 * diagnosable without pulling `@hyveon/desktop-main`'s Winston logger (or any
 * other logging dependency) into this package. Callers wire in whatever
 * logger they already have (e.g. by adapting Winston's `.error`, as
 * `EcsService.ts`'s `awsCloudProviderLogger` and `AwsModule`'s `useFactory`
 * provider both do) — the previous `EcsService.findRunningTask` /
 * `Ec2Service.getPublicIp` this class replaces both called `logger.error` on
 * these same failures, so omitting this seam would be a regression, not a
 * return to prior behaviour; it exists precisely so callers preserve that
 * logging instead of losing it.
 */
export interface AwsCloudProviderLogger {
  /**
   * Logs a caught error at error level.
   *
   * @param message - Human-readable description of what failed.
   * @param err - The caught error/value.
   */
  error(message: string, err: unknown): void;

  /**
   * Logs an expected, recoverable condition at warn level.
   *
   * @param message - Human-readable description of the condition.
   * @param detail - Identifiers for the condition (never secret values).
   */
  warn?(message: string, detail?: unknown): void;
}

/** Ceiling, in milliseconds, on the poll delay while a game's log group does not exist yet. */
const MAX_NOT_FOUND_BACKOFF_MS = 30_000;

// @spec RT-TASK-COST-002
/**
 * AWS implementation of the cloud-agnostic {@link CloudProvider} contract.
 *
 * `startWorkload` / `stopWorkload` / `getWorkloadStatus` reproduce the
 * behaviour of the management app's `EcsService` (task-definition lookup via
 * the `{game}-server` family, ENI-based public IP resolution via EC2, and
 * per-game "already running" / "not running" gating) without depending on
 * `@hyveon/desktop-main` — configuration is supplied via the constructor's
 * `getConfig` callback instead of `ConfigService`.
 *
 * `streamWorkloadLogs` reproduces `LogsService.streamLogs`'s CloudWatch Logs
 * polling behaviour (see the method for details). The
 * app makes no AWS Cost Explorer API calls, ever.
 */
export class AwsCloudProvider implements CloudProvider {
  private readonly getCachedEcsClient = createCachedAwsClient(
    (config: {
      region: string;
      credentials: AwsCloudProviderConfig['credentials'];
      credentialsSignature: AwsCloudProviderConfig['credentialsSignature'];
    }) => new ECSClient({ region: config.region, credentials: config.credentials }),
  );
  private readonly getCachedEc2Client = createCachedAwsClient(
    (config: {
      region: string;
      credentials: AwsCloudProviderConfig['credentials'];
      credentialsSignature: AwsCloudProviderConfig['credentialsSignature'];
    }) => new EC2Client({ region: config.region, credentials: config.credentials }),
  );
  private readonly getCachedLogsClient = createCachedAwsClient(
    (config: {
      region: string;
      credentials: AwsCloudProviderConfig['credentials'];
      credentialsSignature: AwsCloudProviderConfig['credentialsSignature'];
    }) => new CloudWatchLogsClient({ region: config.region, credentials: config.credentials }),
  );

  private readonly getCachedDocClient = createCachedAwsClient(
    (config: {
      region: string;
      credentials: AwsCloudProviderConfig['credentials'];
      credentialsSignature: AwsCloudProviderConfig['credentialsSignature'];
    }) => DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region, credentials: config.credentials })),
  );

  /**
   * Per-game tail of the in-flight critical-section chain, used by {@link
   * withGameLock} to serialize `startWorkload`/`stopWorkload` calls for the
   * same game. Without this, two overlapping requests for the same game
   * could both pass the "already running" / "not currently running" guard
   * check before either call's `RunTask`/`StopTask` lands, letting duplicate
   * tasks start or a stop race a start.
   */
  private readonly gameLocks = new Map<string, Promise<unknown>>();

  /**
   * Resolves stack-derived configuration on every call — see {@link AwsAuditLogStore}'s
   * constructor doc for why (rename-safety pattern; a `Promise` return costs nothing since every
   * real call site is already async).
   *
   * @param getConfig - Resolves the current configuration; returns `null`/`undefined` before
   *   anything has been deployed. Optional so the class remains constructible with no arguments.
   * @param logger - Optional sink for errors swallowed by `findRunningTask`/`getPublicIp` so
   *   operators can diagnose ECS/EC2 SDK failures instead of them masquerading as "stopped"/"no IP".
   */
  constructor(
    private readonly getConfig?: () => (
      | AwsCloudProviderConfig
      | null
      | undefined
      | Promise<AwsCloudProviderConfig | null | undefined>
    ),
    private readonly logger?: AwsCloudProviderLogger,
  ) {}

  /**
   * Lazily constructs the ECS client, recreating it whenever `region` or
   * `credentialsSignature` differs from what the cached client was built
   * with — otherwise a stale client (e.g. left over from a Pulumi apply run
   * through `PulumiService` that changed regions, or from an AWS credentials
   * rotation) would keep targeting the old region/credentials indefinitely.
   */
  private getEcsClient(
    region: string,
    credentials: AwsCloudProviderConfig['credentials'],
    credentialsSignature: AwsCloudProviderConfig['credentialsSignature'],
  ): ECSClient {
    return this.getCachedEcsClient({ region, credentials, credentialsSignature });
  }

  /**
   * Lazily constructs the EC2 client, recreating it whenever `region` or
   * `credentialsSignature` differs from what the cached client was built
   * with — see {@link getEcsClient} for why this matters.
   */
  private getEc2Client(
    region: string,
    credentials: AwsCloudProviderConfig['credentials'],
    credentialsSignature: AwsCloudProviderConfig['credentialsSignature'],
  ): EC2Client {
    return this.getCachedEc2Client({ region, credentials, credentialsSignature });
  }

  /**
   * Lazily constructs the CloudWatch Logs client, recreating it whenever
   * `region` or `credentialsSignature` differs from what the cached client
   * was built with — see {@link getEcsClient} for why this matters.
   */
  private getLogsClient(
    region: string,
    credentials: AwsCloudProviderConfig['credentials'],
    credentialsSignature: AwsCloudProviderConfig['credentialsSignature'],
  ): CloudWatchLogsClient {
    return this.getCachedLogsClient({ region, credentials, credentialsSignature });
  }

  // @spec RT-TASK-LAUNCH-009
  /**
   * Serializes calls for the same `game` so overlapping `startWorkload`/
   * `stopWorkload` requests can't both pass their guard check before either
   * one's AWS call lands. Chains `fn` onto the previous in-flight promise
   * for `game` (if any), so calls for the same game run one at a time in
   * call order, while calls for *different* games remain fully concurrent.
   * A rejected/thrown `fn` still unblocks the next queued call for that
   * game — only the caller that triggered it observes the rejection.
   */
  private async withGameLock<T>(game: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.gameLocks.get(game) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.gameLocks.set(
      game,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * Locate the current non-stopped task for a game, keyed by the `{game}-server`
   * task-definition family the infra program provisions. `ListTasks` is filtered to
   * `desiredStatus: RUNNING` and STOPPED/DEPROVISIONING tasks are filtered
   * out of the describe result — leaving the single active task, if any.
   *
   * One page is provably enough: `startWorkload`'s guard keeps at most one task per
   * `{game}-server` family, so a page can never need a second fetch. `ListTasks` is only
   * eventually consistent, though — it's the in-process `withGameLock`, not this read, that
   * actually prevents duplicate starts.
   */
  private async findRunningTask(
    region: string,
    credentials: AwsCloudProviderConfig['credentials'],
    credentialsSignature: AwsCloudProviderConfig['credentialsSignature'],
    cluster: string,
    game: string,
  ): Promise<Task | null> {
    try {
      return await this.findRunningTaskOrThrow(region, credentials, credentialsSignature, cluster, game);
    } catch (err) {
      this.logger?.error('Failed to find running task', err);
      return null;
    }
  }

  /**
   * Same lookup as {@link findRunningTask} but SDK errors propagate, for the start guard that must fail closed
   * (RT-TASK-LAUNCH-010) instead of mistaking an outage for "stopped".
   */
  private async findRunningTaskOrThrow(
    region: string,
    credentials: AwsCloudProviderConfig['credentials'],
    credentialsSignature: AwsCloudProviderConfig['credentialsSignature'],
    cluster: string,
    game: string,
  ): Promise<Task | null> {
    const client = this.getEcsClient(region, credentials, credentialsSignature);
    const listResp = await client.send(
      new ListTasksCommand({ cluster, family: `${game}-server`, desiredStatus: 'RUNNING' }),
    );
    if (!listResp.taskArns?.length) return null;

    const descResp = await client.send(new DescribeTasksCommand({ cluster, tasks: listResp.taskArns }));
    return descResp.tasks?.find((t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING') ?? null;
  }

  /**
   * Resolve the public IPv4 of a task's ENI. Returns `null` when the ENI has
   * no public association (e.g. `assignPublicIp: DISABLED`) or the describe
   * call fails — callers then show "starting" / "no IP" instead of an error.
   */
  private async getPublicIp(
    region: string,
    credentials: AwsCloudProviderConfig['credentials'],
    credentialsSignature: AwsCloudProviderConfig['credentialsSignature'],
    eniId: string,
  ): Promise<string | null> {
    try {
      const client = this.getEc2Client(region, credentials, credentialsSignature);
      return await resolveEniPublicIp(
        (id) => client.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [id] })),
        eniId,
      );
    } catch (err) {
      this.logger?.error('Failed to resolve public IP', err);
      return null;
    }
  }

  // @spec RT-TASK-LAUNCH-001, RT-TASK-LAUNCH-002, RT-TASK-LAUNCH-003, RT-TASK-LAUNCH-005, RT-TASK-LAUNCH-008
  // @spec RT-TASK-LAUNCH-010, RT-TASK-LAUNCH-015, RT-TASK-LAUNCH-016
  // @spec RT-TASK-LAUNCH-011
  /**
   * Launches a game workload on AWS.
   *
   * Refuses to start a second task when one is already running (ECS would
   * happily run duplicates otherwise). Message strings are part of the contract `EcsService`
   * surfaces to the operator — changing them changes the UI text. The DNS record is created
   * asynchronously by the update-dns Lambda when the task reaches RUNNING.
   *
   * @param game - The game identifier to start.
   * @param _opts - Provider-specific launch options (currently unused).
   * @returns A handle whose `workloadId` is the launched task's ARN.
   */
  async startWorkload(game: string, _opts: StartOpts): Promise<WorkloadHandle> {
    const config = (await this.getConfig?.()) ?? null;
    if (!config) throw new WorkloadGuardError('Infrastructure is not deployed. Run Apply on the IaC page first.');

    const { region, credentials, credentialsSignature, ecsClusterName: cluster, subnetIds, securityGroupId: sg } =
      config;
    const subnets = subnetIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!config.discordTableName) {
      throw new WorkloadGuardError('Infrastructure is out of date (no start-lease table). Run Apply on the IaC page first.');
    }
    const doc = this.getCachedDocClient({ region, credentials, credentialsSignature });

    return this.withGameLock(game, async () => {
      const outcome = await startWithLease<string>({
        put: (input) => doc.send(new PutCommand(input)),
        tableName: config.discordTableName,
        game,
        findRunning: async () =>
          (await this.findRunningTaskOrThrow(region, credentials, credentialsSignature, cluster, game)) !== null,
        launch: async (clientToken) => {
          // Deliberately no try/catch here: RunTask failures (including non-`Error`
          // throws from the SDK) propagate to the caller unchanged, so
          // `EcsService`'s `describeError`'s `String(err)` fallback renders
          // identically to the pre-migration `EcsService.start` (a raw string
          // throw must surface unprefixed, not wrapped as `'Error: <string>'`).
          const resp = await this.getEcsClient(region, credentials, credentialsSignature).send(
            new RunTaskCommand({
              cluster,
              taskDefinition: `${game}-server`,
              count: 1,
              launchType: 'FARGATE',
              clientToken,
              networkConfiguration: {
                awsvpcConfiguration: { subnets, securityGroups: [sg], assignPublicIp: 'ENABLED' },
              },
              propagateTags: 'TASK_DEFINITION',
            }),
          );
          if (resp.tasks?.length) return { launched: true, value: resp.tasks[0]!.taskArn! };
          const reason = resp.failures?.[0]?.reason ?? 'unknown';
          throw new WorkloadLaunchError(`Failed to start ${game}: ${reason}`);
        },
      });
      if (outcome.status === 'in-progress') throw new WorkloadGuardError(startInProgressMessage(game));
      if (outcome.status === 'already-running') throw new WorkloadGuardError(`${game} is already running.`);
      return { workloadId: outcome.value };
    });
  }

  // @spec RT-TASK-LAUNCH-006, RT-TASK-LAUNCH-007, RT-TASK-LAUNCH-008
  /**
   * Stops a running game workload on AWS.
   *
   * Message strings are part of the contract `EcsService` surfaces to the operator — changing
   * them changes the UI text. The STOPPED state-change event fires the update-dns Lambda which
   * deletes the Route 53 record — no DNS cleanup needed here.
   *
   * @param game - The game identifier to stop.
   */
  async stopWorkload(game: string): Promise<void> {
    const config = (await this.getConfig?.()) ?? null;
    if (!config) throw new WorkloadGuardError('Infrastructure is not deployed.');

    const cluster = config.ecsClusterName;

    await this.withGameLock(game, async () => {
      const task = await this.findRunningTask(
        config.region,
        config.credentials,
        config.credentialsSignature,
        cluster,
        game,
      );
      if (!task) throw new WorkloadGuardError(`${game} is not currently running.`);

      // Deliberately no try/catch here — see the matching comment in
      // `startWorkload`: StopTask failures propagate unchanged.
      await this.getEcsClient(config.region, config.credentials, config.credentialsSignature).send(
        new StopTaskCommand({ cluster, task: task.taskArn, reason: 'Stopped via management app' }),
      );
    });
  }

  // @spec RT-TASK-STATUS-001, RT-TASK-STATUS-002, RT-TASK-STATUS-003, RT-TASK-STATUS-004, RT-TASK-STATUS-005
  // @spec RT-TASK-STATUS-006
  /**
   * Retrieves the current status of a game workload on AWS.
   *
   * Mirrors `EcsService.getStatus`'s state transitions exactly: `not_deployed`
   * when the infra program hasn't been applied, `running` with resolved IP/hostname
   * once the task's ENI is up, `starting` while the task is still
   * provisioning, `stopped` when no task is found, and `error` on failure.
   *
   * The `try` wraps `getConfig()` itself (not just the ECS/EC2 calls below
   * it) so a single game's config resolution failing — e.g. a pasted AWS
   * credentials entry that can't be decrypted, which `resolveAwsClientCredentials`
   * throws for synchronously — surfaces as this one game's `error` state
   * instead of rejecting the whole `Promise.all` a caller (e.g.
   * `games.controller.ts`'s status poll) runs across every game.
   *
   * @param game - The game identifier to query.
   */
  async getWorkloadStatus(game: string): Promise<WorkloadStatus> {
    try {
      const config = (await this.getConfig?.()) ?? null;
      if (!config) return { state: 'not_deployed', message: 'Run Apply on the IaC page first.' };

      const { region, credentials, credentialsSignature, ecsClusterName: cluster, domainName: domain } = config;

      const task = await this.findRunningTask(region, credentials, credentialsSignature, cluster, game);
      if (task) {
        if (task.lastStatus === 'RUNNING') {
          const eniId = getTaskEniId(task);
          const publicIp = eniId ? await this.getPublicIp(region, credentials, credentialsSignature, eniId) : null;
          return {
            state: 'running',
            workloadId: task.taskArn,
            publicIp: publicIp ?? undefined,
            hostname: domain ? `${game}.${domain}` : undefined,
          };
        }
        return { state: 'starting', workloadId: task.taskArn };
      }
      return { state: 'stopped' };
    } catch (err) {
      return { state: 'error', message: String(err) };
    }
  }

  // @spec APP-LOGS-GROUP-001, APP-LOGS-TAIL-001, APP-LOGS-TAIL-002, APP-LOGS-TAIL-004, APP-LOGS-TAIL-006
  // @spec APP-LOGS-TAIL-008
  /**
   * Streams log chunks for a running game workload on AWS.
   *
   * Reproduces `LogsService.streamLogs`'s polling behaviour: polls
   * `FilterLogEvents` against the infra-program-provisioned `/ecs/{game}-server`
   * log group every `pollInterval` ms (default 2000, matching the SSE
   * client's expected cadence), de-duplicates by `eventId` (falling back to
   * `{timestamp}-{message}` when a CloudWatch event has no `eventId`) so
   * overlapping `startTime` windows never yield the same line twice, and
   * exits cleanly once `signal` is aborted. A poll failure yields a single
   * `[stream error] ...` sentinel chunk instead of terminating the generator,
   * so a transient CloudWatch/SDK hiccup doesn't kill the whole stream —
   * matching `LogsService.streamLogs`'s resiliency.
   *
   * The first poll starts {@link LOG_TAIL_LOOKBACK_MS} before the tail opened, because CloudWatch filters on the
   * event timestamp and an event stamped just before the tail began can be ingested after the snapshot; the
   * `eventId` de-duplication absorbs the overlap.
   *
   * A `ResourceNotFoundException` (the group appears only once the game's first task logs) is reported once as an
   * informational chunk and logged once at warn; polling continues with an exponentially growing delay (capped at
   * {@link MAX_NOT_FOUND_BACKOFF_MS}) until the group exists, rather than repeating an error every `pollInterval`.
   *
   * @param game - The game identifier to stream logs for.
   * @param signal - Aborts the stream when triggered.
   * @param pollInterval - Milliseconds between polls. Defaults to 2000.
   */
  async *streamWorkloadLogs(
    game: string,
    signal: AbortSignal,
    pollInterval = 2000,
  ): AsyncGenerator<LogChunk> {
    const config = (await this.getConfig?.()) ?? null;
    if (!config) throw new WorkloadGuardError('Infrastructure is not deployed. Run Apply on the IaC page first.');

    const { region, credentials, credentialsSignature } = config;
    const logGroup = `/ecs/${game}-server`;
    let startTime = Date.now() - LOG_TAIL_LOOKBACK_MS;
    const seen = new Set<string>();
    let notFoundPolls = 0;

    while (!signal.aborted) {
      try {
        const resp = await this.getLogsClient(region, credentials, credentialsSignature).send(
          new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 100 }),
          { abortSignal: signal },
        );
        notFoundPolls = 0;
        for (const e of resp.events ?? []) {
          const id = e.eventId ?? `${e.timestamp}-${e.message}`;
          if (!seen.has(id)) {
            seen.add(id);
            yield { message: e.message ?? '', timestamp: new Date(e.timestamp ?? Date.now()) };
          }
          if ((e.timestamp ?? 0) >= startTime) {
            startTime = (e.timestamp ?? startTime) + 1;
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') break;
        if ((err as Error).name === 'ResourceNotFoundException') {
          if (notFoundPolls === 0) {
            this.logger?.warn?.(`Log group does not exist yet for game=${game} logGroup=${logGroup}`);
            yield { message: noLogGroupMessage(game), timestamp: new Date() };
          }
          notFoundPolls += 1;
        } else {
          this.logger?.error(`Log stream poll error for game=${game} logGroup=${logGroup}`, err);
          yield { message: `[stream error] ${String(err)}`, timestamp: new Date() };
        }
      }

      const delay = Math.min(pollInterval * 2 ** notFoundPolls, Math.max(pollInterval, MAX_NOT_FOUND_BACKOFF_MS));
      try {
        await sleepInterruptible(delay, signal);
      } catch {
        break;
      }
    }
  }
}
