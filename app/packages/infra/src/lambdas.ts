/**
 * The five Lambda functions, their log groups, permissions, the interactions
 * Function URL, and the two EventBridge (CloudWatch Events) rule/target pairs
 * that trigger the watchdog and DNS-updater Lambdas — ported from
 * `terraform/aws/interactions.tf`, `followup.tf`, `watchdog.tf`, `route53.tf`
 * (its Lambda + EventBridge blocks only — the hosted-zone data-source lookup
 * is task 3.9's), and `efs-seeder.tf` (its Lambda block only — the shared
 * security group was moved to `securityGroups.ts` in a fix-review round, see
 * that file's doc for why, and the per-game IAM role/policy pair was already
 * ported by task 3.5, see `iam.ts`'s `IamRoleResources.efsSeederRoles` /
 * `IamPolicyResources.efsSeederPolicies`). Tasks 3.6 and 3.7 of
 * `migrate-iac-to-pulumi`.
 *
 * | HCL address | This file |
 * | --- | --- |
 * | `aws_lambda_function.interactions` | {@link LambdaResources.interactionsFunction} |
 * | `aws_cloudwatch_log_group.interactions` | {@link LambdaResources.interactionsLogGroup} |
 * | `aws_lambda_function_url.interactions` | {@link LambdaResources.interactionsFunctionUrl} |
 * | `aws_lambda_permission.interactions_url_invoke_url` | {@link LambdaResources.interactionsUrlInvokeUrlPermission} |
 * | `aws_lambda_permission.interactions_url_invoke` | {@link LambdaResources.interactionsUrlInvokePermission} |
 * | `aws_lambda_function.followup` | {@link LambdaResources.followupFunction} |
 * | `aws_cloudwatch_log_group.followup` | {@link LambdaResources.followupLogGroup} |
 * | `aws_lambda_function.watchdog` | {@link LambdaResources.watchdogFunction} |
 * | `aws_cloudwatch_log_group.watchdog` | {@link LambdaResources.watchdogLogGroup} |
 * | `aws_cloudwatch_event_rule.watchdog_schedule` | {@link LambdaResources.watchdogScheduleRule} |
 * | `aws_cloudwatch_event_target.watchdog` | {@link LambdaResources.watchdogScheduleTarget} |
 * | `aws_lambda_permission.watchdog_eventbridge` | {@link LambdaResources.watchdogEventBridgePermission} |
 * | `aws_lambda_function.dns_updater` | {@link LambdaResources.dnsUpdaterFunction} |
 * | `aws_cloudwatch_log_group.dns_updater` | {@link LambdaResources.dnsUpdaterLogGroup} |
 * | `aws_cloudwatch_event_rule.ecs_task_change` | {@link LambdaResources.ecsTaskChangeRule} |
 * | `aws_cloudwatch_event_target.dns_updater` | {@link LambdaResources.dnsUpdaterEventTarget} |
 * | `aws_lambda_permission.dns_updater_eventbridge` | {@link LambdaResources.dnsUpdaterEventBridgePermission} |
 * | `aws_security_group.efs_seeder` | `securityGroups.ts`'s `SecurityGroupResources.efsSeeder` (NOT this file) |
 * | `aws_cloudwatch_log_group.efs_seeder` (`for_each`) | {@link LambdaResources.efsSeederLogGroups} |
 * | `aws_lambda_function.efs_seeder` (`for_each`) | {@link LambdaResources.efsSeederFunctions} |
 *
 * `data.archive_file.*` (all five) has no Pulumi resource counterpart — see
 * {@link lambdaCode}'s doc for how its zip-a-single-file behaviour is
 * reproduced. `aws_lambda_invocation.efs_seeder` (the file-seed write
 * trigger) is NOT ported here — task 3.10 owns it, alongside the rest of the
 * HCL's other "imperative escape" resources
 * (`aws_dynamodb_table_item`/`terraform_data`/`aws_secretsmanager_secret_version`).
 * Note for whoever picks up task 3.10: unlike this file's four other
 * functions (see "Lambda role/policy creation order" below), the seeder
 * invocation's port MUST carry an explicit `dependsOn` on
 * `policies.efsSeederPolicies[game]` — the HCL invokes
 * `aws_lambda_invocation.efs_seeder` within the same `apply` as
 * `aws_iam_role_policy.efs_seeder`, relying on Terraform's `depends_on` for
 * ordering, and this program's policies now attach strictly AFTER the
 * functions exist (see below), so the invocation has no automatic Pulumi
 * dependency edge onto the policy it actually needs at invoke time.
 *
 * ## The lambda-bundle path contract
 *
 * Every `aws_lambda_function` in the HCL sources its code from a
 * `data.archive_file` that zips a single prebuilt `dist/handler.cjs` file
 * (produced by each `@hyveon/lambda-*` package's own `npm run build`, NOT by
 * this program). {@link DefineLambdasArgs.lambdaBundlesDir} is the directory
 * this file resolves each function's bundle against
 * (`<lambdaBundlesDir>/<lambda-dir-name>/dist/handler.cjs` — see
 * {@link bundlePath}) — a REQUIRED parameter with no default computed
 * anywhere in this package, for a specific reason:
 *
 * `@hyveon/infra`'s own compiled location (`app/packages/infra/dist/`) is
 * not a reliable anchor for a relative-path default. In a repo checkout it
 * would resolve correctly (`dist/../../lambda` lands on
 * `app/packages/lambda`), but the desktop app's main process does not run
 * `@hyveon/infra`'s own `dist/*.js` files directly — `electron-vite` bundles
 * every internal workspace package (this one included) into a single
 * `out/main` artifact, and `electron-builder.yml`'s `files:` list ships only
 * that `out/**` artifact plus `node_modules/@pulumi/**` (kept external
 * specifically to avoid bundling `@grpc/grpc-js`'s native sockets — see that
 * file's own comment). A repo-relative default derived from
 * `import.meta.url` inside this package would silently resolve to a
 * nonexistent path once bundled, which is worse than requiring the caller to
 * be explicit: it would look correct in every unit test (which import this
 * module directly from `src/`, unbundled) and only break inside the
 * packaged app, the one environment task 3.6 has no automated coverage of.
 *
 * So the contract is: **every caller supplies `lambdaBundlesDir` explicitly**
 * — this package computes no fallback. Concretely:
 *  - **Unit tests** (this file's own `.test.ts`) pass a literal placeholder
 *    string. Pulumi's `pulumi.asset.FileAsset`/`AssetArchive` constructors
 *    never touch the filesystem — they wrap the given path in a
 *    `Promise.resolve(...)` (confirmed by reading
 *    `@pulumi/pulumi`'s `asset/*.js`) — and `pulumi.runtime.setMocks`
 *    (`testing/pulumiMocks.ts`) intercepts every resource registration
 *    before any real engine or upload is involved, so no test needs a real
 *    bundle file to exist on disk, matching this task's brief.
 *  - **Phase 7's `PulumiService`** (`desktop-main`, not yet built) must
 *    resolve a real directory before calling `defineAll`/`createInfraProgram`,
 *    following the same three-tier pattern `ConfigService` already
 *    establishes for `terraform.tfstate`/`terraform.tfvars`
 *    (`getTfStatePath`/`getTfvarsPath`): an env var override, then
 *    `app.isPackaged` → `path.join(process.resourcesPath, 'lambda')`, then a
 *    repo-relative dev fallback. The packaged branch is NOT satisfiable
 *    today without an `electron-builder.yml` change this task does not make:
 *    `app/packages/lambda/*\/dist/**` is not currently in that file's
 *    `files:`/`extraResources:` list (only `out/**` and the pinned
 *    `node_modules/**` closures are), so Phase 7 must add an `extraResources`
 *    entry copying each package's `dist/handler.cjs` to
 *    `resourcesPath/lambda/<name>/dist/handler.cjs` before this contract can
 *    resolve correctly in a packaged build.
 *  - **`defineAll`/`createInfraProgram`** (`program.ts`) already thread a
 *    second `options: InfraProgramOptions` parameter carrying
 *    `lambdaBundlesDir` through to wherever `defineLambdas` is eventually
 *    called from `defineAll` — see `program.ts`'s `InfraProgramOptions` doc
 *    and its `TODO(task 3.8/3.9)` comment. `defineAll` itself does not yet
 *    call `defineLambdas` (see below), so `options` is currently unused
 *    inside `defineAll`'s body beyond being captured for that future call.
 *
 * ## Why `defineLambdas` is not wired into `defineAll` yet
 *
 * Three environment variables across the five functions are only resolvable
 * once later tasks land: `TABLE_NAME`/`DISCORD_PUBLIC_KEY_SECRET_ARN`
 * (task 3.8 — DynamoDB + Secrets Manager) and `HOSTED_ZONE_ID` (task 3.9 —
 * Route 53). {@link DefineLambdasArgs} threads all three as required
 * `pulumi.Input<string>` parameters (`dynamodbDiscordTableName`,
 * `discordPublicKeySecretArn`, `hostedZoneId`) rather than optional ones,
 * for the same reason `iam.ts`'s `DefineIamPoliciesArgs` does: an optional
 * parameter defaulting to `undefined` would silently deploy a broken
 * environment variable instead of failing to compile. This is the exact
 * situation `defineIamPolicies` was already in after task 3.5 — see this
 * file's doc and `program.ts`'s `TODO(task 3.8/3.9)` comment for the
 * resulting call-order contract (`defineIamRoles` + `defineSecurityGroups`,
 * both already wired → `defineLambdas` → `defineIamPolicies`) and exactly
 * what remains before both can be wired into `defineAll` together. The
 * EFS-seeder security group itself has NO such blocker — it depends only on
 * `gameServers`/`vpcId`/`projectName`, so it is already wired into
 * `defineAll` today via `securityGroups.ts`'s `defineSecurityGroups`, not
 * gated on this file's `defineLambdas` call at all.
 *
 * ## Lambda role/policy creation order — a deliberate deviation from the HCL
 *
 * Every `aws_lambda_function` in the HCL carries
 * `depends_on = [aws_iam_role_policy.<x>]`, forcing Terraform to attach each
 * function's inline policy before creating the function itself. This
 * program's call order is the opposite: `defineIamRoles` runs first (task
 * 3.5, already wired), `defineLambdas` runs next (this task) referencing
 * only each role's ARN (never its policy), and `defineIamPolicies` runs
 * last — necessarily, since one of its inputs
 * (`followupLambdaArn`) does not exist until `defineLambdas` has created the
 * followup function. `iam.ts`'s file doc lays out why no call order
 * satisfies both directions at once (`defineIamPolicies` needs a live Lambda
 * ARN; the HCL's `depends_on` wants the policy to exist before any Lambda
 * function does) — task 3.5 already accepted this trade-off for the whole
 * program, and this task inherits it rather than reopening it. Lambda
 * function creation only requires its execution role to exist and be
 * assumable (AWS does not require every eventual permission to be attached
 * before a function can be created, only before it is successfully
 * invoked) — the deviation is a construction-order difference within a
 * single `pulumi up`, not a functional gap in the deployed permission set.
 *
 * The one exception, preserved exactly, is the EFS-seeder Lambda's
 * `depends_on = [..., aws_efs_mount_target.saves, aws_cloudwatch_log_group.efs_seeder]`
 * (deliberately omitting `aws_iam_role_policy.efs_seeder` from what this
 * port replicates, for the same reason as the other four functions): unlike
 * the IAM-policy ordering, both of these are genuine AWS-level
 * preconditions with no automatic Pulumi dependency edge otherwise. A
 * `file_system_config` pointing at an EFS access point does not work until
 * that filesystem has a mount target in the Lambda's VPC/subnet, and Lambda
 * auto-creates a never-expiring log group on first invocation if this
 * program's own 7-day-retention log group doesn't already exist — see each
 * seeder function's `dependsOn` below. See this file's doc, the note above
 * about `aws_lambda_invocation.efs_seeder`, for the corresponding
 * `dependsOn` task 3.10 must add for the seeder invocation itself.
 */

