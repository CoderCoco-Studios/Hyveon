/**
 * DNS updater Lambda.
 *
 * Triggered by EventBridge on `ECS Task State Change`.
 *
 * For every game (HTTPS games terminate TLS in-task via a Caddy sidecar and
 * share the task's public IP, so they use the same path as everything else):
 *   - RUNNING → resolve ENI public IP → UPSERT Route 53 A record plus an ownership TXT record (task ARN)
 *   - STOPPED → DELETE both records, only if the TXT names the stopping task
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
  errMessage,
  familyToGameMap,
  formatGameStatus,
  gameNamesFromEnv,
  getPending,
  getTaskEniId,
  parseGameMapEnv,
  patchInteractionOriginal,
  requireEnv,
  resolveEniPublicIp,
} from '@hyveon/shared';
import type { ConnectPort } from '@hyveon/shared';

// @spec RT-TASK-DNS-012
const HOSTED_ZONE_ID = requireEnv('HOSTED_ZONE_ID');
const DOMAIN_NAME = requireEnv('DOMAIN_NAME');
const GAME_NAMES = gameNamesFromEnv();
const DNS_TTL = parseInt(process.env['DNS_TTL'] ?? '30', 10);
const TABLE_NAME = process.env['TABLE_NAME'] ?? '';

/** Per-game connect message templates, keyed by game name — sourced from `DeploymentConfig.gameServers` and wired into this env var by the infra program (`app/packages/infra/src/lambdas.ts`). Parsed defensively — see {@link parseGameMapEnv}. */
const CONNECT_MESSAGES: Record<string, string> = parseGameMapEnv('CONNECT_MESSAGES');

/** First container port per game, used to resolve the `{port}` placeholder. Parsed defensively — see {@link parseGameMapEnv}. */
const GAME_PORTS: Record<string, ConnectPort> = parseGameMapEnv('GAME_PORTS');

const FAMILY_TO_GAME = familyToGameMap(GAME_NAMES);

// @spec RT-TASK-DNS-013
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

// @spec RT-TASK-DNS-004
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
      console.error(`IP resolution attempt ${attempt} failed`, { error: errMessage(err) });
    }
    await sleep(3000);
  }
  return null;
}

/** Sibling label holding the owning task ARN; an underscore prefix keeps it clear of the game's A record. */
function ownerRecordName(dnsName: string): string {
  return `_hyveon-owner.${dnsName}`;
}

/** TXT values must be quoted for Route 53. */
const quoteTxt = (value: string): string => `"${value}"`;
const unquoteTxt = (value: string): string => value.replace(/^"|"$/g, '');

// @spec RT-TASK-DNS-005, RT-TASK-DNS-016
/** UPSERT the A record and its ownership TXT record in one change batch, so a record is never published without its owner. */
async function upsertDns(dnsName: string, ip: string, taskArn: string): Promise<void> {
  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: HOSTED_ZONE_ID,
      ChangeBatch: {
        Comment: `Game server auto-upsert for ${dnsName}`,
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: { Name: dnsName, Type: 'A', TTL: DNS_TTL, ResourceRecords: [{ Value: ip }] },
          },
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: ownerRecordName(dnsName),
              Type: 'TXT',
              TTL: DNS_TTL,
              ResourceRecords: [{ Value: quoteTxt(taskArn) }],
            },
          },
        ],
      },
    }),
  );
}

interface StoredRecord {
  type: 'A' | 'TXT';
  name: string;
  value: string;
  ttl: number;
}

/** Read one record set from the zone; `null` when it does not exist. Throws when the lookup itself fails. */
async function readRecord(name: string, type: 'A' | 'TXT'): Promise<StoredRecord | null> {
  const resp = await route53.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: HOSTED_ZONE_ID,
      StartRecordName: name,
      StartRecordType: type,
      MaxItems: 1,
    }),
  );
  for (const rrs of resp.ResourceRecordSets ?? []) {
    if (rrs.Name?.replace(/\.$/, '') === name && rrs.Type === type) {
      const value = rrs.ResourceRecords?.[0]?.Value;
      return value ? { type, name, value, ttl: rrs.TTL ?? DNS_TTL } : null;
    }
  }
  return null;
}

/** Outcome of a STOPPED-event cleanup. */
type DeleteOutcome = 'deleted' | 'not_owner' | 'owner_unreadable';

// @spec RT-TASK-DNS-007, RT-TASK-DNS-008, RT-TASK-DNS-009, RT-TASK-DNS-010
// @spec RT-TASK-DNS-017, RT-TASK-DNS-018, RT-TASK-DNS-019
/**
 * Delete the game's A record and ownership TXT record when the stopping task owns them.
 *
 * @remarks
 * Ownership is the task ARN in the TXT record. A different ARN or an unreadable lookup changes nothing, so a late
 * STOPPED for an old task cannot remove a newer task's record. An A record with no TXT predates ownership tracking
 * and is deleted. Each DELETE echoes the stored TTL and value because Route 53 rejects a mismatched DELETE.
 *
 * @param dnsName - The game's `{game}.{domain}` A record name.
 * @param taskArn - ARN of the task named by the STOPPED event.
 * @returns What happened, so the handler can report it.
 */
