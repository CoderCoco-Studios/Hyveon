/**
 * Imperative-escape resources: infrastructure whose declaration reaches
 * beyond pure declarative management — seeding a mutable DynamoDB row, or
 * invoking a deployed Lambda as a one-shot build step. Declares the two
 * conditional Discord table rows and the per-game EFS-seeder invocation; the
 * Discord secret versions are a third instance, implemented in `secrets.ts`
 * alongside the secrets they version.
 *
 * `discordConfigSeedItem` carries `ignoreChanges: ['item']` so the
 * management app's own writes to the `CONFIG#discord` row are never reverted
 * by a later `pulumi up`. `discordBaseConfigItem` carries no such option —
 * it is recomputed from `baseAllowedGuilds`/`baseAdminUserIds`/
 * `baseAdminRoleIds` on every deploy, by design (an immutable floor the
 * management UI can never remove — see `deploymentConfig.ts`).
 *
 * Each EFS-seeder invocation's `triggers.seedsHash` is a content hash of
 * that game's `file_seeds`, so it re-runs iff the seed content changes. Each
 * invocation also carries an explicit `dependsOn` on `efsSeederPolicies[game]`
 * — `lambdas.ts`'s IAM policies attach after the Lambda functions they
 * target, so this dependency has no automatic edge otherwise.
 *
 * Discord slash-command auto-registration has no Pulumi analogue: it would
 * need the live bot token as an input, which this program's "no secret
 * material enters the stack" requirement forbids. An operator instead clicks
 * "Register commands" in the Discord settings page once per base guild
 * (`desktop-main/src/services/DiscordCommandRegistrar.ts`).
 */

import * as crypto from 'node:crypto';
import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';

/** The two conditional Discord table rows {@link defineDiscordTableItems} declares — see this file's doc for the full HCL→Pulumi address table. */
export interface DiscordTableItemResources {
  /**
   * The `BASE#discord` row (`aws_dynamodb_table_item.discord_base_config`).
   * `undefined` when `baseAllowedGuilds`, `baseAdminUserIds`, and
   * `baseAdminRoleIds` are all empty — mirrors the HCL's
   * `count = (length(...) + length(...) + length(...)) > 0 ? 1 : 0` guard.
   */
  discordBaseConfigItem: aws.dynamodb.TableItem | undefined;
  /**
   * The `CONFIG#discord` row (`aws_dynamodb_table_item.discord_config_seed`).
   * `undefined` when `discordApplicationId` is empty — mirrors the HCL's
   * `count = var.discord_application_id != "" ? 1 : 0` guard.
   */
  discordConfigSeedItem: aws.dynamodb.TableItem | undefined;
}

/** Arguments {@link defineDiscordTableItems} needs to declare the two conditional Discord table rows. */
export interface DefineDiscordTableItemsArgs {
  /** Mirrors `var.project_name` — every item's Pulumi logical name below is `${projectName}-...`, matching this package's naming convention. */
  projectName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
  /** The Discord table (`dynamodb.ts`'s `DynamoDbResources.discordTable`) both rows are written into. */
  discordTable: aws.dynamodb.Table;
  /** Mirrors `var.base_allowed_guilds` (`DeploymentConfig.baseAllowedGuilds`) — contributes to {@link DiscordTableItemResources.discordBaseConfigItem}'s presence guard and its `allowedGuilds` list. */
  baseAllowedGuilds: string[];
  /** Mirrors `var.base_admin_user_ids` (`DeploymentConfig.baseAdminUserIds`). */
  baseAdminUserIds: string[];
  /** Mirrors `var.base_admin_role_ids` (`DeploymentConfig.baseAdminRoleIds`). */
  baseAdminRoleIds: string[];
  /** Mirrors `var.discord_application_id` (`DeploymentConfig.discordApplicationId`) — controls {@link DiscordTableItemResources.discordConfigSeedItem}'s presence guard and its `clientId`. */
  discordApplicationId: string;
}

