/**
 * Watchdog Lambda.
 *
 * Runs on a schedule (EventBridge rate). For each running game server task:
 *   - A game with a declared health check (`HEALTH_CHECKS[game]`) is
 *     evaluated by invoking the health-check Lambda synchronously instead;
 *     a game without one keeps reading CloudWatch `NetworkPacketsIn` on the
 *     task's ENI over the last `CHECK_WINDOW_MINUTES` window, exactly as
 *     before. Exactly one verdict source applies to any given task.
 *   - If the task counts as idle by whichever source applied, increments
 *     the per-task `idle_checks` ECS resource tag. After `IDLE_CHECKS`
 *     consecutive idle windows, the task is stopped.
 *   - DNS cleanup is NOT done here: stopping the task emits an
 *     `ECS Task State Change` event that the update-dns Lambda reacts to,
 *     deleting the record on its `STOPPED` path. Deleting it here first
 *     would leave a dangling task with no DNS record if `StopTask` then
 *     failed.
 */
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  StopTaskCommand,
  TagResourceCommand,
  ListTagsForResourceCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { parseJsonEnv, type GameServerHealthCheck } from '@hyveon/shared';

const ECS_CLUSTER = requireEnv('ECS_CLUSTER');
const GAME_NAMES = (process.env['GAME_NAMES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IDLE_CHECKS = parseInt(process.env['IDLE_CHECKS'] ?? '4', 10);
const MIN_PACKETS = parseInt(process.env['MIN_PACKETS'] ?? '100', 10);
const CHECK_WINDOW_MINUTES = parseInt(process.env['CHECK_WINDOW_MINUTES'] ?? '15', 10);
/** Game name → declared health check, for the games opted into that verdict source instead of the CloudWatch heuristic. Populated by the infra program from `DeploymentConfig.gameServers`; empty when no game opts in. Parsed defensively — a malformed/empty value must not crash module init and take down the watchdog for every game. */
const HEALTH_CHECKS: Record<string, GameServerHealthCheck> = parseJsonEnv('HEALTH_CHECKS', process.env['HEALTH_CHECKS'], {});
/** Name of the health-check Lambda to invoke for a game with a declared health check. Unset when no game opts in — {@link HEALTH_CHECKS} is then always empty, so it's never read. */
const HEALTH_CHECK_FUNCTION_NAME = process.env['HEALTH_CHECK_FUNCTION_NAME'];

const FAMILY_TO_GAME = new Map<string, string>(GAME_NAMES.map((g) => [`${g}-server`, g]));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function region(): string {
  return (
    process.env['AWS_REGION_'] ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    'us-east-1'
  );
}

const ecs = new ECSClient({ region: region() });
const cloudwatch = new CloudWatchClient({ region: region() });
const lambda = new LambdaClient({ region: region() });

/** Shape returned by the health-check Lambda's handler — duplicated locally rather than imported from `@hyveon/lambda-health-check` so the two Lambda packages stay independently deployable. */
interface HealthCheckInvokeResult {
  active: boolean;
  reason: string;
  failureDerived?: boolean;
}

function getEniId(task: Task): string | null {
  for (const att of task.attachments ?? []) {
    if (att.type !== 'ElasticNetworkInterface') continue;
    for (const detail of att.details ?? []) {
      if (detail.name === 'networkInterfaceId') return detail.value ?? null;
    }
  }
  return null;
}

/**
 * Query CloudWatch for inbound packets on this ENI over the last check window.
 * Falls back to "active" when metrics are unavailable to avoid accidental
 * shutdowns of brand-new tasks whose ENI hasn't begun emitting yet.
 */
async function getNetworkPackets(eniId: string): Promise<number> {
  const now = new Date();
  const start = new Date(now.getTime() - CHECK_WINDOW_MINUTES * 60_000);
  try {
    const resp = await cloudwatch.send(
      new GetMetricStatisticsCommand({
        Namespace: 'AWS/EC2',
        MetricName: 'NetworkPacketsIn',
        Dimensions: [{ Name: 'NetworkInterfaceId', Value: eniId }],
        StartTime: start,
        EndTime: now,
        Period: CHECK_WINDOW_MINUTES * 60,
        Statistics: ['Sum'],
      }),
    );
    const datapoint = resp.Datapoints?.[0]?.Sum;
    if (typeof datapoint === 'number') return Math.floor(datapoint);
    console.log(`No CloudWatch datapoints for ENI ${eniId} — assuming active`);
    return MIN_PACKETS + 1;
  } catch (err) {
    console.warn(`CloudWatch query failed for ${eniId} — assuming active`, { err });
    return MIN_PACKETS + 1;
  }
}

/**
 * Invokes the health-check Lambda synchronously for a game with a declared
 * health check, and normalizes its result. A failed invoke — throttled,
 * the function absent, a timeout, or a malformed response — is fail-active,
 * the same treatment {@link getNetworkPackets} gives a failed CloudWatch
 * query: the failure that matters most (the function is unreachable) is
 * exactly the one where no lower layer runs at all, so this layer must
 * handle it rather than assume the health-check Lambda already did.
 */
async function invokeHealthCheck(
  game: string,
  taskArn: string,
  healthCheck: GameServerHealthCheck,
): Promise<HealthCheckInvokeResult> {
  if (!HEALTH_CHECK_FUNCTION_NAME) {
    console.warn(`${game}: health check declared but no health-check function is configured — assuming active`);
    return { active: true, reason: 'health check invocation failed: no health-check function configured', failureDerived: true };
  }
  try {
    const resp = await lambda.send(
      new InvokeCommand({
        FunctionName: HEALTH_CHECK_FUNCTION_NAME,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify({ game, taskArn, healthCheck })),
      }),
    );
    if (resp.FunctionError) {
      throw new Error(`health-check function returned ${resp.FunctionError}`);
    }
    const payloadText = resp.Payload ? Buffer.from(resp.Payload).toString('utf-8') : '';
    const parsed = JSON.parse(payloadText) as Partial<HealthCheckInvokeResult>;
    if (typeof parsed.active !== 'boolean' || typeof parsed.reason !== 'string') {
      throw new Error('health-check function returned a malformed response');
    }
    return { active: parsed.active, reason: parsed.reason, failureDerived: parsed.failureDerived ?? false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${game}: health check invocation failed — assuming active`, { err: message });
    return { active: true, reason: `health check invocation failed: ${message}`, failureDerived: true };
  }
}

async function getIdleCount(taskArn: string): Promise<number> {
  try {
    const resp = await ecs.send(new ListTagsForResourceCommand({ resourceArn: taskArn }));
    const tag = resp.tags?.find((t) => t.key === 'idle_checks');
    if (tag?.value) return parseInt(tag.value, 10) || 0;
  } catch {
    // missing-tag is fine; treat as 0
  }
  return 0;
}

async function setIdleCount(taskArn: string, count: number): Promise<void> {
  try {
    await ecs.send(
      new TagResourceCommand({
        resourceArn: taskArn,
        tags: [{ key: 'idle_checks', value: String(count) }],
      }),
    );
  } catch (err) {
    console.warn(`Failed to set idle_checks tag on ${taskArn}`, { err });
  }
}

async function listAllRunningTaskArns(): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await ecs.send(
      new ListTasksCommand({ cluster: ECS_CLUSTER, desiredStatus: 'RUNNING', nextToken }),
    );
    if (resp.taskArns) arns.push(...resp.taskArns);
    nextToken = resp.nextToken;
  } while (nextToken);
  return arns;
}

/**
 * Runs on an EventBridge schedule (`rate(${watchdog_interval_minutes} minutes)`) and
 * stops idle game-server tasks to keep costs down. For each RUNNING task, reads
 * `NetworkPacketsIn` on its ENI via CloudWatch and bumps a consecutive-idle counter
 * stored as an ECS task tag (no DynamoDB/SSM state). After `watchdog_idle_checks`
 * consecutive idle intervals, the task is stopped — which triggers the DNS-delete
 * path in `@hyveon/lambda-update-dns` via the resulting `STOPPED` state-change event.
 */
export const handler = async (): Promise<{ checked: number }> => {
  console.log(`Watchdog running — cluster: ${ECS_CLUSTER}, games: ${GAME_NAMES.join(',')}`);

  const arns = await listAllRunningTaskArns();
  if (!arns.length) {
    console.log('No running tasks — nothing to check.');
    return { checked: 0 };
  }

  const desc = await ecs.send(new DescribeTasksCommand({ cluster: ECS_CLUSTER, tasks: arns }));
  let checked = 0;

  for (const task of desc.tasks ?? []) {
    if (task.lastStatus !== 'RUNNING' || !task.taskArn) continue;
    const family = (task.group ?? '').replace('family:', '');
    const game = FAMILY_TO_GAME.get(family);
    if (!game) continue;

    checked++;

    const declaredHealthCheck = HEALTH_CHECKS[game];
    let idleThisCheck: boolean;
    let verdictDetail: string;

    if (declaredHealthCheck) {
      const verdict = await invokeHealthCheck(game, task.taskArn, declaredHealthCheck);
      idleThisCheck = !verdict.active;
      verdictDetail = verdict.reason;
      if (verdict.failureDerived) {
        console.warn(`${game}: health check is failure-derived — treating as active (${verdict.reason})`);
      }
    } else {
      const eniId = getEniId(task);
      if (!eniId) continue;
      const packets = await getNetworkPackets(eniId);
      idleThisCheck = packets < MIN_PACKETS;
      verdictDetail = `packets=${packets}, threshold=${MIN_PACKETS}`;
    }

    let idleCount = await getIdleCount(task.taskArn);

    if (idleThisCheck) {
      idleCount += 1;
      console.log(`${game}: idle check ${idleCount}/${IDLE_CHECKS} (${verdictDetail})`);
      if (idleCount >= IDLE_CHECKS) {
        console.log(
          `${game}: shutting down after ${idleCount} idle checks (${idleCount * CHECK_WINDOW_MINUTES} minutes idle)`,
        );
        await ecs.send(
          new StopTaskCommand({
            cluster: ECS_CLUSTER,
            task: task.taskArn,
            reason: `Watchdog: idle for ${idleCount * CHECK_WINDOW_MINUTES} minutes`,
          }),
        );
      } else {
        await setIdleCount(task.taskArn, idleCount);
      }
    } else {
      if (idleCount > 0) {
        console.log(`${game}: activity detected (${verdictDetail}), resetting idle counter.`);
        await setIdleCount(task.taskArn, 0);
      }
    }
  }
  return { checked };
};
