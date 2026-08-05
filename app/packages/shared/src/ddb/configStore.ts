import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { BaseDiscordConfig, DiscordConfig } from '../types.js';
import { asString, asStringArray, isSafeGameKey, sanitizeGamePermission } from '../sanitize.js';
import { getDocClient } from './client.js';

const CONFIG_PK = 'CONFIG#discord';
const CONFIG_SK = 'CONFIG';

const BASE_PK = 'BASE#discord';
const BASE_SK = 'BASE';

/** Empty, mutable DiscordConfig used when no item exists yet. */
function emptyConfig(): DiscordConfig {
  return {
    clientId: '',
    allowedGuilds: [],
    admins: { userIds: [], roleIds: [] },
    gamePermissions: {},
  };
}

/**
 * Coerce a stored `data` payload into a valid DiscordConfig, dropping
 * unexpected types the same way DiscordConfigService.load() used to do for
 * on-disk JSON. Runs on every read so hand-edited DynamoDB items can't crash
 * the Lambda.
 */
function parseConfigData(raw: unknown): DiscordConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawAdmins = (obj['admins'] ?? {}) as Record<string, unknown>;
  const rawGamePerms = (obj['gamePermissions'] ?? {}) as Record<string, unknown>;
  const gamePermissions: Record<string, ReturnType<typeof sanitizeGamePermission>> = {};
  for (const [game, perm] of Object.entries(rawGamePerms)) {
    if (isSafeGameKey(game)) gamePermissions[game] = sanitizeGamePermission(perm);
  }
  return {
    clientId: asString(obj['clientId']) ?? '',
    allowedGuilds: asStringArray(obj['allowedGuilds']),
    admins: {
      userIds: asStringArray(rawAdmins['userIds']),
      roleIds: asStringArray(rawAdmins['roleIds']),
    },
    gamePermissions,
  };
}

/** Empty base returned when no BASE#discord row exists (all lists default empty). */
function emptyBase(): BaseDiscordConfig {
  return { allowedGuilds: [], admins: { userIds: [], roleIds: [] } };
}

/**
 * Coerce the stored BASE#discord `data` payload into a valid BaseDiscordConfig.
 * Applies the same defensive sanitization as parseConfigData so hand-edited
 * items or a missing row don't crash callers.
 */
function parseBaseData(raw: unknown): BaseDiscordConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawAdmins = (obj['admins'] ?? {}) as Record<string, unknown>;
  return {
    allowedGuilds: asStringArray(obj['allowedGuilds']),
    admins: {
      userIds: asStringArray(rawAdmins['userIds']),
      roleIds: asStringArray(rawAdmins['roleIds']),
    },
  };
}

/**
 * Read the Pulumi-managed BASE#discord row (historically managed by the
 * app's original IaC tool). Returns an empty base when the row is absent (i.e. `baseAllowedGuilds`,
 * `baseAdminUserIds`, and `baseAdminRoleIds` are all unset on
 * {@link DeploymentConfig}).
 */
export async function getBaseDiscordConfig(tableName: string): Promise<BaseDiscordConfig> {
  const resp = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: BASE_PK, sk: BASE_SK },
      ConsistentRead: true,
    }),
  );
  if (!resp.Item) return emptyBase();
  return parseBaseData(resp.Item['data']);
}

/**
 * Read both the Pulumi-managed base row and the app-managed dynamic row, then
 * return their union as the effective config. This is what `canRun()` and
 * the Lambdas should use — it ensures base entries are always enforced even
 * when the dynamic row doesn't list them.
 */
export async function getEffectiveDiscordConfig(tableName: string): Promise<DiscordConfig> {
  const [dynamic, base] = await Promise.all([
    getDiscordConfig(tableName),
    getBaseDiscordConfig(tableName),
  ]);
  return {
    clientId: dynamic.clientId,
    allowedGuilds: [...new Set([...base.allowedGuilds, ...dynamic.allowedGuilds])],
    admins: {
      userIds: [...new Set([...base.admins.userIds, ...dynamic.admins.userIds])],
      roleIds: [...new Set([...base.admins.roleIds, ...dynamic.admins.roleIds])],
    },
    gamePermissions: dynamic.gamePermissions,
  };
}

/** Read the single DiscordConfig row; returns an empty config if the item is absent. */
export async function getDiscordConfig(tableName: string): Promise<DiscordConfig> {
  const resp = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: CONFIG_PK, sk: CONFIG_SK },
      ConsistentRead: true,
    }),
  );
  if (!resp.Item) return emptyConfig();
  return parseConfigData(resp.Item['data']);
}

/** Overwrite the single DiscordConfig row. */
export async function putDiscordConfig(tableName: string, cfg: DiscordConfig): Promise<void> {
  await getDocClient().send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: CONFIG_PK,
        sk: CONFIG_SK,
        data: cfg,
        updatedAt: Date.now(),
      },
    }),
  );
}