import path from 'node:path';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';
import type { EfsResources } from './efs.js';
import type { IamRoleResources } from './iam.js';

/** Node.js Lambda runtime every one of the five functions declares (`nodejs20.x` in the HCL). */
const LAMBDA_RUNTIME = 'nodejs20.x';

/** Handler string every one of the five functions declares (`handler.handler` in the HCL — module `handler.cjs`, exported function `handler`). */
const LAMBDA_HANDLER = 'handler.handler';

/** Every resource {@link defineLambdas} declares, keyed by role — see this file's doc for the full HCL→Pulumi address table. */
export interface LambdaResources {
  /** The Discord HTTP-interactions entry point (`aws_lambda_function.interactions`). */
  interactionsFunction: aws.lambda.Function;
  /** {@link interactionsFunction}'s CloudWatch log group (`aws_cloudwatch_log_group.interactions`). */
  interactionsLogGroup: aws.cloudwatch.LogGroup;
  /** The public Function URL Discord posts interactions to (`aws_lambda_function_url.interactions`). */
  interactionsFunctionUrl: aws.lambda.FunctionUrl;
  /** Grants `lambda:InvokeFunctionUrl` to the public principal (`aws_lambda_permission.interactions_url_invoke_url`). */
  interactionsUrlInvokeUrlPermission: aws.lambda.Permission;
  /** Grants `lambda:InvokeFunction` to the public principal — required alongside {@link interactionsUrlInvokeUrlPermission} since October 2025 (`aws_lambda_permission.interactions_url_invoke`). */
  interactionsUrlInvokePermission: aws.lambda.Permission;

