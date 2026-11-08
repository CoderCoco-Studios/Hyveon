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
 *    work is kicked off by async-invoking FollowupLambda. The AWS calls on
 *    the ack path (secret read, config read, invoke) are sequential, so the invoke
 *    is bounded by the 2.8 s ack deadline; on a timeout the user gets an ephemeral
 *    check-status notice instead of a silent "interaction failed".
 */
import { verifyAsync } from '@noble/ed25519';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
// @spec DISCORD-SVC-002
// `canRun` is the single shared copy; never inline or fork it.
import { canRun, errMessage, gameNamesFromEnv, getEffectiveDiscordConfig, getPublicKey, requireEnv } from '@hyveon/shared';
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
// @spec DISCORD-SVC-003
function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    // AWS_REGION_ (trailing underscore) — AWS_REGION is reserved by the Lambda runtime and cannot be set as a function env var.
    const region =
      process.env['AWS_REGION_'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
    lambdaClient = new LambdaClient({ region });
  }
  return lambdaClient;
}

/** Matches exactly two hex digits — validated before `parseInt` since `parseInt('0g', 16)` returns `0`, not `NaN`. */
const HEX_PAIR = /^[0-9a-fA-F]{2}$/;

/** Convert a hex string to a Uint8Array. Throws on odd length / non-hex chars. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const pair = hex.substr(i * 2, 2);
    if (!HEX_PAIR.test(pair)) throw new Error('invalid hex');
    out[i] = parseInt(pair, 16);
  }
  return out;
}

// @spec DISCORD-AUTH-002
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

// @spec DISCORD-AUTH-002
/** Read the raw body as Discord sent it; signatures are over the raw bytes, so do NOT re-stringify after parsing. */
function readRawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

// @spec DISCORD-CMD-002
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

// @spec DISCORD-CMD-010, DISCORD-CMD-011
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
  const choices = gameNamesFromEnv()
    .filter((g) => g.toLowerCase().includes(partial))
    .filter((g) => canRun(cfg, { guildId, userId, roleIds, game: g, action }))
    .slice(0, 25)
    .map((g) => ({ name: g, value: g }));
  return jsonResponse({
    type: RESPONSE_APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices },
  });
}

// @spec DISCORD-CMD-003, DISCORD-CMD-004, DISCORD-CMD-005, DISCORD-CMD-006, DISCORD-CMD-007, DISCORD-CMD-008, DISCORD-CMD-009
async function handleApplicationCommand(
  interaction: Interaction,
  cfg: DiscordConfig,
  startedAtMs: number,
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
    return deferToFollowup({
      kind: 'list',
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
      userId,
      guildId,
      roleIds,
    }, startedAtMs);
  }

  if (name === 'server-status' && !game) {
    return deferToFollowup({
      kind: 'list',
      applicationId: interaction.application_id,
      interactionToken: interaction.token,
      userId,
      guildId,
      roleIds,
    }, startedAtMs);
  }

  if (!game) return ephemeralMessage('Game is required.');

  if (!canRun(cfg, { guildId, userId, roleIds, game, action })) {
    return ephemeralMessage(`You don't have permission to ${action} **${game}**.`);
  }

  return deferToFollowup({
    kind: action,
    applicationId: interaction.application_id,
    interactionToken: interaction.token,
    userId,
    guildId,
    roleIds,
    game,
  }, startedAtMs);
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

/** Upper bound, in milliseconds, on the followup `Invoke` call. */
const FOLLOWUP_INVOKE_TIMEOUT_MS = 2_000;

/** Latest point, in milliseconds after handler entry, at which the ack should be on its way inside Discord's 3-second budget. */
const ACK_DEADLINE_MS = 2_800;

/** Smallest invoke bound used even when earlier sequential reads consumed nearly the whole ack budget. */
const MIN_FOLLOWUP_INVOKE_TIMEOUT_MS = 250;

/**
 * Computes the followup invoke bound from the time already spent since handler entry.
 *
 * @param startedAtMs - Epoch milliseconds when the handler was entered.
 * @returns `min(2000, 2800 - elapsed)`, never below 250 ms.
 */
function followupInvokeBudgetMs(startedAtMs: number): number {
  const remaining = ACK_DEADLINE_MS - (Date.now() - startedAtMs);
  return Math.max(MIN_FOLLOWUP_INVOKE_TIMEOUT_MS, Math.min(FOLLOWUP_INVOKE_TIMEOUT_MS, remaining));
}

