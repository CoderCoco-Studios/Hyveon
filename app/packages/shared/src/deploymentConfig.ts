/**
 * Typed configuration model that is the app's configuration source of truth
 * (`DeploymentConfig.gameServers` — and by extension this whole model — per
 * `CLAUDE.md`'s invariants list). Three constraints are load-bearing:
 *
 *  - Field names are idiomatic TS `camelCase`, EXCEPT for
 *    {@link DeploymentConfig.gameServers}, whose value type deliberately reuses
 *    {@link GameServerConfig}'s `snake_case` fields (`container_path`,
 *    `connect_message`, `content_base64`) — that shape is already deeply
 *    embedded across `gameServerValidator.ts`, `DeploymentConfigService.ts`'s
 *    JSON read/write paths, and the Games UI, so this model reuses it as-is
 *    rather than forking a parallel `camelCase` copy.
 *  - The model is plain data — every field must stay JSON-serializable
 *    (`string`, `number`, `boolean`, array, or plain object; no `Date`,
 *    `Map`, `Set`, or class instance) — because it is persisted verbatim as a
 *    JSON object in the operator's configuration S3 bucket, and the Pulumi
 *    program reads it directly to derive resources.
 *  - Secrets are deliberately excluded and must never be added back:
 *    `DiscordConfigService` writes bot-token/public-key values to AWS
 *    Secrets Manager directly, and no secret may ever be persisted outside
 *    Secrets Manager or sent to the renderer.
 */

import type { GameServerConfig } from './gameServerConfig.js';
import type { RemoteFileStore } from './cloud.js';

/**
 * S3 object key the canonical {@link DeploymentConfig} JSON is stored under
 * inside the operator's configuration bucket. Shared by `DeploymentConfigService`
 * (desktop-main) and `PulumiService`'s rollback flow (#112) — both derive
 * the object key from this single constant rather than a filesystem path's
 * `basename()`. A fixed constant means an env-var override to a local path
 * can never silently change the S3 key a deployment uses.
 */
export const CONFIGURATION_OBJECT_KEY = 'deployment-config.json';

/**
 * Full deployment configuration: the top-level settings the Pulumi program
 * derives shared infrastructure from, plus the per-game map it iterates to
 * derive per-game resources. Persisted verbatim as JSON in the operator's
 * configuration S3 bucket and edited via the renderer's Settings and Games
 * forms.
 */
export interface DeploymentConfig {
  /**
   * Project name used for resource naming (e.g. `${projectName}-audit`,
   * `${projectName}-config`). Mirrors the app's original `project_name`
   * config input. Default: `"hyveon"` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  projectName: string;

  /**
   * AWS region to deploy into (e.g. `"us-east-1"`). Mirrors the app's
   * original `aws_region` config input. Default: `"us-east-1"` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  awsRegion: string;

  /**
   * CIDR block for the VPC (e.g. `"10.0.0.0/16"`). Mirrors the app's
   * original `vpc_cidr` config input. Default: `"10.0.0.0/16"` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  vpcCidr: string;

  /**
   * Route 53 hosted zone domain (must already exist, e.g. `"example.com"`).
   * Mirrors the app's original `hosted_zone_name` config input. Had no
   * default in that setup either — required in every deployment, so it has
   * no entry in {@link DEPLOYMENT_CONFIG_DEFAULTS} and
   * {@link withDeploymentConfigDefaults} requires it explicitly.
   */
  hostedZoneName: string;

  /**
   * TTL in seconds for DNS A records — kept low so updates propagate fast
   * after a server starts/stops. Mirrors the app's original `dns_ttl`
   * config input. Default: `30` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  dnsTtl: number;

  /**
   * How often the watchdog checks for idle servers, in minutes. Mirrors
   * the app's original `watchdog_interval_minutes` config input. Default:
   * `15` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}. Total idle time before
   * auto-shutdown is `watchdogIntervalMinutes * watchdogIdleChecks`.
   */
  watchdogIntervalMinutes: number;

