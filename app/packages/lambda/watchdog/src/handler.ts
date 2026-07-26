/**
 * Watchdog Lambda — TypeScript port of the original `watchdog.py`.
 *
 * Runs on a schedule (EventBridge rate). For each running game server task:
 *   - Reads CloudWatch `NetworkPacketsIn` on the task's ENI over the last
 *     `CHECK_WINDOW_MINUTES` window.
 *   - If packets &lt; `MIN_PACKETS`, increments the per-task `idle_checks` ECS
 *     resource tag. After `IDLE_CHECKS` consecutive idle windows, the task is
 *     stopped.
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

const ECS_CLUSTER = requireEnv('ECS_CLUSTER');
const GAME_NAMES = (process.env['GAME_NAMES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IDLE_CHECKS = parseInt(process.env['IDLE_CHECKS'] ?? '4', 10);
const MIN_PACKETS = parseInt(process.env['MIN_PACKETS'] ?? '100', 10);
const CHECK_WINDOW_MINUTES = parseInt(process.env['CHECK_WINDOW_MINUTES'] ?? '15', 10);

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
    const eniId = getEniId(task);
    if (!eniId) continue;

    const packets = await getNetworkPackets(eniId);
    let idleCount = await getIdleCount(task.taskArn);

    if (packets < MIN_PACKETS) {
      idleCount += 1;
      console.log(
        `${game}: idle check ${idleCount}/${IDLE_CHECKS} (packets=${packets}, threshold=${MIN_PACKETS})`,
      );
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
        console.log(`${game}: activity detected (packets=${packets}), resetting idle counter.`);
        await setIdleCount(task.taskArn, 0);
      }
    }
  }
  return { checked };
};
