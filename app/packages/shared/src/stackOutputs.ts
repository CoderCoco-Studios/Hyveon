/**
 * Typed contract for the values `PulumiService` (a `@hyveon/desktop-main`
 * service) reads back off a deployed Pulumi stack, in place of the app's
 * original config-reading method's parse of its old state file. This module
 * defines the TYPE ONLY — no reading/parsing logic lives here; `PulumiService`
 * owns turning a stack's `outputs` map into a {@link StackOutputs} value.
 *
 * Field inventory: every field is an output the app actually reads today via
 * `ConfigService.getStackOutputs()` and its consumers (`EcsService`,
 * `FileManagerService`, `DriftService`, `discord.controller.ts`,
 * `AwsDiscordEventReceiver`) — confirmed by grepping every consumer's field
 * accesses against the full output list. Each one historically mirrored an
 * output declared by the app's original, now fully retired IaC tool (the
 * same declarations were re-exported unchanged at that tool's root level);
 * the same field set is now emitted by the Pulumi program instead
 * (`@hyveon/infra`'s `program.ts`, `buildStackOutputs`). Six declared
 * outputs from that original tool were deliberately NOT carried forward
 * because no consumer reads them today:
 * `vpc_id`, `task_definitions`, `hosted_zone_id`, `dns_records`,
 * `watchdog_function_name`, and the root-only bucket-name output (whose
 * bucket-naming role the configuration store resolves independently — see
 * `deploymentConfig.js`'s file doc for the parallel exclusion on the input
 * side). Add a field here when a consumer needs one.
 *
 * Naming and data-shape conventions match `deploymentConfig.js`: idiomatic
 * `camelCase` field names (this is a new canonical type, not a literal
 * mirror of the original tool's output keys), and plain, JSON-serializable
 * data (no `Date`, `Map`, `Set`, or class instances) throughout.
 */

import type { GameServerConfig } from './gameServerConfig.js';

/**
 * Every value the app reads off a deployed Pulumi stack. `PulumiService`
 * returns this shape (or `null` for a never-deployed stack, mirroring
 * `ConfigService.getStackOutputs()`'s "not deployed yet" contract) in
 * place of parsing the app's original state-file format.
 */
export interface StackOutputs {
  /**
   * AWS region the stack is deployed into. Mirrors the original `aws_region`
   * output, itself echoing the `aws_region` input variable. Consumed by
   * `ConfigService.getRegion()` as the preferred region source for AWS SDK
   * clients.
   */
  awsRegion: string;

  /** ECS cluster name. Mirrors the `ecs_cluster_name` output. */
  ecsClusterName: string;

  /** ECS cluster ARN. Mirrors the `ecs_cluster_arn` output. */
  ecsClusterArn: string;

  /**
   * Public subnet IDs the game-server and file-manager tasks run in.
   * Mirrors the `subnet_ids` output — an array here rather than the
   * original tool's comma-joined string, since this is a new canonical
   * type with no legacy-format constraint: `FileManagerService` and every
   * other consumer read the array directly, with no `,`-splitting step.
   */
  subnetIds: string[];

  /** Security group ID for game server tasks. Mirrors the `security_group_id` output. */
  securityGroupId: string;

  /** Security group ID for FileBrowser file-manager tasks. Mirrors the `file_manager_security_group_id` output. */
  fileManagerSecurityGroupId: string;

  /** EFS file system ID backing persistent game saves. Mirrors the `efs_file_system_id` output. */
  efsFileSystemId: string;

  /**
   * Map of game name → that game's first volume's EFS access point ID.
   * Mirrors the `efs_access_points` output. Consumed by `FileManagerService`
   * to mount the correct access point per game.
   */
  efsAccessPoints: Record<string, string>;

  /** Base domain name (the configured hosted zone). Mirrors the `domain_name` output. */
  domainName: string;

  /** Every configured game server name. Mirrors the `game_names` output. */
  gameNames: string[];

  /** DynamoDB table holding `DiscordConfig` and pending interactions. Mirrors the `discord_table_name` output. */
  discordTableName: string;

  /** DynamoDB table holding audit log entries. Mirrors the `audit_table_name` output. */
  auditTableName: string;

  /**
   * DynamoDB table holding Pulumi preview/apply run records. Mirrors the
   * `runs_table_name` output. Unlike every other field here, this is a plain
   * config echo (`resolveRunsTableName(projectName, runsTableName)` in
   * `deploymentConfig.js`), not a value derived from a Pulumi resource — the
   * runs table itself is bootstrap-managed (created via the AWS SDK before
   * any apply ever runs), not Pulumi-managed. See `DeploymentConfig.runsTableName`'s
   * doc for why.
   */
  runsTableName: string;

  /**
   * Secrets Manager ARN for the Discord bot token. A location, not the
   * secret value itself — safe to include despite the config-model-side
   * exclusion of the bot token as an input (see `deploymentConfig.js`'s file
   * doc). Mirrors the `discord_bot_token_secret_arn` output.
   */
  discordBotTokenSecretArn: string;

  /**
   * Secrets Manager ARN for the Discord application Ed25519 public key. A
   * location, not the secret value itself — see
   * {@link discordBotTokenSecretArn}'s doc for why this is safe to include.
   * Mirrors the `discord_public_key_secret_arn` output.
   */
  discordPublicKeySecretArn: string;

  /**
   * Secrets Manager ARN for the FileBrowser helper's per-launch credential
   * hash. A location, not the secret value itself — see
   * {@link discordBotTokenSecretArn}'s doc for why this is safe to include.
   * `FileManagerService` writes a fresh bcrypt hash here on every launch (one
   * shared secret, not per-game — see `secrets.ts`'s file doc for why a
   * single secret is enough for an ephemeral, always-rotated credential).
   */
  fileBrowserCredentialSecretArn: string;

  /**
   * IAM role ARN that EventBridge Scheduler assumes to invoke `ecs:StopTask`
   * for the FileBrowser helper's auto-stop schedule. Trust-scoped to
   * `scheduler.amazonaws.com`, permissioned only for `ecs:StopTask` on the
   * deployed cluster — see `iam.ts`'s `fileBrowserSchedulerRole`.
   */
  fileBrowserSchedulerRoleArn: string;

  /**
   * URL to paste into the Discord Developer Portal's "Interactions Endpoint
   * URL" field. Mirrors the `interactions_invoke_url` output. `null` when
   * absent from the stack's outputs (e.g. state predates this output).
   */
  interactionsInvokeUrl: string | null;

  /**
   * Custom-domain URL for the Discord interactions endpoint. Mirrors the
   * `discord_interactions_url` output — a second, `discord.<domain>`-rooted
   * URL alongside {@link interactionsInvokeUrl} (the two already overlapped
   * in the app's original, retired IaC module; carried forward as-is for
   * consumer parity). `null` when absent from the stack's outputs.
   */
  discordInteractionsUrl: string | null;

  /**
   * Full per-game `game_servers` configuration as last applied to the stack,
   * keyed by game name — used for drift detection (`DriftService`):
   * field-by-field comparison against the currently declared configuration.
   * Mirrors the `applied_game_servers` output. `null` when absent (e.g. no
   * apply has run since this output was introduced, or nothing has been
   * deployed yet). Reuses {@link GameServerConfig} (`./gameServerConfig.js`), matching
   * {@link DeploymentConfig.gameServers}'s value type so drift comparisons
   * are structurally directly comparable.
   */
  appliedGameServers: Record<string, GameServerConfig> | null;
}