  /**
   * Consecutive idle checks before auto-shutdown. Mirrors the app's
   * original `watchdog_idle_checks` config input. Default: `4` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}. Total idle time before
   * auto-shutdown is `watchdogIntervalMinutes * watchdogIdleChecks`.
   */
  watchdogIdleChecks: number;

  /**
   * Minimum inbound packets per check interval to consider a server active.
   * Mirrors the app's original `watchdog_min_packets` config input.
   * Default: `100` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  watchdogMinPackets: number;

  /**
   * Guild IDs permanently allowlisted, written to the
   * `BASE#discord` DynamoDB row on every deploy. This is an immutable floor
   * the management UI can never remove — operators can only add/remove
   * guilds they themselves added via the UI. Mirrors the app's original
   * `base_allowed_guilds` config input. Default: `[]` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  baseAllowedGuilds: string[];

  /**
   * Discord user IDs with permanent, server-wide admin privileges (bypass
   * per-game permission checks), written to the same `BASE#discord` row as
   * {@link baseAllowedGuilds}. Mirrors the app's original
   * `base_admin_user_ids` config input. Default: `[]` — see
   * {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  baseAdminUserIds: string[];

  /**
   * Discord role IDs with permanent, server-wide admin privileges, written
   * to the same `BASE#discord` row as {@link baseAllowedGuilds}. Mirrors
   * the app's original `base_admin_role_ids` config input. Default:
   * `[]` — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  baseAdminRoleIds: string[];

  /**
   * Discord application (client) ID — a public value (goes to DynamoDB, not
   * Secrets Manager), unlike the bot token and public key which are
   * deliberately excluded from this model entirely (see the file-level
   * doc). Mirrors the app's original `discord_application_id` config
   * input. Default: `""` (empty until configured, either here or via the
   * web UI's Credentials tab) — see {@link DEPLOYMENT_CONFIG_DEFAULTS}.
   */
  discordApplicationId: string;

  /**
   * Name of the DynamoDB audit log table. Mirrors the app's original
   * `audit_table_name` config input. Default: `""`, which the app's
   * original AWS module used to resolve to `"${projectName}-audit"` when
   * empty — {@link withDeploymentConfigDefaults} does NOT replicate that
   * project-name-dependent computed default; it leaves an omitted value as
   * the literal empty string, matching that original input's own default,
   * and leaves resolving `""` to the computed table name to the
   * infrastructure program, the same place that resolution used to happen.
   */
  auditTableName: string;

  /**
   * Name of the DynamoDB table holding Pulumi preview/apply run records.
   * Mirrors the app's original `runs_table_name` config input. Default:
   * `""`, resolved to `"${projectName}-runs"` when empty — see
   * {@link auditTableName}'s doc for why {@link withDeploymentConfigDefaults}
   * does not replicate that resolution.
   *
   * @remarks
   * Unlike {@link auditTableName}, this table is NOT declared as a Pulumi
   * resource (`@hyveon/infra`'s `dynamodb.ts`) — it is created via the AWS
   * SDK directly at first-run-wizard bootstrap time, before any
   * `DeploymentConfig` (and therefore before any Pulumi apply) can exist, so
   * that the app's own run-history table is never itself gated behind a
   * Pulumi apply it needs to already exist to record (see the
   * `migrate-iac-to-pulumi` change's bootstrap-deadlock fix). Use
   * {@link resolveRunsTableName} to compute this field's effective value —
   * both `BootstrapService.ensureRunsTable` (desktop-main) and
   * `@hyveon/infra`'s stack-output computation call it, so the two never
   * disagree on the table's name.
   */
  runsTableName: string;