  /** The async-invoked ECS RunTask/StopTask worker (`aws_lambda_function.followup`). */
  followupFunction: aws.lambda.Function;
  /** {@link followupFunction}'s CloudWatch log group (`aws_cloudwatch_log_group.followup`). */
  followupLogGroup: aws.cloudwatch.LogGroup;

  /** The idle-server auto-shutdown Lambda (`aws_lambda_function.watchdog`). */
  watchdogFunction: aws.lambda.Function;
  /** {@link watchdogFunction}'s CloudWatch log group (`aws_cloudwatch_log_group.watchdog`). */
  watchdogLogGroup: aws.cloudwatch.LogGroup;
  /** EventBridge schedule rule that triggers {@link watchdogFunction} (`aws_cloudwatch_event_rule.watchdog_schedule`). */
  watchdogScheduleRule: aws.cloudwatch.EventRule;
  /** Wires {@link watchdogScheduleRule} to {@link watchdogFunction} (`aws_cloudwatch_event_target.watchdog`). */
  watchdogScheduleTarget: aws.cloudwatch.EventTarget;
  /** Grants `events.amazonaws.com` permission to invoke {@link watchdogFunction}, scoped to {@link watchdogScheduleRule}'s ARN (`aws_lambda_permission.watchdog_eventbridge`). */
  watchdogEventBridgePermission: aws.lambda.Permission;

  /** The Route 53 DNS-updater Lambda (`aws_lambda_function.dns_updater`). */
  dnsUpdaterFunction: aws.lambda.Function;
  /** {@link dnsUpdaterFunction}'s CloudWatch log group (`aws_cloudwatch_log_group.dns_updater`). */
  dnsUpdaterLogGroup: aws.cloudwatch.LogGroup;
  /** EventBridge rule matching ECS task RUNNING/STOPPED state changes (`aws_cloudwatch_event_rule.ecs_task_change`). */
  ecsTaskChangeRule: aws.cloudwatch.EventRule;
  /** Wires {@link ecsTaskChangeRule} to {@link dnsUpdaterFunction} (`aws_cloudwatch_event_target.dns_updater`). */
  dnsUpdaterEventTarget: aws.cloudwatch.EventTarget;
  /** Grants `events.amazonaws.com` permission to invoke {@link dnsUpdaterFunction}, scoped to {@link ecsTaskChangeRule}'s ARN (`aws_lambda_permission.dns_updater_eventbridge`). */
  dnsUpdaterEventBridgePermission: aws.lambda.Permission;