/**
 * Async-invokes the followup Lambda, giving up after {@link followupInvokeBudgetMs}.
 *
 * @remarks
 * The invoke is awaited because Lambda freezes the execution environment once the handler returns. The bound is
 * deadline-based because the secret read, the config read and this invoke run sequentially. A timed-out invoke may
 * still have been accepted server-side, so the caller must not tell the user the command definitely did not start.
 * A timeout or rejection is logged with identifiers only (the payload carries the 15-minute interaction token).
 *
 * @param payload - The followup job.
 * @param startedAtMs - Epoch milliseconds when the handler was entered.
 * @returns `true` when the invoke was accepted in time, otherwise `false`.
 */
async function invokeFollowup(payload: FollowupPayload, startedAtMs: number): Promise<boolean> {
  const fnName = requireEnv('FOLLOWUP_LAMBDA_NAME');
  const controller = new AbortController();
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('followup invoke timed out')));
  });
  const timer = setTimeout(() => controller.abort(), followupInvokeBudgetMs(startedAtMs));
  try {
    await Promise.race([
      getLambdaClient().send(
        new InvokeCommand({
          FunctionName: fnName,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
        { abortSignal: controller.signal },
      ),
      timedOut,
    ]);
    return true;
  } catch (err) {
    console.error('Followup invoke failed', {
      error: errMessage(err),
      kind: payload.kind,
      game: payload.game,
      guildId: payload.guildId,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// @spec DISCORD-CMD-014
/** Hands the job to the followup Lambda and returns the deferred ack, or an ephemeral check-status notice when the hand-off fails or times out. */
async function deferToFollowup(payload: FollowupPayload, startedAtMs: number): Promise<APIGatewayProxyResultV2> {
  if (await invokeFollowup(payload, startedAtMs)) return ephemeralMessage('', true);
  return ephemeralMessage(
    'Could not confirm that the command was sent. It may already be starting: check `/server-status` before retrying.',
  );
}

/** Maximum age or lead, in seconds, of a signed interaction timestamp relative to the Lambda clock. */
const TIMESTAMP_FRESHNESS_WINDOW_SECONDS = 30;

/**
 * Reports whether a Discord `x-signature-timestamp` is within the freshness window.
 *
 * @remarks
 * Discord signs the timestamp with the body, so without this bound a captured request
 * stays replayable forever. The window applies symmetrically to past and future skew.
 * Call only on a signature-verified timestamp.
 *
 * @param timestamp - Raw header value; Discord sends Unix seconds as a decimal integer.
 * @param nowMs - Current time in epoch milliseconds.
 * @returns `true` when the timestamp is a non-negative integer within the window.
 */
function isTimestampFresh(timestamp: string, nowMs: number): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const skewSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (skewSeconds <= TIMESTAMP_FRESHNESS_WINDOW_SECONDS) return true;
  console.warn('Rejected interaction outside timestamp window', { skewSeconds: Math.round(skewSeconds) });
  return false;
}

// @spec DISCORD-AUTH-001, DISCORD-AUTH-003, DISCORD-AUTH-004, DISCORD-AUTH-005, DISCORD-AUTH-006, DISCORD-AUTH-007, DISCORD-CMD-001
// @spec DISCORD-CMD-012, DISCORD-CFG-006
/**
 * Entry point for every Discord HTTP interaction, fronted by a Lambda Function URL.
 * Verifies the Ed25519 signature against the public key in Secrets Manager (Discord
 * rejects any unverified reply, so this gate is mandatory), rejects timestamps more than
 * 30 seconds from the Lambda clock, and then either PONGs a
 * PING, answers autocomplete synchronously from the baked-in `GAME_NAMES` env var,
 * or deferred-acks a slash command (`type:5`) and async-invokes the followup Lambda
 * to do the slow ECS work within Discord's 3-second reply budget.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const startedAtMs = Date.now();
  const signature = event.headers?.['x-signature-ed25519'];
  const timestamp = event.headers?.['x-signature-timestamp'];
  if (!signature || !timestamp) return unauthorized();

  const rawBody = readRawBody(event);

  const publicKeySecretArn = requireEnv('DISCORD_PUBLIC_KEY_SECRET_ARN');
  const publicKey = await getPublicKey(publicKeySecretArn);
  if (!publicKey) return unauthorized();

  const ok = await verifySignature(publicKey, signature, timestamp, rawBody);
  if (!ok) return unauthorized();
  if (!isTimestampFresh(timestamp, Date.now())) return unauthorized();

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
    return handleApplicationCommand(interaction, cfg, startedAtMs);
  }

  return jsonResponse({ type: RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE, data: { content: 'Unsupported interaction type.', flags: EPHEMERAL } });
};