  /**
   * Map of game name → container configuration, keyed the same way as the
   * app's original per-game config input. Each entry creates its own ECS
   * task definition, EFS access point, log group, and security-group
   * rules; adding or removing an entry is the only edit required to add or
   * remove a game (`CLAUDE.md` invariant). Had no default in that original
   * setup either — required in every deployment (an empty object is a
   * legitimate "no games yet" state, but the key itself must be present),
   * so it has no entry in {@link DEPLOYMENT_CONFIG_DEFAULTS} and
   * {@link withDeploymentConfigDefaults} requires it explicitly. Reuses
   * {@link GameServerConfig} (`./gameServerConfig.js`) — the existing shared
   * game-server shape — rather than a new parallel type; see the file-level
   * doc for why its field names stay `snake_case`.
   */
  gameServers: Record<string, GameServerConfig>;
}

/**
 * Every top-level {@link DeploymentConfig} field EXCEPT `gameServers` — the
 * exact slice the operator edits from the Settings page's
 * deployment-settings form, via
 * `DeploymentConfigService.getTopLevelSettings`/`updateTopLevelSettings`
 * (`@hyveon/desktop-main`) and the `iac.settings.get`/`iac.settings.update`
 * IPC channels. Deliberately excludes `gameServers` — that map has its own
 * dedicated add-game-wizard/edit-game-form flow (`games.create`/`games.update`/
 * `games.delete`) and is never touched by the settings form.
 *
 * Re-exported from `@hyveon/desktop-preload/hyveon-api` rather than
 * hand-duplicated there, matching `ChangeSummary`'s re-export pattern.
 */
export type TopLevelDeploymentSettings = Omit<DeploymentConfig, 'gameServers'>;

/**
 * Every {@link DeploymentConfig} field that (a) has a static default AND (b) is safe to expose as
 * a single shared frozen constant value. {@link DeploymentConfig.hostedZoneName} and
 * {@link DeploymentConfig.gameServers} are excluded (no static default; required in every real
 * deployment). {@link DeploymentConfig.baseAllowedGuilds}/`baseAdminUserIds`/`baseAdminRoleIds`
 * are also excluded despite having a `[]` default: a frozen array stored here would be a single
 * shared reference every caller received unless defensively cloned, so
 * {@link withDeploymentConfigDefaults} allocates a **fresh** empty array per call for those three
 * instead of sourcing them from this constant.
 *
 * Consumed by {@link withDeploymentConfigDefaults}. Exported separately so callers that only need
 * a single default value (e.g. a form placeholder) don't have to go through the helper.
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
 * Resolves {@link DeploymentConfig.runsTableName}'s effective table name. Exported so
 * `BootstrapService.ensureRunsTable`, `@hyveon/infra`, and `RunRecordService` never fork this
 * ternary — all three must compute the exact same value: the former two directly, and
 * `RunRecordService` via {@link resolvePreApplyRunsTableName}.
 *
 * @param projectName - {@link DeploymentConfig.projectName}.
 * @param runsTableNameOverride - {@link DeploymentConfig.runsTableName} (the
 *   raw, possibly-empty override).
 * @returns The resolved table name.
 */
export function resolveRunsTableName(projectName: string, runsTableNameOverride: string): string {
  return runsTableNameOverride !== '' ? runsTableNameOverride : `${projectName}-runs`;
}

/**
 * Pre-apply fallback for the runs table's name: reads the persisted
 * {@link DeploymentConfig} JSON document directly via `remoteFileStore` and
 * resolves its effective `runsTableName` via {@link resolveRunsTableName} —
 * without ever consulting a Pulumi stack output. This is what makes the
 * bootstrap-deadlock fix actually work end to end: a Pulumi stack only ever
 * reports outputs after its first successful `apply` (see
 * `PulumiService.getStackOutputs`'s own TSDoc, "Empty outputs also degrades
 * to null"), but `RunRecordService`'s approve/apply gates run on the very
 * FIRST plan/apply cycle, before that has ever happened — this function lets
 * those gates compute the table's deterministic name directly from the
 * configuration document instead of waiting on a completed deploy.
 *
 * Never throws — every failure mode (`CONFIGURATION_OBJECT_KEY` object
 * doesn't exist yet, malformed JSON, `remoteFileStore.get()` itself
 * rejects/throws) is treated identically as "the configuration isn't ready
 * yet", which is exactly the state every one of this function's callers
 * already degrades gracefully for.
 *
 * @param remoteFileStore - The configuration bucket's `RemoteFileStore`
 *   (already bound to the operator's configured bucket by the caller).
 * @returns The resolved runs table name, or `undefined` if the configuration
 *   document isn't readable yet.
 */
