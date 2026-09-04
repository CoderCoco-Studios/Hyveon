/**
 * InteractionsLambda — HTTPS entry point for Discord slash-commands and
 * autocomplete, exposed via a Lambda Function URL.
 *
 * Responsibilities:
 *  - Verify the Ed25519 signature Discord attaches to every request (required
 *    by Discord; spoofed requests are rejected before any config is read).
 *  - Answer the PING handshake.
 *  - For APPLICATION_COMMAND_AUTOCOMPLETE, filter the game list baked into
 *    env vars by the caller's permissions and respond in-band (synchronous,
 *    no ECS calls — must fit in the 3-second budget).
 *  - For APPLICATION_COMMAND, check `canRun()` against the config in DynamoDB
 *    and respond with a deferred ack (type 5). The actual ECS RunTask/StopTask
 *    work is kicked off by async-invoking FollowupLambda so Discord gets its
 *    reply inside the 3-second budget regardless of AWS latency.
 */
import { verifyAsync } from '@noble/ed25519';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { canRun, getEffectiveDiscordConfig, getPublicKey } from '@hyveon/shared';
import type { DiscordAction, DiscordConfig } from '@hyveon/shared';

/** Discord interaction types we care about. Full list in discord-api-types. */
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE = 4;

/** Discord interaction response types we emit. */
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const RESPONSE_APPLICATION_COMMAND_AUTOCOMPLETE_RESULT = 8;

const EPHEMERAL = 64;

interface InteractionData {
  name: string;
  options?: Array<{ name: string; value: string; type: number; focused?: boolean }>;
}

interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  member?: { user?: { id: string }; roles?: string[] };
  user?: { id: string };
  data?: InteractionData;
}

let lambdaClient: LambdaClient | null = null;
function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    // AWS_REGION_ (trailing underscore) — AWS_REGION is reserved by the Lambda runtime and cannot be set as a function env var.
    const region =
      process.env['AWS_REGION_'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
    lambdaClient = new LambdaClient({ region });
  }
  return lambdaClient;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/** Convert a hex string to a Uint8Array. Throws on odd length / non-hex chars. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex');
    out[i] = byte;
  }
  return out;
}

async function verifySignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): Promise<boolean> {
  try {
    const sig = hexToBytes(signatureHex);
    const key = hexToBytes(publicKeyHex);
    const msg = new TextEncoder().encode(timestamp + rawBody);
    return await verifyAsync(sig, msg, key);
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, statusCode = 200): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function unauthorized(): APIGatewayProxyResultV2 {
  return { statusCode: 401, body: 'invalid request signature' };
}

function extractRoleIds(interaction: Interaction): string[] {
  return Array.isArray(interaction.member?.roles) ? interaction.member.roles : [];
}

function extractUserId(interaction: Interaction): string {
  return interaction.member?.user?.id ?? interaction.user?.id ?? '';
}

function extractGameOption(data: InteractionData | undefined): string | undefined {
  return data?.options?.find((o) => o.name === 'game')?.value;
}

function gameListFromEnv(): string[] {
  const raw = process.env['GAME_NAMES'] ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function ephemeralMessage(content: string, deferred = false): APIGatewayProxyResultV2 {
  if (deferred) {
    return jsonResponse({
      type: RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: EPHEMERAL },
    });
  }
  return jsonResponse({
    type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  });
}

/** Read the raw body as Discord sent it; signatures are over the raw bytes, so do NOT re-stringify after parsing. */
function readRawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

function actionFor(name: string): DiscordAction | null {
  switch (name) {
    case 'server-start':
      return 'start';
    case 'server-stop':
      return 'stop';
    case 'server-status':
    case 'server-list':
      return 'status';
    default:
      return null;
  }
}