/**
 * Builds the `pulumi.CustomResourceOptions` for this file's two resources
 * that need more than the bare `{ provider }` option: the
 * `discord_config_seed` item's create-only `ignoreChanges: ['item']`, and
 * each EFS-seeder invocation's required `dependsOn: [policy]` edge — see this
 * file's doc for both rationales.
 *
 * Exposed as methods on an exported object, not bare functions, so a spec
 * can `vi.spyOn(escapeResourceOptions, 'forDiscordConfigSeedItem')` /
 * `vi.spyOn(escapeResourceOptions, 'forEfsSeederInvocation')` and assert
 * that {@link defineDiscordTableItems}/{@link defineEfsSeederInvocations}
 * actually call these functions at each resource's construction site.
 * Pulumi's mock test harness (`testing/pulumiMocks.ts`) does not expose
 * `ignoreChanges` or `dependsOn` to a `newResource` mock callback, so there
 * is no way to assert either option's presence by inspecting a recorded
 * resource the way other tests in this package do — the spy is the only way
 * to catch a future edit that quietly reverts a call site back to plain
 * `{ provider }` options. `secrets.ts`'s `secretResourceOptions` uses the
 * same pattern for its two secret versions.
 */
export const escapeResourceOptions = {
  /**
   * @param provider - The regional AWS provider the item is declared against.
   * @returns The resource options, provider plus the create-only `ignoreChanges` entry.
   */
  forDiscordConfigSeedItem(provider: aws.Provider): pulumi.CustomResourceOptions {
    return { provider, ignoreChanges: ['item'] };
  },

  /**
   * @param provider - The regional AWS provider the invocation is declared against.
   * @param policy - The per-game `efsSeederPolicies` entry the invocation must depend on.
   * @returns The resource options, provider plus the required `dependsOn` entry.
   */
  forEfsSeederInvocation(provider: aws.Provider, policy: aws.iam.RolePolicy): pulumi.CustomResourceOptions {
    return { provider, dependsOn: [policy] };
  },
};

/**
 * Declares the two conditional Discord table rows — see this file's doc for
 * the resource table and rationale. Must be called from inside the Pulumi
 * inline-program closure, never at module scope, and after `dynamodb.ts`'s
 * `defineDynamoDb` (its `discordTable` is a required input here).
 *
 * @param args - Naming, config, and the Discord table to seed — see {@link DefineDiscordTableItemsArgs}.
 * @returns The two conditional items — see {@link DiscordTableItemResources}.
 */
export function defineDiscordTableItems(args: DefineDiscordTableItemsArgs): DiscordTableItemResources {
  const { projectName, provider, discordTable, baseAllowedGuilds, baseAdminUserIds, baseAdminRoleIds, discordApplicationId } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  const hasBaseConfig = baseAllowedGuilds.length + baseAdminUserIds.length + baseAdminRoleIds.length > 0;
  const discordBaseConfigItem = hasBaseConfig
    ? new aws.dynamodb.TableItem(
        `${projectName}-discord-base-config`,
        {
          tableName: discordTable.name,
          hashKey: discordTable.hashKey,
          rangeKey: discordTable.rangeKey,
          item: JSON.stringify({
            pk: { S: 'BASE#discord' },
            sk: { S: 'BASE' },
            data: {
              M: {
                allowedGuilds: { L: baseAllowedGuilds.map((guildId) => ({ S: guildId })) },
                admins: {
                  M: {
                    userIds: { L: baseAdminUserIds.map((userId) => ({ S: userId })) },
                    roleIds: { L: baseAdminRoleIds.map((roleId) => ({ S: roleId })) },
                  },
                },
              },
            },
            updatedAt: { N: '0' },
          }),
        },
        opts,
      )
    : undefined;

  const discordConfigSeedItem =
    discordApplicationId !== ''
      ? new aws.dynamodb.TableItem(
          `${projectName}-discord-config-seed`,
          {
            tableName: discordTable.name,
            hashKey: discordTable.hashKey,
            rangeKey: discordTable.rangeKey,
            item: JSON.stringify({
              pk: { S: 'CONFIG#discord' },
              sk: { S: 'CONFIG' },
              data: {
                M: {
                  clientId: { S: discordApplicationId },
                  allowedGuilds: { L: [] },
                  admins: { M: { userIds: { L: [] }, roleIds: { L: [] } } },
                  gamePermissions: { M: {} },
                },
              },
              updatedAt: { N: '0' },
            }),
          },
          escapeResourceOptions.forDiscordConfigSeedItem(provider),
        )
      : undefined;

  return { discordBaseConfigItem, discordConfigSeedItem };
}

