/**
 * FollowupLambda — async-invoked by InteractionsLambda to do the slow ECS work
 * (RunTask/StopTask/Describe) and PATCH the original Discord interaction with
 * the result.
 *
 * Discord allows up to 15 minutes to PATCH the original message at
 * `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`.
 * That endpoint authenticates via the interaction token in the URL — no bot
 * token required, so this Lambda doesn't need Secrets Manager access.
 *
 * For `kind:'start'` the handler also writes a row to the pending-interactions
 * table keyed by the task ARN. The update-dns Lambda picks that up when the
 * task reaches RUNNING and PATCHes the same interaction with the public IP.
 */
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
} from '@aws-sdk/client-ec2';
// `canRun` is the single shared copy; never inline or fork it.
import {
  canRun,
  formatGameStatus,
  gameNamesFromEnv,
  getEffectiveDiscordConfig,
  parseGameMapEnv,
  putPending,
  requireEnv,
} from '@hyveon/shared';
import type { DiscordAction, DiscordConfig, GameStatus } from '@hyveon/shared';

interface FollowupEvent {
  kind: 'start' | 'stop' | 'status' | 'list';
  applicationId: string;
  interactionToken: string;
  userId: string;
  guildId: string;
  roleIds: string[];
  game?: string;
}

let ecsClient: ECSClient | null = null;
let ec2Client: EC2Client | null = null;

function region(): string {
  return (
    // AWS_REGION_ (trailing underscore) — AWS_REGION is reserved by the Lambda runtime and cannot be set as a function env var.
    process.env['AWS_REGION_'] ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    'us-east-1'
  );
}

function getEcs(): ECSClient {
  if (!ecsClient) ecsClient = new ECSClient({ region: region() });
  return ecsClient;
}

function getEc2(): EC2Client {
  if (!ec2Client) ec2Client = new EC2Client({ region: region() });
  return ec2Client;
}

/** Per-game connect message templates, keyed by game name — sourced from `DeploymentConfig.gameServers` and wired into this env var by the infra program (`app/packages/infra/src/lambdas.ts`). Parsed defensively — see {@link parseGameMapEnv}. */
const CONNECT_MESSAGES: Record<string, string> = parseGameMapEnv('CONNECT_MESSAGES');

/** First container port per game, used to resolve the `{port}` placeholder. Parsed defensively — see {@link parseGameMapEnv}. */
const GAME_PORTS: Record<string, number> = parseGameMapEnv('GAME_PORTS');

function extractEniId(task: Task): string | null {
  for (const att of task.attachments ?? []) {
    if (att.type !== 'ElasticNetworkInterface') continue;
    for (const detail of att.details ?? []) {
      if (detail.name === 'networkInterfaceId') return detail.value ?? null;
    }
  }
  return null;
}

async function getPublicIp(eniId: string): Promise<string | null> {
  const resp = await getEc2().send(
    new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
  );
  return resp.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
}

async function findRunningTask(cluster: string, game: string): Promise<Task | null> {
  const list = await getEcs().send(
    new ListTasksCommand({ cluster, family: `${game}-server`, desiredStatus: 'RUNNING' }),
  );
  if (!list.taskArns?.length) return null;
  const desc = await getEcs().send(new DescribeTasksCommand({ cluster, tasks: list.taskArns }));
  return desc.tasks?.find((t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING') ?? null;
}

async function getStatus(game: string): Promise<GameStatus> {
  const cluster = requireEnv('ECS_CLUSTER');
  const domain = process.env['DOMAIN_NAME'] ?? '';
  try {
    const task = await findRunningTask(cluster, game);
    if (task) {
      if (task.lastStatus === 'RUNNING') {
        const eniId = extractEniId(task);
        const publicIp = eniId ? await getPublicIp(eniId) : null;
        return {
          game,
          state: 'running',
          publicIp: publicIp ?? undefined,
          hostname: domain ? `${game}.${domain}` : undefined,
          taskArn: task.taskArn,
        };
      }
      return { game, state: 'starting', taskArn: task.taskArn };
    }
    return { game, state: 'stopped' };
  } catch (err) {
    return { game, state: 'error', message: String(err) };
  }
}

async function runStart(game: string): Promise<{ message: string; taskArn?: string }> {
  const cluster = requireEnv('ECS_CLUSTER');
  const subnets = requireEnv('SUBNET_IDS').split(',').map((s) => s.trim()).filter(Boolean);
  const sg = requireEnv('SECURITY_GROUP_ID');

  const existing = await findRunningTask(cluster, game);
  if (existing) return { message: `❌ ${game} is already running.` };

  try {
    const resp = await getEcs().send(
      new RunTaskCommand({
        cluster,
        taskDefinition: `${game}-server`,
        count: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: { subnets, securityGroups: [sg], assignPublicIp: 'ENABLED' },
        },
        propagateTags: 'TASK_DEFINITION',
      }),
    );
    const taskArn = resp.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const reason = resp.failures?.[0]?.reason ?? 'unknown';
      return { message: `❌ Failed to start ${game}: ${reason}` };
    }
    return { message: `✅ ${game} is starting. It may take 2–5 minutes.`, taskArn };
  } catch (err) {
    return { message: `❌ Exception starting ${game}: ${String(err)}` };
  }
}