async function handleAutocomplete(
  interaction: Interaction,
  cfg: DiscordConfig,
): Promise<APIGatewayProxyResultV2> {
  const focused = interaction.data?.options?.find((o) => o.focused && o.name === 'game');
  const name = interaction.data?.name ?? '';
  const action = actionFor(name);
  if (!focused || !action) {
    return jsonResponse({
      type: RESPONSE_APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: { choices: [] },
    });
  }
  const partial = (focused.value ?? '').toLowerCase();
  const userId = extractUserId(interaction);
  const roleIds = extractRoleIds(interaction);
  const guildId = interaction.guild_id ?? '';
  const choices = gameListFromEnv()
    .filter((g) => g.toLowerCase().includes(partial))
    .filter((g) => canRun(cfg, { guildId, userId, roleIds, game: g, action }))
    .slice(0, 25)
    .map((g) => ({ name: g, value: g }));
  return jsonResponse({
    type: RESPONSE_APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  });
}

async function handleApplicationCommand(
  interaction: Interaction,
  cfg: DiscordConfig,
): Promise<APIGatewayProxyResultV2> {
  const name = interaction.data?.name ?? '';
  const action = actionFor(name);
  if (!action) return ephemeralMessage(`Unknown command /${name}.`);

  const guildId = interaction.guild_id ?? '';
  if (!cfg.allowedGuilds.includes(guildId)) {
    return ephemeralMessage('This bot is not enabled in this server.');
  }

  const userId = extractUserId(interaction);
  const roleIds = extractRoleIds(interaction);
  const game = extractGameOption(interaction.data);

  if (name === 'server-list') {
    await invokeFollowup({
      kind: 'list',
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
      userId,
      guildId,
      roleIds,
    });
    return ephemeralMessage('', true);
  }

  if (name === 'server-status' && !game) {
    await invokeFollowup({
      kind: 'list',
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
      userId,
      guildId,
      roleIds,
    });
    return ephemeralMessage('', true);
  }

  if (!game) return ephemeralMessage('Game is required.');

  if (!canRun(cfg, { guildId, userId, roleIds, game, action })) {
    return ephemeralMessage(`You don't have permission to ${action} **${game}**.`);
  }

  await invokeFollowup({
    kind: action,
    applicationId: interaction.application_id,
    interactionToken: interaction.token,
    userId,
    guildId,
    roleIds,
    game,
  });
  return ephemeralMessage('', true);
}

interface FollowupPayload {
  kind: 'start' | 'stop' | 'status' | 'list';
  applicationId: string;
  interactionToken: string;
  userId: string;
  guildId: string;
  roleIds: string[];
  game?: string;
}

async function invokeFollowup(payload: FollowupPayload): Promise<void> {
  const fnName = requireEnv('FOLLOWUP_LAMBDA_NAME');
  await getLambdaClient().send(
    new InvokeCommand({
      FunctionName: fnName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

/**
 * Entry point for every Discord HTTP interaction, fronted by a Lambda Function URL.
 * Verifies the Ed25519 signature against the public key in Secrets Manager (Discord
 * rejects any unverified reply, so this gate is mandatory) and then either PONGs a
 * PING, answers autocomplete synchronously from the baked-in `GAME_NAMES` env var,
 * or deferred-acks a slash command (`type:5`) and async-invokes the followup Lambda
 * to do the slow ECS work within Discord's 3-second reply budget.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const signature = event.headers?.['x-signature-ed25519'];
  const timestamp = event.headers?.['x-signature-timestamp'];
  if (!signature || !timestamp) return unauthorized();

  const rawBody = readRawBody(event);

  const publicKeySecretArn = requireEnv('DISCORD_PUBLIC_KEY_SECRET_ARN');
  const publicKey = await getPublicKey(publicKeySecretArn);
  if (!publicKey) return unauthorized();

  const ok = await verifySignature(publicKey, signature, timestamp, rawBody);
  if (!ok) return unauthorized();

  let interaction: Interaction;
  try {
    interaction = JSON.parse(rawBody) as Interaction;
  } catch {
    return { statusCode: 400, body: 'invalid json' };
  }

  if (interaction.type === INTERACTION_PING) {
    return jsonResponse({ type: RESPONSE_PONG });
  }

  const tableName = requireEnv('TABLE_NAME');
  const cfg = await getEffectiveDiscordConfig(tableName);

  if (interaction.type === INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE) {
    return handleAutocomplete(interaction, cfg);
  }
  if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
    return handleApplicationCommand(interaction, cfg);
  }

  return jsonResponse({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Unsupported interaction type.', flags: EPHEMERAL } });
};