/** Arguments {@link defineEfsSeederInvocations} needs to declare the per-game EFS-seeder invocations. */
export interface DefineEfsSeederInvocationsArgs {
  /** Mirrors `var.project_name` — every invocation's Pulumi logical name below is `${projectName}-efs-seeder-<game>-invocation`. */
  projectName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
  /** The configured game-server map (`DeploymentConfig.gameServers`) — each invocation's `input`/`triggers` are derived from the matching entry's `file_seeds`/`volumes[0].container_path`. */
  gameServers: Record<string, GameServerConfig>;
  /**
   * The per-game EFS-seeder functions `lambdas.ts`'s `defineLambdas` returned
   * (`LambdaResources.efsSeederFunctions`) — iterated (rather than a
   * freshly-recomputed `gamesWithFileSeeds`) so this set can never drift
   * from the functions that actually exist, the same "never drift" pattern
   * `iam.ts`'s `defineIamPolicies` and `lambdas.ts`'s own efs-seeder loop
   * already apply to their own per-game sets.
   */
  efsSeederFunctions: Record<string, aws.lambda.Function>;
  /**
   * The per-game EFS-seeder inline policies `iam.ts`'s `defineIamPolicies`
   * returned (`IamPolicyResources.efsSeederPolicies`) — every invocation's
   * required `dependsOn` target; see this file's doc for why that edge must
   * be explicit here.
   */
  efsSeederPolicies: Record<string, aws.iam.RolePolicy>;
}

/**
 * Computes the `triggers.seedsHash` value every invocation is declared with
 * — a SHA-256 digest of the game's `file_seeds` array. The hash only needs
 * to change if and only if the seed content changes, which a stable
 * `JSON.stringify` over the same in-memory config value guarantees across
 * repeated calls.
 *
 * @param fileSeeds - The game's `file_seeds` array (possibly empty/undefined).
 * @returns A hex-encoded SHA-256 digest.
 */
function fileSeedsHash(fileSeeds: GameServerConfig['file_seeds']): string {
  return crypto.createHash('sha256').update(JSON.stringify(fileSeeds ?? [])).digest('hex');
}

/**
 * Declares one `aws.lambda.Invocation` per game with `file_seeds` — see this
 * file's doc for the full rationale and the required `dependsOn` constraint.
 * Must be called from inside the Pulumi inline-program closure, never at
 * module scope, and after both
 * `lambdas.ts`'s `defineLambdas` (its `efsSeederFunctions`) and `iam.ts`'s
 * `defineIamPolicies` (its `efsSeederPolicies`) — the only call order that
 * satisfies this function's required `dependsOn` edge.
 *
 * @param args - Config, function, and policy inputs — see {@link DefineEfsSeederInvocationsArgs}.
 * @returns One invocation per game in `efsSeederFunctions`, keyed by game name.
 */
export function defineEfsSeederInvocations(args: DefineEfsSeederInvocationsArgs): Record<string, aws.lambda.Invocation> {
  const { projectName, provider, gameServers, efsSeederFunctions, efsSeederPolicies } = args;

  const invocations: Record<string, aws.lambda.Invocation> = {};

  for (const [game, seederFunction] of Object.entries(efsSeederFunctions)) {
    const config = gameServers[game];
    if (!config) {
      throw new Error(
        `defineEfsSeederInvocations: no gameServers entry for "${game}" — efsSeederFunctions and gameServers have drifted apart.`,
      );
    }
    const policy = efsSeederPolicies[game];
    if (!policy) {
      throw new Error(
        `defineEfsSeederInvocations: no efsSeederPolicies entry for "${game}" — the seeder invocation's required dependsOn ` +
          "target is missing (see this file's doc).",
      );
    }

    const fileSeeds = config.file_seeds ?? [];
    const containerPath = config.volumes[0].container_path;

    invocations[game] = new aws.lambda.Invocation(
      `${projectName}-efs-seeder-${game}-invocation`,
      {
        functionName: seederFunction.name,
        triggers: { seedsHash: fileSeedsHash(fileSeeds) },
        input: JSON.stringify({ game, seeds: fileSeeds, container_path: containerPath }),
      },
      escapeResourceOptions.forEfsSeederInvocation(provider, policy),
    );
  }

  return invocations;
}