async function runStop(game: string): Promise<string> {
  const cluster = requireEnv('ECS_CLUSTER');
  const task = await findRunningTask(cluster, game);
  if (!task?.taskArn) return `❌ ${game} is not currently running.`;
  try {
    await getEcs().send(
      new StopTaskCommand({ cluster, task: task.taskArn, reason: 'Stopped via Discord' }),
    );
    return `✅ ${game} is stopping.`;
  } catch (err) {
    return `❌ Exception stopping ${game}: ${String(err)}`;
  }
}

const DISCORD_API = 'https://discord.com/api/v10';

/** PATCH the original deferred-ack message. */
async function patchOriginal(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error('Discord PATCH failed', { status: resp.status, body });
  }
}

async function handleList(event: FollowupEvent, cfg: DiscordConfig): Promise<string> {
  const games = gameNamesFromEnv();
  if (!games.length) return 'No games configured.';
  const visible = games.filter((g) =>
    canRun(cfg, {
      guildId: event.guildId,
      userId: event.userId,
      roleIds: event.roleIds,
      game: g,
      action: 'status',
    }),
  );
  if (!visible.length) return "You don't have permission to view any server statuses.";
  const statuses = await Promise.all(visible.map((g) => getStatus(g)));
  return statuses.map((s) => formatGameStatus(s, CONNECT_MESSAGES[s.game], GAME_PORTS[s.game])).join('\n');
}

async function handleStatus(event: FollowupEvent): Promise<string> {
  if (!event.game) return 'Game is required.';
  const status = await getStatus(event.game);
  return formatGameStatus(status, CONNECT_MESSAGES[event.game], GAME_PORTS[event.game]);
}

async function handleStart(event: FollowupEvent): Promise<string> {
  if (!event.game) return 'Game is required.';
  const { message, taskArn } = await runStart(event.game);
  if (taskArn) {
    const tableName = requireEnv('TABLE_NAME');
    await putPending(tableName, {
      taskArn,
      applicationId: event.applicationId,
      interactionToken: event.interactionToken,
      userId: event.userId,
      guildId: event.guildId,
      game: event.game,
      action: 'start',
    });
    const connectMsg = CONNECT_MESSAGES[event.game];
    if (connectMsg) {
      const port = GAME_PORTS[event.game];
      const domain = process.env['DOMAIN_NAME'] ?? '';
      const host = domain ? `${event.game}.${domain}` : '';
      const rendered = connectMsg
        .replace(/\{host\}/g, host)
        .replace(/\{ip\}/g, '')
        .replace(/\{port\}/g, port !== undefined ? String(port) : '')
        .replace(/\{game\}/g, event.game);
      return `${message}\n${rendered}`;
    }
  }
  return message;
}

async function handleStop(event: FollowupEvent): Promise<string> {
  if (!event.game) return 'Game is required.';
  return runStop(event.game);
}

/** Defensive re-check — InteractionsLambda already verified, but config could have changed in the milliseconds since. */
function recheck(event: FollowupEvent, cfg: DiscordConfig, action: DiscordAction, game: string): boolean {
  return canRun(cfg, {
    guildId: event.guildId,
    userId: event.userId,
    roleIds: event.roleIds,
    game,
    action,
  });
}

/**
 * Async-invoked by the interactions Lambda after it has already deferred the reply
 * (Discord's 3-second budget doesn't leave room for ECS calls). Does the slow work —
 * `RunTask` / `StopTask` / `DescribeTasks` — then PATCHes the original interaction
 * message via the webhook endpoint. For `start`, also writes a `PENDING#{taskArn}`
 * row to DynamoDB so `@hyveon/lambda-update-dns` can PATCH the same interaction once
 * the task reaches RUNNING and an IP/hostname is resolved.
 */
export const handler = async (event: FollowupEvent): Promise<void> => {
  const tableName = requireEnv('TABLE_NAME');
  const cfg = await getEffectiveDiscordConfig(tableName);

  let content: string;
  try {
    if (event.kind === 'list') {
      content = await handleList(event, cfg);
    } else if (event.kind === 'status') {
      if (event.game && !recheck(event, cfg, 'status', event.game)) {
        content = `You don't have permission to status **${event.game}**.`;
      } else {
        content = await handleStatus(event);
      }
    } else if (event.kind === 'start') {
      if (event.game && !recheck(event, cfg, 'start', event.game)) {
        content = `You don't have permission to start **${event.game}**.`;
      } else {
        content = await handleStart(event);
      }
    } else if (event.kind === 'stop') {
      if (event.game && !recheck(event, cfg, 'stop', event.game)) {
        content = `You don't have permission to stop **${event.game}**.`;
      } else {
        content = await handleStop(event);
      }
    } else {
      content = `Unknown action: ${String((event as { kind: string }).kind)}`;
    }
  } catch (err) {
    console.error('Followup handler failed', { err, event });
    content = '❌ Command failed. Check server logs.';
  }

  await patchOriginal(event.applicationId, event.interactionToken, content);
};
