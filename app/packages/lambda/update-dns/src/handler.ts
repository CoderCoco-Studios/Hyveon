/**
 * DNS updater Lambda.
 *
 * Triggered by EventBridge on `ECS Task State Change`.
 *
 * For every game (HTTPS games terminate TLS in-task via a Caddy sidecar and
 * share the task's public IP, so they use the same path as everything else):
 *   - RUNNING → resolve ENI public IP → UPSERT Route 53 A record
 *   - STOPPED → DELETE Route 53 A record
 *
 * On RUNNING, after the DNS update, look up a pending Discord interaction by task ARN and
 * PATCH the original message with the resolved hostname/IP, then delete the
 * pending row. The Discord interaction token in the pending row is valid for
 * up to 15 minutes — same window as the ECS provisioning timeline.
 */
import { ECSClient, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import {
  deletePending,
  familyToGameMap,
  formatGameStatus,
  gameNamesFromEnv,
  getPending,
  getTaskEniId,
  parseGameMapEnv,
  requireEnv,
  resolveEniPublicIp,
} from '@hyveon/shared';

const HOSTED_ZONE_ID = requireEnv('HOSTED_ZONE_ID');
const DOMAIN_NAME = requireEnv('DOMAIN_NAME');
const GAME_NAMES = gameNamesFromEnv();
const DNS_TTL = parseInt(process.env['DNS_TTL'] ?? '30', 10);
const TABLE_NAME = process.env['TABLE_NAME'] ?? '';

/** Per-game connect message templates, keyed by game name — sourced from `DeploymentConfig.gameServers` and wired into this env var by the infra program (`app/packages/infra/src/lambdas.ts`). Parsed defensively — see {@link parseGameMapEnv}. */
const CONNECT_MESSAGES: Record<string, string> = parseGameMapEnv('CONNECT_MESSAGES');

/** First container port per game, used to resolve the `{port}` placeholder. Parsed defensively — see {@link parseGameMapEnv}. */
const GAME_PORTS: Record<string, number> = parseGameMapEnv('GAME_PORTS');

const FAMILY_TO_GAME = familyToGameMap(GAME_NAMES);

function region(): string {
  return (
    // AWS_REGION_ (trailing underscore) — AWS_REGION is reserved by the Lambda runtime and cannot be set as a function env var.
    process.env['AWS_REGION_'] ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    'us-east-1'
  );
}

const ec2 = new EC2Client({ region: region() });
const ecs = new ECSClient({ region: region() });
const route53 = new Route53Client({});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry a few times since ENI association can lag behind the RUNNING event.
 * Mirrors the 5-attempt loop with 3s sleeps from update_dns.py.
 */
async function resolvePublicIp(taskArn: string, clusterArn: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const resp = await ecs.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] }));
      const task = resp.tasks?.[0];
      if (!task) {
        await sleep(3000);
        continue;
      }
      const eniId = getTaskEniId(task);
      if (!eniId) {
        await sleep(3000);
        continue;
      }
      const ip = await resolveEniPublicIp(
        (id) => ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [id] })),
        eniId,
      );
      if (ip) return ip;
    } catch (err) {
      console.error(`IP resolution attempt ${attempt} failed`, { err });
    }
    await sleep(3000);
  }
  return null;
}

async function upsertDns(dnsName: string, ip: string): Promise<void> {
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: HOSTED_ZONE_ID,
      ChangeBatch: {
        Comment: `Game server auto-upsert for ${dnsName}`,
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: dnsName,
              Type: 'A',
              TTL: DNS_TTL,
              ResourceRecords: [{ Value: ip }],
            },
          },
        ],
      },
    }),
  );
}

async function currentRecordIp(dnsName: string): Promise<string | null> {
  try {
    const resp = await route53.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: HOSTED_ZONE_ID,
        StartRecordName: dnsName,
        StartRecordType: 'A',
        MaxItems: 1,
      }),
    );
    for (const rrs of resp.ResourceRecordSets ?? []) {
      if (rrs.Name?.replace(/\.$/, '') === dnsName.replace(/\.$/, '') && rrs.Type === 'A') {
        return rrs.ResourceRecords?.[0]?.Value ?? null;
      }
    }
  } catch (err) {
    console.warn('Could not look up current record', { dnsName, err });
  }
  return null;
}

