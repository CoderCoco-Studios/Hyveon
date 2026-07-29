/**
 * Typed configuration model replacing `terraform.tfvars` as the app's
 * configuration source of truth (see the `migrate-iac-to-pulumi` OpenSpec
 * change). This is a NEW canonical model, not a mirror of the Terraform HCL
 * shape:
 *
 *  - Field names are idiomatic TS `camelCase` rather than HCL `snake_case`,
 *    EXCEPT for {@link DeploymentConfig.gameServers}, whose value type reuses
 *    {@link GameServerConfig} — the existing shared game-server shape (see
 *    `./tfvars.js`) already dictates `snake_case` field names
 *    (`container_path`, `connect_message`, `content_base64`) and is deeply
 *    embedded across `gameServerValidator.ts`, `hclEmit.ts`/`hclSurgeon.ts`,
 *    and the Games UI, so this model reuses it as-is rather than forking a
 *    parallel `camelCase` copy.
 *  - The model is plain data — every field is JSON-serializable (`string`,
 *    `number`, `boolean`, array, or plain object; no `Date`, `Map`, `Set`, or
 *    class instance) — because Phase 6 of the migration persists it verbatim
 *    as a JSON object in the operator's configuration S3 bucket, and the
 *    Pulumi program (Phase 3) reads it directly to derive resources.
 *  - It intentionally excludes every secret input. `discord_bot_token` and
 *    `discord_public_key` (`terraform/variables.tf`) are DROPPED, not
 *    ported — see the design doc's "Keep secrets out of the stack" decision.
 *    The app's `DiscordConfigService` already writes those two values to AWS
 *    Secrets Manager directly over the SDK, and the standing rule is that no
 *    secret is ever sent to the renderer or persisted outside Secrets
 *    Manager; giving them a home in this model would reopen that route.
 *
 * Field inventory: every field below (other than `gameServers`, whose
 * per-entry shape mirrors `terraform/variables.tf`'s `game_servers` object
 * type) mirrors a top-level Terraform variable that `terraform/main.tf`
 * passes into `module "cloud"` (`terraform/aws/variables.tf` is that
 * module's — and per `CLAUDE.md`'s invariants list, the app's — single
 * source of truth). Three root-only Terraform variables are deliberately
 * excluded because they never reach `module "cloud"` and describe bootstrap/
 * provider-selection concerns rather than deployment data:
 *  - `active_cloud` — selects which cloud module to instantiate; hardcoded
 *    to `'aws'` everywhere in the app today (see `ConfigService.getActiveCloud()`)
 *    since only one cloud provider is supported. Revisit when multi-cloud
 *    support lands.
 *  - `tfvars_bucket_name` — names the S3 bucket this very configuration
 *    object is expected to live in. Storing it *inside* the object it
 *    locates would be circular; Phase 6 (config store) resolves the bucket
 *    name through its own mechanism instead.
 *  - `tags` — applied via the root provider's `default_tags` block, never
 *    threaded through `module "cloud"` (`terraform/main.tf` does not pass it
 *    down); a resource-tagging concern for the Pulumi program to own
 *    directly (e.g. a fixed `Project=hyveon` tag set), not per-deployment
 *    operator input.
 */

import type { GameServerConfig } from './tfvars.js';

/**
 * Full deployment configuration: the top-level settings the Pulumi program
 * derives shared infrastructure from, plus the per-game map it iterates to
 * derive per-game resources. Persisted verbatim as JSON in the operator's
 * configuration S3 bucket (Phase 6) and edited via the renderer's Settings
 * and Games forms.
 */
export interface DeploymentConfig {
  /**
   * Project name used for resource naming (e.g. `${projectName}-audit`,
   * `${projectName}-tfvars`). Mirrors `project_name` in
   * `terraform/variables.tf`. Terraform default: `"hyveon"` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  projectName: string;

  /**
   * AWS region to deploy into (e.g. `"us-east-1"`). Mirrors `aws_region` in
   * `terraform/variables.tf`. Terraform default: `"us-east-1"` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  awsRegion: string;

  /**
   * CIDR block for the VPC (e.g. `"10.0.0.0/16"`). Mirrors `vpc_cidr` in
   * `terraform/aws/variables.tf`. Terraform default: `"10.0.0.0/16"` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  vpcCidr: string;

  /**
   * Route 53 hosted zone domain (must already exist, e.g. `"example.com"`).
   * Mirrors `hosted_zone_name` in `terraform/aws/variables.tf`. Has no
   * Terraform default — required in every deployment, so it has no entry in
   * {@link DEPLOYMENT_CONFIG_DEFAULTS} and {@link withDeploymentConfigDefaults}
   * requires it explicitly.
   */
  hostedZoneName: string;