async function deleteDns(dnsName: string, taskArn: string): Promise<DeleteOutcome> {
  let a: StoredRecord | null;
  let owner: StoredRecord | null;
  try {
    owner = await readRecord(ownerRecordName(dnsName), 'TXT');
    a = await readRecord(dnsName, 'A');
  } catch (err) {
    console.warn('Could not read DNS records; leaving them in place', { dnsName, taskArn, error: errMessage(err) });
    return 'owner_unreadable';
  }
  if (owner && unquoteTxt(owner.value) !== taskArn) {
    console.warn('STOPPED task does not own the DNS record; leaving it in place', { dnsName, taskArn });
    return 'not_owner';
  }
  const targets = [a, owner].filter((r): r is StoredRecord => r !== null);
  if (targets.length === 0) {
    console.log(`No DNS record exists for ${dnsName} — nothing to delete.`);
    return 'deleted';
  }
  try {
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: HOSTED_ZONE_ID,
        ChangeBatch: {
          Comment: `Game server auto-delete for ${dnsName}`,
          Changes: targets.map((r) => ({
            Action: 'DELETE' as const,
            ResourceRecordSet: { Name: r.name, Type: r.type, TTL: r.ttl, ResourceRecords: [{ Value: r.value }] },
          })),
        },
      }),
    );
  } catch (err) {
    console.warn('Could not delete DNS record', { dnsName, error: errMessage(err) });
  }
  return 'deleted';
}

/** What the pending Discord interaction should be told: the resolved address, or why the task never became reachable. */
type PendingOutcome = { publicIp: string } | { error: string; keepRow?: boolean };

// @spec RT-TASK-NOTIFY-001, RT-TASK-NOTIFY-002, RT-TASK-NOTIFY-003, RT-TASK-NOTIFY-004
// @spec RT-TASK-NOTIFY-005, RT-TASK-NOTIFY-006
// @spec DISCORD-MSG-006
/**
 * If a Discord interaction is pending for this task, PATCH it with the resolved
 * hostname/IP (or the error text of a failed outcome) and delete the pending row, unless the outcome sets
 * `keepRow` so a retried invocation can still overwrite the message and clear the row.
 */
async function notifyDiscordIfPending(
  taskArn: string,
  game: string,
  outcome: PendingOutcome,
): Promise<void> {
  if (!TABLE_NAME) return;
  try {
    const pending = await getPending(TABLE_NAME, taskArn);
    if (!pending) return;
    const message =
      'publicIp' in outcome
        ? formatGameStatus(
            { game, state: 'running', publicIp: outcome.publicIp, hostname: `${game}.${DOMAIN_NAME}`, taskArn },
            CONNECT_MESSAGES[game],
            GAME_PORTS[game],
          )
        : formatGameStatus({ game, state: 'error', message: outcome.error, taskArn });
    await patchInteractionOriginal(pending.applicationId, pending.interactionToken, message);
    if ('error' in outcome && outcome.keepRow) return;
    await deletePending(TABLE_NAME, taskArn);
  } catch (err) {
    console.error('Discord followup notification failed', { error: errMessage(err), taskArn });
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
      await notifyDiscordIfPending(taskArn, game, { error: 'Could not resolve a public IP for this task.' });
      return { status: 'error', reason: 'no_ip' };
    }
    try {
      await upsertDns(dnsName, ip, taskArn);
    } catch (err) {
      console.error('DNS upsert failed', { dnsName, error: errMessage(err) });
      await notifyDiscordIfPending(taskArn, game, {
        error: 'Could not publish a DNS record for this task.',
        keepRow: true,
      });
      throw err;
    }
    await notifyDiscordIfPending(taskArn, game, { publicIp: ip });
    return { status: 'upserted', game, ip };
  }
  if (lastStatus === 'STOPPED') {
    const outcome = await deleteDns(dnsName, taskArn);
    await notifyDiscordIfPending(taskArn, game, { error: 'The task stopped before it reached RUNNING.' });
    return outcome === 'deleted' ? { status: 'deleted', game } : { status: 'skipped', game, reason: outcome };
  }
  return { status: 'no_action', lastStatus };
}

// @spec RT-TASK-DNS-001, RT-TASK-DNS-003, RT-TASK-DNS-005, RT-TASK-DNS-006, RT-TASK-DNS-007, RT-TASK-DNS-008
// @spec RT-TASK-DNS-011, RT-TASK-DNS-014
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
  const detail = event.detail ?? {};
  const lastStatus = detail.lastStatus ?? '';
  const taskArn = detail.taskArn ?? '';
  const clusterArn = detail.clusterArn ?? '';
  const family = (detail.group ?? '').replace('family:', '');
  const game = FAMILY_TO_GAME[family];
  console.log('DNS updater triggered', { taskArn, family, lastStatus });

  if (!game) {
    console.log(`Task family ${family} is not a known game server — skipping.`);
    return { status: 'skipped', reason: `unknown family: ${family}` };
  }

  const dnsName = `${game}.${DOMAIN_NAME}`;

  return handleDirect(game, dnsName, taskArn, clusterArn, lastStatus);
};
