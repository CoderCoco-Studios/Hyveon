/** Slash-command action that can be gated via permissions. */
export type DiscordAction = 'start' | 'stop' | 'status';

/**
 * Permission entry for a single game: which users/roles may invoke which
 * actions. All three lists are independent — having a user ID listed doesn't
 * grant anything unless the corresponding action is also in `actions`.
 */
export interface DiscordGamePermission {
  userIds: string[];
  roleIds: string[];
  actions: DiscordAction[];
}

/** Server-wide admin lists. Admins bypass per-game permission checks. */
export interface DiscordAdmins {
  userIds: string[];
  roleIds: string[];
}

/**
 * Discord config persisted in DynamoDB.
 *
 * The bot token and application public key do NOT live here — they are in
 * AWS Secrets Manager and referenced by secret ARN via Lambda/app env vars.
 */
export interface DiscordConfig {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
}

/**
 * Pulumi-managed baseline (historically Terraform-managed) stored in the
 * BASE#discord DynamoDB row.
 *
 * These entries form a read-only floor: the management UI can never remove
 * them (only a Pulumi apply can). The effective config seen by `canRun()`
 * and the Lambdas is the union of this base and the dynamic CONFIG#discord row.
 */
export interface BaseDiscordConfig {
  allowedGuilds: string[];
  admins: DiscordAdmins;
}

/** Config shape returned to the web client — includes secret-presence flags, never the secret values. */
export interface RedactedDiscordConfig {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
  /** Guild IDs locked in by the deploy — shown as non-removable in the UI. */
  baseAllowedGuilds: string[];
  /** Admin user/role IDs locked in by the deploy — shown as non-removable in the UI. */
  baseAdmins: DiscordAdmins;
  botTokenSet: boolean;
  publicKeySet: boolean;
}

/** Game status reported via `/server-status`, `/server-list`, and the web UI. */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/** Outcome of a start/stop invocation. */
export interface StartResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/**
 * Row in the pending-interactions partition keyed by ECS task ARN. Written by
 * the followup Lambda after a successful `RunTask`; consumed by the update-dns
 * Lambda when the corresponding task reaches RUNNING so it can PATCH the
 * original Discord interaction with the final hostname/IP.
 */
export interface PendingInteraction {
  taskArn: string;
  applicationId: string;
  interactionToken: string;
  userId: string;
  guildId: string;
  game: string;
  action: DiscordAction;
  expiresAt: number;
}