  /**
   * TTL in seconds for DNS A records — kept low so updates propagate fast
   * after a server starts/stops. Mirrors `dns_ttl` in
   * `terraform/aws/variables.tf`. Terraform default: `30` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  dnsTtl: number;

  /**
   * How often the watchdog checks for idle servers, in minutes. Mirrors
   * `watchdog_interval_minutes` in `terraform/aws/variables.tf`. Terraform
   * default: `15` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}. Total idle time
   * before auto-shutdown is `watchdogIntervalMinutes * watchdogIdleChecks`.
   */
  watchdogIntervalMinutes: number;

  /**
   * Consecutive idle checks before auto-shutdown. Mirrors
   * `watchdog_idle_checks` in `terraform/aws/variables.tf`. Terraform
   * default: `4` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}. Total idle time
   * before auto-shutdown is `watchdogIntervalMinutes * watchdogIdleChecks`.
   */
  watchdogIdleChecks: number;

  /**
   * Minimum inbound packets per check interval to consider a server active.
   * Mirrors `watchdog_min_packets` in `terraform/aws/variables.tf`.
   * Terraform default: `100` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  watchdogMinPackets: number;

  /**
   * Guild IDs permanently allowlisted, written to the Terraform-managed
   * `BASE#discord` DynamoDB row on every deploy. This is an immutable floor
   * the management UI can never remove — operators can only add/remove
   * guilds they themselves added via the UI. Mirrors `base_allowed_guilds`
   * in `terraform/aws/variables.tf`. Terraform default: `[]` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  baseAllowedGuilds: string[];

  /**
   * Discord user IDs with permanent, server-wide admin privileges (bypass
   * per-game permission checks), written to the same `BASE#discord` row as
   * {@link baseAllowedGuilds}. Mirrors `base_admin_user_ids` in
   * `terraform/aws/variables.tf`. Terraform default: `[]` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  baseAdminUserIds: string[];

  /**
   * Discord role IDs with permanent, server-wide admin privileges, written
   * to the same `BASE#discord` row as {@link baseAllowedGuilds}. Mirrors
   * `base_admin_role_ids` in `terraform/aws/variables.tf`. Terraform
   * default: `[]` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  baseAdminRoleIds: string[];

  /**
   * Discord application (client) ID — a public value (goes to DynamoDB, not
   * Secrets Manager), unlike the bot token and public key which are
   * deliberately excluded from this model entirely (see the file-level
   * doc). Mirrors `discord_application_id` in `terraform/aws/variables.tf`.
   * Terraform default: `""` (empty until configured, either here or via the
   * web UI's Credentials tab) — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  discordApplicationId: string;

  /**
   * Name of the DynamoDB audit log table. Mirrors `audit_table_name` in
   * `terraform/aws/variables.tf`. Terraform default: `""`, which the
   * `aws` module resolves to `"${projectName}-audit"` when empty
   * (`terraform/aws/audit_store.tf`) — {@link withDeploymentConfigDefaults}
   * does NOT replicate that project-name-dependent computed default; it
   * leaves an omitted value as the literal empty string, matching the
   * Terraform variable's own default, and leaves resolving `""` to the
   * computed table name to the infrastructure program (Phase 3), the same
   * place Terraform itself did it.
   */
  auditTableName: string;

  /**
   * Name of the DynamoDB table holding Pulumi preview/apply run records.
   * Mirrors `runs_table_name` in `terraform/aws/variables.tf`. Terraform
   * default: `""`, resolved to `"${projectName}-runs"` when empty
   * (`terraform/aws/runs_store.tf`) — see {@link auditTableName}'s doc for
   * why {@link withDeploymentConfigDefaults} does not replicate that
   * resolution.
   */
  runsTableName: string;

  /**
   * Map of game name → container configuration, keyed the same way as
   * Terraform's `game_servers` variable (`terraform/aws/variables.tf`). Each
   * entry creates its own ECS task definition, EFS access point, log group,
   * and security-group rules; adding or removing an entry is the only edit
   * required to add or remove a game (`CLAUDE.md` invariant). Has no
   * Terraform default — required in every deployment (an empty object is a
   * legitimate "no games yet" state, but the key itself must be present),
   * so it has no entry in {@link DEPLOYMENT_CONFIG_DEFAULTS} and
   * {@link withDeploymentConfigDefaults} requires it explicitly. Reuses
   * {@link GameServerConfig} (`./tfvars.js`) — the existing shared
   * game-server shape — rather than a new parallel type; see the file-level
   * doc for why its field names stay `snake_case`.
   */
  gameServers: Record<string, GameServerConfig>;
}