async function deleteDns(dnsName: string): Promise<void> {
  const ip = await currentRecordIp(dnsName);
  if (!ip) {
    console.log(`No DNS record exists for ${dnsName} — nothing to delete.`);
    return;
  }
  try {
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: HOSTED_ZONE_ID,
        ChangeBatch: {
          Comment: `Game server auto-delete for ${dnsName}`,
          Changes: [
            {
              Action: 'DELETE',
              ResourceRecordSet: {
                Name: dnsName,
                Type: 'A',
                TTL: DNS_TTL,
                ResourceRecords: [{ Value: ip }],
              },
            },
          ],
        },
      }),
    );
  } catch (err) {
    console.warn('Could not delete DNS record', { dnsName, err });
  }
}

const DISCORD_API = 'https://discord.com/api/v10';

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

/**
 * If a Discord interaction is pending for this task, PATCH it with the
 * resolved hostname/IP and delete the pending row.
 */
async function notifyDiscordIfPending(
  taskArn: string,
  game: string,
  publicIp: string,
): Promise<void> {
  if (!TABLE_NAME) return;
  try {
    const pending = await getPending(TABLE_NAME, taskArn);
    if (!pending) return;
    const hostname = `${game}.${DOMAIN_NAME}`;
    const message = formatGameStatus(
      { game, state: 'running', publicIp, hostname, taskArn },
      CONNECT_MESSAGES[game],
      GAME_PORTS[game],
    );
    await patchOriginal(pending.applicationId, pending.interactionToken, message);
    await deletePending(TABLE_NAME, taskArn);
  } catch (err) {
    console.error('Discord followup notification failed', { err, taskArn });
  }
}

interface EcsStateChangeEvent {
  detail?: {
    lastStatus?: string;
    taskArn?: string;
    clusterArn?: string;
    group?: string;
  };
}

interface HandlerResult {
  status: string;
  game?: string;
  ip?: string;
  reason?: string;
  lastStatus?: string;
}

async function handleDirect(
  game: string,
  dnsName: string,
  taskArn: string,
  clusterArn: string,
  lastStatus: string,
): Promise<HandlerResult> {
  if (lastStatus === 'RUNNING') {
    const ip = await resolvePublicIp(taskArn, clusterArn);
    if (!ip) {
      console.warn(`Could not resolve public IP for ${taskArn}`);
      return { status: 'error', reason: 'no_ip' };
    }
    await upsertDns(dnsName, ip);
    await notifyDiscordIfPending(taskArn, game, ip);
    return { status: 'upserted', game, ip };
  }
  if (lastStatus === 'STOPPED') {
    await deleteDns(dnsName);
    return { status: 'deleted', game };
  }
  return { status: 'no_action', lastStatus };
}

/**
 * Fired by an EventBridge rule on `ECS Task State Change`. UPSERTs a Route 53 record
 * for `{game}.{hosted_zone_name}` on RUNNING and DELETEs on STOPPED — DNS is owned by
 * this Lambda rather than the infra program so records follow ephemeral task IPs without
 * fighting state. HTTPS games terminate TLS in-task via a Caddy sidecar sharing the
 * task's public IP, so they follow the same A-record path as every other game. On
 * RUNNING this also PATCHes any `PENDING#{taskArn}` Discord interaction in DynamoDB
 * so the user sees the resolved address in the same message they clicked on.
 */
export const handler = async (event: EcsStateChangeEvent): Promise<HandlerResult> => {
  console.log('DNS updater triggered', JSON.stringify(event));
  const detail = event.detail ?? {};
  const lastStatus = detail.lastStatus ?? '';
  const taskArn = detail.taskArn ?? '';
  const clusterArn = detail.clusterArn ?? '';
  const family = (detail.group ?? '').replace('family:', '');
  const game = FAMILY_TO_GAME[family];

  if (!game) {
    console.log(`Task family ${family} is not a known game server — skipping.`);
    return { status: 'skipped', reason: `unknown family: ${family}` };
  }

  const dnsName = `${game}.${DOMAIN_NAME}`;

  return handleDirect(game, dnsName, taskArn, clusterArn, lastStatus);
};