  /** One log group per game with `file_seeds`, keyed by game name (`aws_cloudwatch_log_group.efs_seeder`). Empty when no game declares seeds. */
  efsSeederLogGroups: Record<string, aws.cloudwatch.LogGroup>;
  /** One Lambda function per game with `file_seeds`, keyed the same way as {@link efsSeederLogGroups} and `iam.ts`'s `IamRoleResources.efsSeederRoles` (`aws_lambda_function.efs_seeder`). Empty when no game declares seeds. */
  efsSeederFunctions: Record<string, aws.lambda.Function>;
}

/** Arguments {@link defineLambdas} needs to declare every Lambda function and its wiring. */
export interface DefineLambdasArgs {
  /** Mirrors `var.project_name` — every resource name below is `${projectName}-...`, matching the HCL exactly. */
  projectName: string;
  /** Mirrors `var.aws_region` — every function's `AWS_REGION_` environment variable (see the CLAUDE.md invariant: `AWS_REGION` itself is reserved by the Lambda runtime). */
  awsRegion: string;
  /** Mirrors `var.hosted_zone_name` — the interactions/followup/dns-updater functions' `HOSTED_ZONE_NAME`/`DOMAIN_NAME` environment variables. */
  hostedZoneName: string;
  /** Mirrors `var.dns_ttl` — the dns-updater function's `DNS_TTL` environment variable. */
  dnsTtl: number;
  /** Mirrors `var.watchdog_interval_minutes` — the watchdog function's `CHECK_WINDOW_MINUTES` environment variable and its EventBridge schedule expression. */
  watchdogIntervalMinutes: number;
  /** Mirrors `var.watchdog_idle_checks` — the watchdog function's `IDLE_CHECKS` environment variable. */
  watchdogIdleChecks: number;
  /** Mirrors `var.watchdog_min_packets` — the watchdog function's `MIN_PACKETS` environment variable. */
  watchdogMinPackets: number;
  /** The configured game-server map (`DeploymentConfig.gameServers`) every per-game derivation below (`GAME_NAMES`, `CONNECT_MESSAGES`, `GAME_PORTS`, the EFS-seeder functions) iterates. */
  gameServers: Record<string, GameServerConfig>;

  /** The role set `iam.ts`'s `defineIamRoles` returned — every function's `role` is one of these roles' `.arn`. */
  roles: IamRoleResources;

  /** The public subnet ids (`network.ts`'s `NetworkResources.publicSubnets` mapped to `.id`) — the followup function's `SUBNET_IDS` environment variable and every EFS-seeder function's `vpc_config.subnet_ids`. */
  publicSubnetIds: pulumi.Input<string>[];
  /**
   * The shared EFS-seeder security group's id — `securityGroups.ts`'s
   * `SecurityGroupResources.efsSeeder?.id` (that module, not this one, now
   * owns constructing the group itself; see this file's doc). `undefined`
   * is only valid when no game declares `file_seeds` (mirroring
   * `SecurityGroupResources.efsSeeder`'s own `undefined` case) — passing
   * `undefined` while `gameServers` has at least one `file_seeds`-declaring
   * entry is a caller bug and {@link defineLambdas} throws rather than
   * silently omitting `vpc_config.security_group_ids`.
   */
  efsSeederSecurityGroupId: pulumi.Input<string> | undefined;
  /** The `game_servers` security group's id (`securityGroups.ts`'s `SecurityGroupResources.gameServers.id`) — the followup function's `SECURITY_GROUP_ID` environment variable. */
  gameServersSecurityGroupId: pulumi.Input<string>;
  /** The ECS cluster's name (`ecs.ts`'s `EcsResources.cluster.name`) — the followup and watchdog functions' `ECS_CLUSTER` environment variable. */
  ecsClusterName: pulumi.Input<string>;
  /** The ECS cluster's ARN (`ecs.ts`'s `EcsResources.cluster.arn`) — interpolated into {@link LambdaResources.ecsTaskChangeRule}'s event pattern. */
  ecsClusterArn: pulumi.Input<string>;
  /** The EFS resources `efs.ts`'s `defineEfs` returned — every EFS-seeder function's `file_system_config.arn` looks up `efs.gameAccessPoints["${game}-${firstVolumeName}"].arn`. */
  efs: EfsResources;

  /**
   * The directory every function's prebuilt `dist/handler.cjs` bundle is
   * resolved against — REQUIRED, with no default computed in this package.
   * See this file's doc, "The lambda-bundle path contract", for the full
   * rationale and what a caller (tests now; Phase 7's `PulumiService`
   * eventually) must supply.
   */
  lambdaBundlesDir: string;