/**
 * Every {@link DeploymentConfig} field that has a static Terraform default —
 * i.e. every field except {@link DeploymentConfig.hostedZoneName} and
 * {@link DeploymentConfig.gameServers} (both required, no Terraform default)
 * and {@link DeploymentConfig.auditTableName} /
 * {@link DeploymentConfig.runsTableName} (whose Terraform default is the
 * empty string, already representable without a lookup table — see their
 * field docs for why their *computed* fallback isn't replicated here).
 * Values are taken verbatim from `terraform/variables.tf` /
 * `terraform/aws/variables.tf`'s `default = ...` declarations.
 *
 * Consumed by {@link withDeploymentConfigDefaults}. Exported separately so
 * callers that only need to know a single default value (e.g. a form
 * placeholder) don't have to go through the helper.
 */
export const DEPLOYMENT_CONFIG_DEFAULTS: Readonly<
  Pick<
    DeploymentConfig,
    | 'projectName'
    | 'awsRegion'
    | 'vpcCidr'
    | 'dnsTtl'
    | 'watchdogIntervalMinutes'
    | 'watchdogIdleChecks'
    | 'watchdogMinPackets'
    | 'discordApplicationId'
    | 'auditTableName'
    | 'runsTableName'
  >
> = Object.freeze({
  projectName: 'hyveon',
  awsRegion: 'us-east-1',
  vpcCidr: '10.0.0.0/16',
  dnsTtl: 30,
  watchdogIntervalMinutes: 15,
  watchdogIdleChecks: 4,
  watchdogMinPackets: 100,
  discordApplicationId: '',
  auditTableName: '',
  runsTableName: '',
});

/**
 * Fills in every {@link DeploymentConfig} field that has a Terraform default
 * (see {@link DEPLOYMENT_CONFIG_DEFAULTS}) when the caller omits it, while
 * requiring {@link DeploymentConfig.hostedZoneName} and
 * {@link DeploymentConfig.gameServers} explicitly — both are required in
 * every real Terraform deployment (no `default = ...` in
 * `terraform/aws/variables.tf`), so silently defaulting them here would mask
 * an incomplete configuration rather than surface it.
 *
 * The three "base" allowlist/admin arrays (`baseAllowedGuilds`,
 * `baseAdminUserIds`, `baseAdminRoleIds`) are defaulted to a **freshly
 * allocated** empty array per call, deliberately NOT folded into
 * {@link DEPLOYMENT_CONFIG_DEFAULTS} — a shared frozen array reference would
 * still be safe to *read*, but keeping every default field resolution
 * uniform (computed inline here rather than split between a spread object
 * and special-cased array fields) is simpler to reason about and avoids ever
 * having to reconsider this if a future caller starts mutating the returned
 * config in place.
 *
 * @param partial - The caller-supplied fields. `hostedZoneName` and
 *   `gameServers` are required; every other {@link DeploymentConfig} field is
 *   optional and falls back to its Terraform default.
 * @returns A fully-populated {@link DeploymentConfig}.
 */
export function withDeploymentConfigDefaults(
  partial: Pick<DeploymentConfig, 'hostedZoneName' | 'gameServers'> & Partial<DeploymentConfig>,
): DeploymentConfig {
  return {
    projectName: partial.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName,
    awsRegion: partial.awsRegion ?? DEPLOYMENT_CONFIG_DEFAULTS.awsRegion,
    vpcCidr: partial.vpcCidr ?? DEPLOYMENT_CONFIG_DEFAULTS.vpcCidr,
    hostedZoneName: partial.hostedZoneName,
    dnsTtl: partial.dnsTtl ?? DEPLOYMENT_CONFIG_DEFAULTS.dnsTtl,
    watchdogIntervalMinutes: partial.watchdogIntervalMinutes ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogIntervalMinutes,
    watchdogIdleChecks: partial.watchdogIdleChecks ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogIdleChecks,
    watchdogMinPackets: partial.watchdogMinPackets ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogMinPackets,
    baseAllowedGuilds: partial.baseAllowedGuilds ?? [],
    baseAdminUserIds: partial.baseAdminUserIds ?? [],
    baseAdminRoleIds: partial.baseAdminRoleIds ?? [],
    discordApplicationId: partial.discordApplicationId ?? DEPLOYMENT_CONFIG_DEFAULTS.discordApplicationId,
    auditTableName: partial.auditTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.auditTableName,
    runsTableName: partial.runsTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.runsTableName,
    gameServers: partial.gameServers,
  };
}