export async function resolvePreApplyRunsTableName(remoteFileStore: RemoteFileStore): Promise<string | undefined> {
  try {
    const obj = await remoteFileStore.get(CONFIGURATION_OBJECT_KEY);
    if (!obj) return undefined;
    const parsed = JSON.parse(new TextDecoder().decode(obj.body)) as Partial<DeploymentConfig>;
    return resolveRunsTableName(parsed.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName, parsed.runsTableName ?? '');
  } catch {
    return undefined;
  }
}

/**
 * Fills in every {@link DeploymentConfig} field that has a static default
 * (see {@link DEPLOYMENT_CONFIG_DEFAULTS}) when the caller omits it, while
 * requiring {@link DeploymentConfig.hostedZoneName} and
 * {@link DeploymentConfig.gameServers} explicitly — both were required in
 * every real deployment under the app's original config setup too (neither
 * had a declared default there), so silently defaulting them here would
 * mask an incomplete configuration rather than surface it.
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
 *   optional and falls back to its static default.
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

/**
 * Every top-level {@link DeploymentConfig} field EXCEPT `gameServers`, which
 * gets its own dedicated added/removed/changed breakdown in
 * {@link DeploymentConfigDiff.gameServers} rather than being lumped in with
 * scalar/array field names.
 */
type DeploymentConfigScalarField = keyof Omit<DeploymentConfig, 'gameServers'>;

/**
 * Structural, best-effort summary of how one {@link DeploymentConfig}
 * differs from another — built for the `iac-rollback` confirmation dialog, so
 * an operator rolling back to a historic configuration version sees more
 * than an opaque version id: which
 * top-level settings changed, and which game servers were added, removed, or
 * changed. Deliberately NOT a rich/recursive diff — no per-field before/after
 * values, no nested-path granularity within a single `gameServers` entry.
 * The operator can inspect the actual restored configuration after rollback
 * for that level of detail (see {@link diffDeploymentConfig}'s TSDoc,
 * "Scope").
 */
export interface DeploymentConfigDiff {
  /**
   * Names of every top-level scalar/array field (i.e. every
   * {@link DeploymentConfig} key except `gameServers`) whose value differs
   * between the two configs being compared. Order matches
   * {@link DeploymentConfig}'s own field declaration order.
   */
  changedFields: DeploymentConfigScalarField[];
  /** Per-key breakdown of how the `gameServers` maps differ. */
  gameServers: {
    /** Game keys present in `current` but not `previous`. */
    added: string[];
    /** Game keys present in `previous` but not `current`. */
    removed: string[];
    /** Game keys present in both, with a different entry value. */
    changed: string[];
  };
}

/**
 * The {@link DeploymentConfig} field order {@link diffDeploymentConfig}
 * walks to build {@link DeploymentConfigDiff.changedFields} — kept as an
 * explicit list (rather than `Object.keys()` on one of the two configs
 * being compared) so the result is deterministic and complete even when one
 * side is missing a field the other has (e.g. an older historic version
 * predating a field that was added later), and so its order never depends on
 * which of the two arguments happens to declare its keys first.
 */
const DEPLOYMENT_CONFIG_SCALAR_FIELDS: DeploymentConfigScalarField[] = [
  'projectName',
  'awsRegion',
  'vpcCidr',
  'hostedZoneName',
  'dnsTtl',
  'watchdogIntervalMinutes',
  'watchdogIdleChecks',
  'watchdogMinPackets',
  'baseAllowedGuilds',
  'baseAdminUserIds',
  'baseAdminRoleIds',
  'discordApplicationId',
  'auditTableName',
  'runsTableName',
];