  /**
   * `aws_dynamodb_table.discord.name` — the interactions, followup, and
   * dns-updater functions' `TABLE_NAME` environment variable. TODO(task 3.8):
   * threaded here as a required parameter because the DynamoDB tables have
   * not been ported yet — a real caller must pass the real table's `.name`
   * once task 3.8 lands. See this file's doc, "Why `defineLambdas` is not
   * wired into `defineAll` yet".
   */
  dynamodbDiscordTableName: pulumi.Input<string>;
  /**
   * `aws_secretsmanager_secret.discord_public_key.arn` — the interactions
   * function's `DISCORD_PUBLIC_KEY_SECRET_ARN` environment variable.
   * TODO(task 3.8): threaded here as a required parameter because the
   * Secrets Manager secrets have not been ported yet.
   */
  discordPublicKeySecretArn: pulumi.Input<string>;
  /**
   * `data.aws_route53_zone.main.zone_id` — the dns-updater function's
   * `HOSTED_ZONE_ID` environment variable. TODO(task 3.9): threaded here as
   * a required parameter because the Route 53 hosted-zone lookup has not
   * been ported yet.
   */
  hostedZoneId: pulumi.Input<string>;

  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Resolves a Lambda function's prebuilt bundle path — the file each of the
 * HCL's `data.archive_file` blocks zips (`source_file`) — against a caller-
 * supplied bundle directory. See this file's doc, "The lambda-bundle path
 * contract", for why {@link lambdaBundlesDir} has no default anywhere in
 * this package.
 *
 * @param lambdaBundlesDir - The directory every `@hyveon/lambda-*` package's
 *   build output lives under, one subdirectory per package.
 * @param lambdaDirName - The package's directory name under
 *   `app/packages/lambda/` (e.g. `"interactions"`, `"update-dns"` — NOT
 *   always the same string as the function's own name; see each call site).
 * @returns The resolved path to that package's `dist/handler.cjs`.
 */
export function bundlePath(lambdaBundlesDir: string, lambdaDirName: string): string {
  return path.join(lambdaBundlesDir, lambdaDirName, 'dist', 'handler.cjs');
}

/**
 * Builds the `code` archive every `aws_lambda_function` in the HCL sources
 * from `data.archive_file`'s zip output. Terraform's `archive_file` with a
 * `source_file` (no `source_dir`) zips that single file at the archive root
 * under its own basename — since every bundle here is already named
 * `handler.cjs` on disk (matching {@link LAMBDA_HANDLER}'s `handler.<fn>`
 * module-name half), an `AssetArchive` with one named `FileAsset` entry
 * reproduces that exactly, regardless of what {@link bundleFilePath}'s
 * directory portion happens to be.
 *
 * @param bundleFilePath - The resolved path to a package's `dist/handler.cjs` — see {@link bundlePath}.
 * @returns A single-entry `AssetArchive` matching the HCL's zip output.
 */
function lambdaCode(bundleFilePath: string): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({ 'handler.cjs': new pulumi.asset.FileAsset(bundleFilePath) });
}

/**
 * Comma-joined game names in Terraform's `keys(map)` order — always
 * lexicographically sorted, regardless of the map's definition/iteration
 * order — reproducing every `GAME_NAMES = join(",", keys(var.game_servers))`
 * environment variable across the HCL exactly (`Object.keys` alone would
 * instead yield JS's insertion order, which does not match).
 *
 * @param gameServers - The configured game-server map.
 * @returns The comma-joined, sorted game names.
 */
function gameNamesCsv(gameServers: Record<string, GameServerConfig>): string {
  return Object.keys(gameServers).sort().join(',');
}

/**
 * Builds the `CONNECT_MESSAGES` JSON object shared by the followup and
 * dns-updater functions, mirroring
 * `jsonencode({ for g, cfg in var.game_servers : g => cfg.connect_message if cfg.connect_message != null })` —
 * entries iterated in Terraform's sorted-key order (see {@link gameNamesCsv}'s
 * doc) so the emitted JSON's key order matches exactly.
 *
 * @param gameServers - The configured game-server map.
 * @returns A game name → connect-message record, omitting games with no `connect_message`.
 */
function connectMessagesByGame(gameServers: Record<string, GameServerConfig>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const game of Object.keys(gameServers).sort()) {
    const message = gameServers[game].connect_message;
    if (message != null) {
      result[game] = message;
    }
  }
  return result;
}

/**
 * Builds the `GAME_PORTS` JSON object shared by the followup and dns-updater
 * functions, mirroring
 * `jsonencode({ for g, cfg in var.game_servers : g => cfg.ports[0].container if length(cfg.ports) > 0 })` —
 * same sorted-key iteration as {@link connectMessagesByGame}.
 *
 * @param gameServers - The configured game-server map.
 * @returns A game name → first-container-port record, omitting games with no ports.
 */
function firstPortByGame(gameServers: Record<string, GameServerConfig>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const game of Object.keys(gameServers).sort()) {
    const ports = gameServers[game].ports;
    if (ports.length > 0) {
      result[game] = ports[0].container;
    }
  }
  return result;
}

/**
 * Declares every Lambda function, its log group, its permissions, the
 * interactions Function URL, and the watchdog/dns-updater EventBridge
 * rule/target/permission triples (tasks 3.6 and 3.7 of
 * `migrate-iac-to-pulumi`) — see this file's doc for the full HCL→Pulumi
 * address table, the lambda-bundle path contract, and why this function is
 * not yet called from `program.ts`'s `defineAll`. Must be called from inside
 * the Pulumi inline-program closure, never at module scope, and after
 * `defineIamRoles`, `defineSecurityGroups`, `defineEfs`, and `defineEcs`
 * (all four of whose outputs it consumes — `defineSecurityGroups` for
 * `efsSeederSecurityGroupId`).
 *
 * @param args - Naming, config, IAM, network, EFS, bundle-path, and
 *   deferred-value inputs — see {@link DefineLambdasArgs}.
 * @returns The declared resources — see {@link LambdaResources}.
 */
