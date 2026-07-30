/**
 * The HCL's remaining "imperative escape" resources (task 3.10 of
 * `migrate-iac-to-pulumi`): resources whose Terraform declaration reaches
 * beyond pure declarative infrastructure management — seeding a mutable
 * DynamoDB row, invoking a deployed Lambda as a one-shot build step, or
 * shelling out via a local-exec provisioner. The task-3.8-3.10 brief lists
 * five such HCL resources; this file accounts for three of them directly,
 * one lives in `secrets.ts` (by the brief's own instruction), and one has no
 * Pulumi port at all — see the table and the two sections below.
 *
 * | HCL address | This file / elsewhere |
 * | --- | --- |
 * | `aws_dynamodb_table_item.discord_base_config` | {@link DiscordTableItemResources.discordBaseConfigItem} |
 * | `aws_dynamodb_table_item.discord_config_seed` | {@link DiscordTableItemResources.discordConfigSeedItem} |
 * | `aws_lambda_invocation.efs_seeder` (`for_each`) | {@link defineEfsSeederInvocations}'s return value |
 * | `aws_secretsmanager_secret_version.discord_bot_token` / `discord_public_key` | `secrets.ts`'s `SecretsResources` — see that file's doc, "Create-only secret versions," for why they live there instead |
 * | `terraform_data.discord_register_commands` | **NOT ported** — see "Why `terraform_data.discord_register_commands` has no Pulumi analogue" below |
 *
 * ## Why each ported resource is not a plain declarative resource
 *
 * - **`aws_dynamodb_table_item` (×2)** — a DynamoDB *row*, not
 *   infrastructure; `aws.dynamodb.TableItem` exists specifically because
 *   Terraform (and Pulumi) otherwise has no declarative way to seed a
 *   table's initial content. Both items are conditional, mirroring the HCL's
 *   `count = ... ? 1 : 0` guards exactly (`undefined` when the guard's
 *   condition is false — same optional-resource contract
 *   `securityGroups.ts`'s `efsSeeder` already establishes for this package).
 *   {@link DiscordTableItemResources.discordConfigSeedItem} carries
 *   `ignoreChanges: ['item']` — the Pulumi equivalent of the HCL's
 *   `lifecycle { ignore_changes = [item] }` — so the management app's own
 *   `PutItem` writes to the `CONFIG#discord` row (the Discord Settings save
 *   path) are never reverted by a later `pulumi up`.
 *   {@link DiscordTableItemResources.discordBaseConfigItem} carries NO such
 *   option, matching the HCL exactly: the `BASE#discord` row is recomputed
 *   from `baseAllowedGuilds`/`baseAdminUserIds`/`baseAdminRoleIds` on every
 *   deploy, by design — `deploymentConfig.ts`'s doc on those three fields
 *   describes this as "an immutable floor the management UI can never
 *   remove."
 *
 * - **`aws_lambda_invocation`** — invokes an already-deployed Lambda as a
 *   one-shot *build step* (writing a file to EFS through the seeder Lambda),
 *   not a resource with its own AWS-side lifecycle; `aws.lambda.Invocation`
 *   (`lifecycleScope: 'CREATE_ONLY'`, the default) exists for exactly this
 *   "run this Lambda once, then again only if its input changed" shape — see
 *   its own SDK doc: "By default this resource only invokes the function
 *   when the arguments call for a create or replace... To dynamically invoke
 *   the function, see the triggers example." The HCL's
 *   `triggers.seeds_hash` (a content hash of that game's `file_seeds`)
 *   becomes this construct's own `triggers` map below, reproducing the same
 *   re-invoke-iff-content-changed semantics. Per the task-3.8-3.10 brief's
 *   review-mandated constraint, each invocation also carries an explicit
 *   `dependsOn` on `efsSeederPolicies[game]` — the HCL didn't need this
 *   (Terraform's own `depends_on = [..., aws_iam_role_policy.efs_seeder]`
 *   handled the ordering there), but see `lambdas.ts`'s file doc, "Lambda
 *   role/policy creation order": this program's IAM policies attach strictly
 *   AFTER the functions they target now exist, so the invocation — which
 *   genuinely needs the policy's `elasticfilesystem:ClientWrite` grant live
 *   at invoke time — has no automatic Pulumi dependency edge onto it
 *   otherwise.
 *
 * ## Why `terraform_data.discord_register_commands` has no Pulumi analogue
 *
 * NOT ported, deliberately — no resource is declared for it anywhere in this
 * package. The HCL resource shells out to `curl` (via a `local-exec`
 * provisioner) with `var.discord_bot_token` injected as an environment
 * variable, to auto-register slash commands in every `base_allowed_guilds`
 * entry at `apply` time. That requires the live bot token as an input — and
 * the bot token is precisely the value `pulumi-infra-program`'s "No secret
 * material enters the stack" requirement forbids this program from
 * accepting (`DeploymentConfig` — `@hyveon/shared` — has no such field; see
 * `secrets.ts`'s file doc). There is no way to port this resource's effect
 * without reopening the exact route that requirement closes, so it is not
 * ported — not "deferred," not "TODO," a deliberate permanent omission.
 *
 * This is safe because the HCL's own effect for base guilds was only ever a
 * convenience, not the only path to that outcome:
 * `terraform/aws/discord_store.tf`'s own file doc already documents that
 * "Guilds added later via the management UI still require the 'Register
 * commands' button in the Guilds tab" — i.e. the app already has, and has
 * always had, a manual fallback for exactly this action
 * (`desktop-main/src/services/DiscordCommandRegistrar.ts`, wired to a button
 * on the Discord settings page — its own file doc: "the operator clicks
 * 'Register commands' in the web UI for each allowlisted guild"). Post
 * migration, an operator who has configured `baseAllowedGuilds` clicks that
 * same button once per base guild after the first deploy, instead of
 * Terraform doing it automatically at `apply` time. No functionality is
 * lost — only the one-time convenience of not having to click a button per
 * base guild — and the alternative (accepting a live bot token as a Pulumi
 * program input) would be strictly worse.
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
 * Builds the `pulumi.CustomResourceOptions` this file's two SPEC-CRITICAL/
 * review-mandated resource kinds are declared with: the `discord_config_seed`
 * item's create-only `ignoreChanges: ['item']` (the Pulumi equivalent of the
 * HCL's `lifecycle { ignore_changes = [item] }`) and each EFS-seeder
 * invocation's required `dependsOn: [policy]` edge (see this file's doc,
 * "Why each ported resource is not a plain declarative resource," for both
 * rationales). Exposed as methods on an exported object (not bare functions)
 * specifically so a spec can `vi.spyOn(escapeResourceOptions, 'forDiscordConfigSeedItem')`/
 * `vi.spyOn(escapeResourceOptions, 'forEfsSeederInvocation')` and assert
 * {@link defineDiscordTableItems}/{@link defineEfsSeederInvocations}
 * themselves call these exact functions at each resource's construction
 * site — not merely that the functions, called directly, return the right
 * shape. Pulumi's mock test harness (`testing/pulumiMocks.ts`) does not
 * expose `ignoreChanges`/`dependsOn` (or any other `CustomResourceOptions`
 * field) to a `newResource` mock callback — confirmed by reading
 * `@pulumi/pulumi`'s `runtime/mocks.d.ts`, whose `MockResourceArgs` carries
 * only `type`/`name`/`inputs`/`provider`/`custom`/`id` — so there is no way
 * to assert either option's presence by inspecting a recorded resource the
 * way every other test in this package does. A test that only calls
 * `escapeResourceOptions.forX(...)` directly and checks its return value
 * would NOT catch a future edit that quietly swaps a construction call site
 * back to the plain `{ provider }` options in scope (silently dropping the
 * create-only guard, or the required `dependsOn` edge) — the spy closes
 * exactly that gap, by asserting the function object the `defineX` caller
 * actually invokes, not a same-named copy the test constructs independently.
 * `secrets.ts`'s `secretResourceOptions` establishes this same pattern for
 * the two secret versions — see that file's doc for the identical rationale
 * spelled out in full.
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
 * Declares the two conditional Discord table rows (task 3.10 of
 * `migrate-iac-to-pulumi`) — see this file's doc for the full HCL→Pulumi
 * address table and rationale. Must be called from inside the Pulumi
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
 * — a SHA-256 digest of the game's `file_seeds` array, reproducing the HCL's
 * `sha256(jsonencode(each.value.file_seeds))` content-addressed re-invoke
 * trigger (exact hash value need not match the retired Terraform state's own
 * hash — there is no state migration across this rewrite — only that it
 * changes if and only if the seed content changes, which a stable
 * `JSON.stringify` over the same in-memory config value guarantees across
 * repeated calls).
 *
 * @param fileSeeds - The game's `file_seeds` array (possibly empty/undefined).
 * @returns A hex-encoded SHA-256 digest.
 */
function fileSeedsHash(fileSeeds: GameServerConfig['file_seeds']): string {
  return crypto.createHash('sha256').update(JSON.stringify(fileSeeds ?? [])).digest('hex');
}

/**
 * Declares one `aws.lambda.Invocation` per game with `file_seeds` (task 3.10
 * of `migrate-iac-to-pulumi`) — see this file's doc for the full rationale
 * and the review-mandated `dependsOn` constraint. Must be called from inside
 * the Pulumi inline-program closure, never at module scope, and after both
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
          'target is missing (see this file\'s doc, "Why each ported resource is not a plain declarative resource").',
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