/**
 * Compares two values for {@link diffDeploymentConfig}'s purposes. Scalars
 * (`string`/`number`/`boolean`) compare with `!==`; everything else (arrays
 * like {@link DeploymentConfig.baseAllowedGuilds}, and `gameServers` entry
 * objects) compares via `JSON.stringify` equality.
 *
 * `JSON.stringify` equality is a structural comparison, not a deep
 * value-equality one: it is sensitive to key order within an object (e.g.
 * `{a:1,b:2}` and `{b:2,a:1}` stringify to different strings and would be
 * reported as "changed" despite being the same value). For this function's
 * purpose — a best-effort rollback-confirmation SUMMARY, not a precise
 * patch — that false-positive rate is an acceptable tradeoff: it can only
 * ever report a field as changed when it wasn't (never miss a real change,
 * since two values that stringify identically ARE structurally identical),
 * and every {@link DeploymentConfig} field this function compares this way
 * is either a flat array of primitives (order-sensitive key ordering isn't a
 * concern — arrays don't have "key order" the way objects do) or a
 * `GameServerConfig` object written exclusively by this app's own JSON
 * serialization (`DeploymentConfigService`'s write path), which produces consistent
 * key order across writes rather than an externally-authored document with
 * arbitrary key ordering.
 */
function valuesDiffer(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return a !== b;
  }
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Compares two parsed {@link DeploymentConfig} objects and returns a
 * structural summary of how they differ, for the `iac-rollback` confirmation
 * dialog. Pure and synchronous: takes two already-parsed configs, does no
 * I/O, and never throws for any two well-formed {@link DeploymentConfig}
 * values (every field it reads is optional-safe — see
 * {@link valuesDiffer}).
 *
 * ## Scope
 *
 * Reports WHICH top-level fields changed and WHICH game server keys were
 * added/removed/changed — not the before/after values themselves, and not a
 * nested field-level breakdown within a single changed `gameServers` entry
 * (e.g. "minecraft's `cpu` changed from 2048 to 4096" is out of scope; only
 * "minecraft changed" is reported). This is deliberate: the caller
 * (`RollbackAction`'s confirmation dialog) needs a scannable summary before
 * the operator commits to the rollback, not a rich diff viewer — the
 * operator can inspect the actual restored configuration after rollback for
 * full detail.
 *
 * ## Comparison strategy
 *
 * Scalar fields (`string`/`number`/`boolean`) compare with `!==`. Array
 * fields (`baseAllowedGuilds`, `baseAdminUserIds`, `baseAdminRoleIds`) and
 * `gameServers` entry values compare via `JSON.stringify` equality — see
 * {@link valuesDiffer}'s own TSDoc for the full key-order-sensitivity
 * rationale.
 *
 * @param previous - The earlier configuration (e.g. the historic rollback
 *   target).
 * @param current - The later configuration (e.g. the current head) to
 *   compare `previous` against.
 * @returns A {@link DeploymentConfigDiff} — every array is empty and
 *   `changedFields` is `[]` when the two configs are identical by this
 *   function's comparison strategy.
 */
export function diffDeploymentConfig(previous: DeploymentConfig, current: DeploymentConfig): DeploymentConfigDiff {
  const changedFields = DEPLOYMENT_CONFIG_SCALAR_FIELDS.filter((field) => valuesDiffer(previous[field], current[field]));

  const previousGameServers = previous.gameServers ?? {};
  const currentGameServers = current.gameServers ?? {};
  const previousKeys = new Set(Object.keys(previousGameServers));
  const currentKeys = new Set(Object.keys(currentGameServers));

  const added = [...currentKeys].filter((key) => !previousKeys.has(key));
  const removed = [...previousKeys].filter((key) => !currentKeys.has(key));
  const changed = [...previousKeys].filter(
    (key) => currentKeys.has(key) && valuesDiffer(previousGameServers[key], currentGameServers[key]),
  );

  return { changedFields, gameServers: { added, removed, changed } };
}