export function defineLambdas(args: DefineLambdasArgs): LambdaResources {
  const {
    projectName,
    awsRegion,
    hostedZoneName,
    dnsTtl,
    watchdogIntervalMinutes,
    watchdogIdleChecks,
    watchdogMinPackets,
    gameServers,
    roles,
    publicSubnetIds,
    efsSeederSecurityGroupId,
    gameServersSecurityGroupId,
    ecsClusterName,
    ecsClusterArn,
    efs,
    lambdaBundlesDir,
    dynamodbDiscordTableName,
    discordPublicKeySecretArn,
    hostedZoneId,
    provider,
  } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // Validated up front, before any resource is constructed — deliberately
  // NOT deferred to the seeder loop further down. A mid-function throw
  // after some (but not all) of this function's resources are already
  // under construction would leave those in-flight mock registrations
  // unawaited, which `testing/pulumiMocks.ts`'s doc flags as exactly the
  // kind of race a test must never risk leaving behind.
  const seederGames = Object.entries(roles.efsSeederRoles);
  if (seederGames.length > 0 && efsSeederSecurityGroupId === undefined) {
    throw new Error(
      'defineLambdas: at least one game declares file_seeds but efsSeederSecurityGroupId is undefined — ' +
        'pass securityGroups.efsSeeder?.id (defineSecurityGroups must be called with the same gameServers map).',
    );
  }

  // ── Followup Lambda (followup.tf) — declared before interactions so its
  // function name is in scope for interactions' FOLLOWUP_LAMBDA_NAME below,
  // matching the HCL's own reference direction. ─────────────────────────────
  const followupFunction = new aws.lambda.Function(
    `${projectName}-followup`,
    {
      name: `${projectName}-followup`,
      role: roles.followupLambdaRole.arn,
      handler: LAMBDA_HANDLER,
      runtime: LAMBDA_RUNTIME,
      code: lambdaCode(bundlePath(lambdaBundlesDir, 'followup')),
      timeout: 60,
      memorySize: 256,
      environment: {
        variables: {
          AWS_REGION_: awsRegion,
          TABLE_NAME: dynamodbDiscordTableName,
          ECS_CLUSTER: ecsClusterName,
          SUBNET_IDS: pulumi.all(publicSubnetIds).apply((ids) => ids.join(',')),
          SECURITY_GROUP_ID: gameServersSecurityGroupId,
          DOMAIN_NAME: hostedZoneName,
          GAME_NAMES: gameNamesCsv(gameServers),
          CONNECT_MESSAGES: JSON.stringify(connectMessagesByGame(gameServers)),
          GAME_PORTS: JSON.stringify(firstPortByGame(gameServers)),
        },
      },
      tags: { Name: `${projectName}-followup` },
    },
    opts,
  );

  const followupLogGroup = new aws.cloudwatch.LogGroup(
    `${projectName}-followup-logs`,
    {
      name: `/aws/lambda/${projectName}-followup`,
      retentionInDays: 7,
      tags: { Name: `${projectName}-followup-logs` },
    },
    opts,
  );

  // ── Interactions Lambda (interactions.tf) ─────────────────────────────────
  const interactionsFunction = new aws.lambda.Function(
    `${projectName}-interactions`,
    {
      name: `${projectName}-interactions`,
      role: roles.interactionsLambdaRole.arn,
      handler: LAMBDA_HANDLER,
      runtime: LAMBDA_RUNTIME,
      code: lambdaCode(bundlePath(lambdaBundlesDir, 'interactions')),
      timeout: 10,
      memorySize: 256,
      environment: {
        variables: {
          AWS_REGION_: awsRegion,
          TABLE_NAME: dynamodbDiscordTableName,
          DISCORD_PUBLIC_KEY_SECRET_ARN: discordPublicKeySecretArn,
          FOLLOWUP_LAMBDA_NAME: followupFunction.name,
          GAME_NAMES: gameNamesCsv(gameServers),
          HOSTED_ZONE_NAME: hostedZoneName,
        },
      },
      tags: { Name: `${projectName}-interactions` },
    },
    opts,
  );

  const interactionsLogGroup = new aws.cloudwatch.LogGroup(
    `${projectName}-interactions-logs`,
    {
      name: `/aws/lambda/${projectName}-interactions`,
      retentionInDays: 7,
      tags: { Name: `${projectName}-interactions-logs` },
    },
    opts,
  );

  const interactionsFunctionUrl = new aws.lambda.FunctionUrl(
    `${projectName}-interactions-url`,
    {
      functionName: interactionsFunction.name,
      authorizationType: 'NONE',
      cors: {
        allowOrigins: ['https://discord.com'],
        allowMethods: ['POST'],
        allowHeaders: ['content-type', 'x-signature-ed25519', 'x-signature-timestamp'],
      },
    },
    opts,
  );

  // Since October 2025, Lambda Function URLs require BOTH
  // lambda:InvokeFunctionUrl AND lambda:InvokeFunction in the resource
  // policy — without the second one, Discord's endpoint validation gets 403
  // before the handler runs. AWS only accepts function_url_auth_type paired
  // with lambda:InvokeFunctionUrl, so the two grants are split into two
  // statements/resources, exactly as the HCL splits them.
  const interactionsUrlInvokeUrlPermission = new aws.lambda.Permission(
    `${projectName}-interactions-url-invoke-url`,
    {
      statementId: 'FunctionURLInvokeUrlAllowPublicAccess',
      action: 'lambda:InvokeFunctionUrl',
      function: interactionsFunction.name,
      principal: '*',
      functionUrlAuthType: 'NONE',
    },
    opts,
  );

  const interactionsUrlInvokePermission = new aws.lambda.Permission(
    `${projectName}-interactions-url-invoke`,
    {
      statementId: 'FunctionURLInvokeAllowPublicAccess',
      action: 'lambda:InvokeFunction',
      function: interactionsFunction.name,
      principal: '*',
    },
    opts,
  );

  // ── Watchdog Lambda + EventBridge schedule (watchdog.tf) ──────────────────
  const watchdogFunction = new aws.lambda.Function(
    `${projectName}-watchdog`,
    {
      name: `${projectName}-watchdog`,
      role: roles.watchdogLambdaRole.arn,
      handler: LAMBDA_HANDLER,
      runtime: LAMBDA_RUNTIME,
      code: lambdaCode(bundlePath(lambdaBundlesDir, 'watchdog')),
      timeout: 60,
      // No `memorySize` — the HCL omits `memory_size` for this function
      // alone, leaving Lambda's own 128 MB default. Do not add one.
      environment: {
        variables: {
          ECS_CLUSTER: ecsClusterName,
          GAME_NAMES: gameNamesCsv(gameServers),
          IDLE_CHECKS: String(watchdogIdleChecks),
          MIN_PACKETS: String(watchdogMinPackets),
          CHECK_WINDOW_MINUTES: String(watchdogIntervalMinutes),
          AWS_REGION_: awsRegion,
        },
      },
      tags: { Name: `${projectName}-watchdog` },
    },
    opts,
  );

  const watchdogLogGroup = new aws.cloudwatch.LogGroup(
    `${projectName}-watchdog-logs`,
    {
      name: `/aws/lambda/${projectName}-watchdog`,
      retentionInDays: 7,
      tags: { Name: `${projectName}-watchdog-logs` },
    },
    opts,
  );

  // `rate(1 minute)` vs `rate(N minutes)` — singular/plural matters to
  // EventBridge's schedule-expression parser, exactly as the HCL's inline
  // ternary comment warns.
  const watchdogScheduleRule = new aws.cloudwatch.EventRule(
    `${projectName}-watchdog-schedule`,
    {
      name: `${projectName}-watchdog-schedule`,
      description: `Check for idle game servers every ${watchdogIntervalMinutes} minute(s)`,
      scheduleExpression: `rate(${watchdogIntervalMinutes} ${watchdogIntervalMinutes === 1 ? 'minute' : 'minutes'})`,
    },
    opts,
  );

  const watchdogScheduleTarget = new aws.cloudwatch.EventTarget(
    `${projectName}-watchdog-target`,
    {
      rule: watchdogScheduleRule.name,
      targetId: 'GameServerWatchdog',
      arn: watchdogFunction.arn,
    },
    opts,
  );

  const watchdogEventBridgePermission = new aws.lambda.Permission(
    `${projectName}-watchdog-eventbridge`,
    {
      statementId: 'AllowWatchdogEventBridge',
      action: 'lambda:InvokeFunction',
      function: watchdogFunction.name,
      principal: 'events.amazonaws.com',
      sourceArn: watchdogScheduleRule.arn,
    },
    opts,
  );

  // ── DNS-updater Lambda + EventBridge ECS-state-change rule (route53.tf) ───
  const dnsUpdaterFunction = new aws.lambda.Function(
    `${projectName}-dns-updater`,
    {
      name: `${projectName}-dns-updater`,
      role: roles.dnsUpdaterLambdaRole.arn,
      handler: LAMBDA_HANDLER,
      runtime: LAMBDA_RUNTIME,
      // Bundle directory is `update-dns` (the `@hyveon/lambda-update-dns`
      // package's own directory name), even though every other identifier
      // here uses `dns-updater`/`dnsUpdater` — matches the HCL's own
      // `data.archive_file.dns_updater`'s `source_file` path exactly.
      code: lambdaCode(bundlePath(lambdaBundlesDir, 'update-dns')),
      timeout: 60,
      // No `memorySize` — the HCL omits `memory_size` for this function too.
      environment: {
        variables: {
          HOSTED_ZONE_ID: hostedZoneId,
          DOMAIN_NAME: hostedZoneName,
          GAME_NAMES: gameNamesCsv(gameServers),
          DNS_TTL: String(dnsTtl),
          AWS_REGION_: awsRegion,
          TABLE_NAME: dynamodbDiscordTableName,
          CONNECT_MESSAGES: JSON.stringify(connectMessagesByGame(gameServers)),
          GAME_PORTS: JSON.stringify(firstPortByGame(gameServers)),
        },
      },
      tags: { Name: `${projectName}-dns-updater` },
    },
    opts,
  );

  const dnsUpdaterLogGroup = new aws.cloudwatch.LogGroup(
    `${projectName}-dns-updater-logs`,
    {
      name: `/aws/lambda/${projectName}-dns-updater`,
      retentionInDays: 7,
      tags: { Name: `${projectName}-dns-updater-logs` },
    },
    opts,
  );

  const ecsTaskChangeRule = new aws.cloudwatch.EventRule(
    `${projectName}-task-state-change`,
    {
      name: `${projectName}-task-state-change`,
      description: 'Triggers DNS update when any game server task starts or stops',
      // `clusterArn` is a live Output (`ecs.ts`'s `EcsResources.cluster.arn`,
      // already available by the time `defineLambdas` runs), hence
      // `pulumi.jsonStringify` rather than a plain `JSON.stringify` — same
      // pattern `ecs.ts` uses for `containerDefinitions`.
      eventPattern: pulumi.jsonStringify({
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: { clusterArn: [ecsClusterArn], lastStatus: ['RUNNING', 'STOPPED'] },
      }),
    },
    opts,
  );

  const dnsUpdaterEventTarget = new aws.cloudwatch.EventTarget(
    `${projectName}-dns-updater-target`,
    {
      rule: ecsTaskChangeRule.name,
      targetId: 'GameServerDnsUpdater',
      arn: dnsUpdaterFunction.arn,
    },
    opts,
  );

  const dnsUpdaterEventBridgePermission = new aws.lambda.Permission(
    `${projectName}-dns-updater-eventbridge`,
    {
      statementId: 'AllowDnsUpdaterEventBridge',
      action: 'lambda:InvokeFunction',
      function: dnsUpdaterFunction.name,
      principal: 'events.amazonaws.com',
      sourceArn: ecsTaskChangeRule.arn,
    },
    opts,
  );

  // ── Per-game EFS-seeder Lambdas (efs-seeder.tf) ────────────────────────────
  // Iterates `roles.efsSeederRoles` (not a freshly-recomputed
  // `gamesWithFileSeeds`) so this set can never drift from the roles
  // `defineIamRoles` actually created — the same "never drift" argument
  // `iam.ts`'s `defineIamPolicies` already applies to its own
  // `efsSeederPolicies` loop. The shared security group these functions'
  // `vpc_config` reference is NOT constructed here — `securityGroups.ts`
  // now owns it (see this file's doc); `efsSeederSecurityGroupId` is that
  // group's `.id`, passed straight through and already validated above.
  const efsSeederLogGroups: Record<string, aws.cloudwatch.LogGroup> = {};
  const efsSeederFunctions: Record<string, aws.lambda.Function> = {};

  if (seederGames.length > 0) {
    // Non-null per the up-front validation above (`seederGames.length > 0`
    // there already ruled out `undefined`) — re-asserted as a local const
    // rather than a bare `!` at the use site so the narrowing is explicit
    // and doesn't need re-justifying inside the loop below.
    const seederSecurityGroupId = efsSeederSecurityGroupId as pulumi.Input<string>;

    for (const [game, role] of seederGames) {
      const config = gameServers[game];
      const firstVolumeName = config.volumes[0].name;
      const accessPointArn = efs.gameAccessPoints[`${game}-${firstVolumeName}`].arn;

      const logGroup = new aws.cloudwatch.LogGroup(
        `${projectName}-efs-seeder-${game}-logs`,
        {
          name: `/aws/lambda/${projectName}-efs-seeder-${game}`,
          retentionInDays: 7,
          tags: { Name: `${projectName}-efs-seeder-${game}-logs` },
        },
        opts,
      );
      efsSeederLogGroups[game] = logGroup;

      efsSeederFunctions[game] = new aws.lambda.Function(
        `${projectName}-efs-seeder-${game}`,
        {
          name: `${projectName}-efs-seeder-${game}`,
          role: role.arn,
          handler: LAMBDA_HANDLER,
          runtime: LAMBDA_RUNTIME,
          code: lambdaCode(bundlePath(lambdaBundlesDir, 'efs-seeder')),
          timeout: 60,
          vpcConfig: {
            subnetIds: publicSubnetIds,
            securityGroupIds: [seederSecurityGroupId],
          },
          // Mounts the game's first volume's EFS access point at /mnt/efs —
          // seed paths must use that volume's `container_path` as a prefix
          // (enforced by the seeder handler itself, not this program).
          fileSystemConfig: {
            arn: accessPointArn,
            localMountPath: '/mnt/efs',
          },
          environment: { variables: { AWS_REGION_: awsRegion } },
          tags: { Name: `${projectName}-efs-seeder-${game}` },
        },
        {
          ...opts,
          // Genuine AWS-level preconditions, not the IAM-policy ordering
          // this file's doc explains is deliberately not replicated — see
          // "Lambda role/policy creation order" above.
          dependsOn: [logGroup, ...efs.mountTargets],
        },
      );
    }
  }

  return {
    interactionsFunction,
    interactionsLogGroup,
    interactionsFunctionUrl,
    interactionsUrlInvokeUrlPermission,
    interactionsUrlInvokePermission,
    followupFunction,
    followupLogGroup,
    watchdogFunction,
    watchdogLogGroup,
    watchdogScheduleRule,
    watchdogScheduleTarget,
    watchdogEventBridgePermission,
    dnsUpdaterFunction,
    dnsUpdaterLogGroup,
    ecsTaskChangeRule,
    dnsUpdaterEventTarget,
    dnsUpdaterEventBridgePermission,
    efsSeederLogGroups,
    efsSeederFunctions,
  };
}
