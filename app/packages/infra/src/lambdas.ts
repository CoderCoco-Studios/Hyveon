/**
 * The six Lambda functions (interactions, followup, watchdog, dns-updater,
 * health-check, and per-game EFS-seeder), their log groups, permissions, the
 * interactions Function URL, and the watchdog/dns-updater EventBridge
 * rule/target pairs. See `docs/docs/components/infra.md` for the full
 * resource inventory.
 *
 * `aws_lambda_invocation.efs_seeder`-equivalent work (the file-seed write
 * trigger) is NOT in this file — `escapes.ts`'s `defineEfsSeederInvocations`
 * owns it and carries an explicit `dependsOn` on `efsSeederPolicies[game]`,
 * since this file's own policies attach after functions exist (see below).
 * `program.ts`'s `defineAll` calls `defineEfsSeederInvocations` after both
 * this file's `defineLambdas` and `iam.ts`'s `defineIamPolicies`.
 *
 * ## The lambda-bundle path contract
 *
 * {@link DefineLambdasArgs.lambdaBundlesDir} is a REQUIRED parameter with no
 * default computed anywhere in this package. A repo-relative default derived
 * from `import.meta.url` would resolve correctly in a repo checkout, but
 * `electron-vite` bundles this package into a single `out/main` artifact for
 * the packaged app, so such a default would silently resolve to a
 * nonexistent path there — passing every unit test (which import this
 * module unbundled) while only breaking inside the packaged app, which the
 * unit tests don't exercise. So every caller supplies `lambdaBundlesDir`
 * explicitly: unit tests pass a placeholder (Pulumi's mocked resource
 * registration never touches the filesystem); `PulumiService` resolves a
 * real directory (env var override, then `app.isPackaged`, then a
 * repo-relative dev fallback) before calling `defineAll`; `program.ts`
 * threads it through via `InfraProgramOptions`.
 *
 * ## Lambda role/policy creation order
 *
 * `defineIamRoles` runs first, `defineLambdas` (this file) next referencing
 * only each role's ARN, and `defineIamPolicies` last — necessarily, since one
 * of its inputs (`followupLambdaArn`) doesn't exist until `defineLambdas` has
 * created the followup function. So the seeder invocation in `escapes.ts`
 * needs the explicit `dependsOn` described above: policies attach strictly
 * after functions, not before.
 */

import path from 'node:path';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig, GameServerHealthCheck } from '@hyveon/shared';
import type { EfsResources } from './efs.js';
import { stripTrailingDots } from './hostedZoneName.js';
import type { IamRoleResources } from './iam.js';

/** Node.js Lambda runtime every one of the five functions declares. */
const LAMBDA_RUNTIME = 'nodejs24.x';

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

  /**
   * The shared health-check Lambda's log group. `undefined` exactly when
   * `roles.healthCheckLambdaRole` is (no game declares a `healthCheck`). No
   * HCL analogue (added post-migration).
   */
  healthCheckLogGroup: aws.cloudwatch.LogGroup | undefined;
  /**
   * The shared health-check Lambda invoked by the watchdog for a game with a
   * declared `healthCheck`, in place of the CloudWatch network-packet
   * heuristic — a single function serving every opted-in game, unlike the
   * per-game {@link efsSeederFunctions}. No Function URL: it is invocable
   * only by the watchdog, via the identity-policy grant in
   * `iam.ts`'s `IamPolicyResources.watchdogLambdaPolicy`, never a
   * resource-based `aws.lambda.Permission`. `undefined` exactly when
   * {@link healthCheckLogGroup} is. No HCL analogue (added post-migration).
   */
  healthCheckFunction: aws.lambda.Function | undefined;
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
  /**
   * The shared health-check Lambda security group's id —
   * `securityGroups.ts`'s `SecurityGroupResources.healthCheck?.id`.
   * `undefined` is only valid when no game declares a `healthCheck`
   * (mirroring {@link efsSeederSecurityGroupId}'s own contract exactly) —
   * passing `undefined` while `roles.healthCheckLambdaRole` exists is a
   * caller bug and {@link defineLambdas} throws rather than silently
   * omitting `vpc_config.security_group_ids`.
   */
  healthCheckSecurityGroupId: pulumi.Input<string> | undefined;
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
   * rationale and what a caller (tests; `PulumiService`) must supply.
   */
  lambdaBundlesDir: string;

  /**
   * `aws_dynamodb_table.discord.name` — the interactions, followup, and
   * dns-updater functions' `TABLE_NAME` environment variable. Threaded here
   * as a required parameter because `dynamodb.ts`'s `defineDynamoDb` owns
   * that table; `program.ts`'s `defineAll` passes `dynamoDb.discordTable.name`.
   */
  dynamodbDiscordTableName: pulumi.Input<string>;
  /**
   * `aws_secretsmanager_secret.discord_public_key.arn` — the interactions
   * function's `DISCORD_PUBLIC_KEY_SECRET_ARN` environment variable.
   * Threaded here as a required parameter because `secrets.ts`'s
   * `defineSecrets` owns that secret; `program.ts`'s `defineAll` passes
   * `secrets.discordPublicKeySecret.arn`.
   */
  discordPublicKeySecretArn: pulumi.Input<string>;
  /**
   * `data.aws_route53_zone.main.zone_id` — the dns-updater function's
   * `HOSTED_ZONE_ID` environment variable. Threaded here as a required
   * parameter because `route53.ts`'s `defineRoute53` owns that lookup;
   * `program.ts`'s `defineAll` passes `route53.zoneId`.
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
 * Builds the `code` archive for a Lambda function from its bundle file — a
 * single named `FileAsset` under `handler.cjs`, matching {@link LAMBDA_HANDLER}.
 *
 * @param bundleFilePath - The resolved path to a package's `dist/handler.cjs` — see {@link bundlePath}.
 * @returns A single-entry `AssetArchive` containing the bundle.
 */
function lambdaCode(bundleFilePath: string): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({ 'handler.cjs': new pulumi.asset.FileAsset(bundleFilePath) });
}

/**
 * Comma-joined game names, sorted so the value is deterministic across
 * config-object iteration order.
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
 * entries iterated in the legacy tool's sorted-key order (see {@link gameNamesCsv}'s
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
 * functions — consumed to render the player-facing `host:port` connect
 * string, so the port chosen here must be one the internet can actually
 * reach. Mirrors the legacy tool's
 * `jsonencode({ for g, cfg in var.game_servers : g => cfg.ports[0].container if length(cfg.ports) > 0 })`
 * for every game whose `ports` are entirely `'public'`/omitted-visibility —
 * the legacy tool had no `visibility` concept, so that mirroring can only
 * hold where every port is public. When a game's first port is declared
 * `visibility: 'internal'` (e.g. a management/health port placed first —
 * see `docs/docs/app/games.md`'s Networking step docs), this instead picks
 * that game's first `'public'`/omitted-visibility port, so the advertised
 * connect address is never a port the security group blocks from outside
 * the VPC. Falls back to `ports[0]` only if a game declares no public port
 * at all — reproducing the pre-`visibility` behavior rather than omitting
 * the game entirely, since some port is a better guess than none. Same
 * sorted-key iteration as {@link connectMessagesByGame}.
 *
 * @param gameServers - The configured game-server map.
 * @returns A game name → first-public-container-port record, omitting games with no ports.
 */
function firstPortByGame(gameServers: Record<string, GameServerConfig>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const game of Object.keys(gameServers).sort()) {
    const ports = gameServers[game].ports;
    if (ports.length === 0) {
      continue;
    }
    const publicPort = ports.find((port) => port.visibility === undefined || port.visibility === 'public');
    result[game] = (publicPort ?? ports[0]).container;
  }
  return result;
}

/**
 * Builds the `HEALTH_CHECKS` JSON object the watchdog reads to route a
 * game's idle decision to the health-check Lambda instead of the
 * CloudWatch heuristic — game name → that game's full `healthCheck`
 * declaration, same sorted-key iteration as {@link connectMessagesByGame}.
 * Omits every game with no declared `healthCheck`.
 *
 * @param gameServers - The configured game-server map.
 * @returns A game name → `GameServerHealthCheck` record, omitting games with no declared health check.
 */
function healthChecksByGame(gameServers: Record<string, GameServerConfig>): Record<string, GameServerHealthCheck> {
  const result: Record<string, GameServerHealthCheck> = {};
  for (const game of Object.keys(gameServers).sort()) {
    const healthCheck = gameServers[game].healthCheck;
    if (healthCheck != null) {
      result[game] = healthCheck;
    }
  }
  return result;
}

/**
 * Declares every Lambda function, its log group, its permissions, the
 * interactions Function URL, and the watchdog/dns-updater EventBridge
 * rule/target/permission triples — see this file's doc for the full
 * HCL→Pulumi address table and the lambda-bundle path contract. Must be
 * called from inside the Pulumi inline-program closure, never at module
 * scope, and after `defineIamRoles`, `defineSecurityGroups`, `defineEfs`,
 * `defineEcs`, `defineDynamoDb`, `defineSecrets`, and `defineRoute53` (all
 * seven of whose outputs it consumes — `defineSecurityGroups` for
 * `efsSeederSecurityGroupId`, the latter three for the required
 * environment-variable inputs described above). `program.ts`'s `defineAll`
 * calls this function in exactly that order.
 *
 * @param args - Naming, config, IAM, network, EFS, bundle-path, and
 *   environment-variable inputs — see {@link DefineLambdasArgs}.
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
    healthCheckSecurityGroupId,
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

  // Strip any trailing dot before threading into any DOMAIN_NAME/
  // HOSTED_ZONE_NAME environment variable below — see `hostedZoneName.ts`.
  const strippedHostedZoneName = stripTrailingDots(hostedZoneName);

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
  if (roles.healthCheckLambdaRole && healthCheckSecurityGroupId === undefined) {
    throw new Error(
      'defineLambdas: at least one game declares healthCheck but healthCheckSecurityGroupId is undefined — ' +
        'pass securityGroups.healthCheck?.id (defineSecurityGroups must be called with the same gameServers map).',
    );
  }

  // ── Followup Lambda — declared before interactions so its
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
          DOMAIN_NAME: strippedHostedZoneName,
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

  // ── Interactions Lambda ─────────────────────────────────────────────────────
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
          HOSTED_ZONE_NAME: strippedHostedZoneName,
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

  // ── Health-check Lambda — declared BEFORE watchdog so its function name
  // is in scope for watchdog's HEALTH_CHECK_FUNCTION_NAME env var below,
  // matching the followup-before-interactions reference direction above.
  // Single shared function, conditional on `roles.healthCheckLambdaRole`
  // existing — checks the role itself (not a freshly-recomputed
  // `gamesWithHealthChecks`) for the same "never drift from what
  // `defineIamRoles` actually created" reason `efsSeederFunctions` checks
  // `roles.efsSeederRoles` below. No Function URL: invoked only by the
  // watchdog, via the IAM identity-policy grant in `iam.ts`'s
  // `watchdogLambdaPolicy`, never a resource-based `aws.lambda.Permission`.
  let healthCheckLogGroup: aws.cloudwatch.LogGroup | undefined;
  let healthCheckFunction: aws.lambda.Function | undefined;

  if (roles.healthCheckLambdaRole) {
    // Non-null per the up-front validation above — re-asserted as a local
    // const rather than a bare `!` at the use site, same as `seederSecurityGroupId` below.
    const healthCheckSg = healthCheckSecurityGroupId as pulumi.Input<string>;

    healthCheckLogGroup = new aws.cloudwatch.LogGroup(
      `${projectName}-health-check-logs`,
      {
        name: `/aws/lambda/${projectName}-health-check`,
        retentionInDays: 7,
        tags: { Name: `${projectName}-health-check-logs` },
      },
      opts,
    );

    healthCheckFunction = new aws.lambda.Function(
      `${projectName}-health-check`,
      {
        name: `${projectName}-health-check`,
        role: roles.healthCheckLambdaRole.arn,
        handler: LAMBDA_HANDLER,
        runtime: LAMBDA_RUNTIME,
        code: lambdaCode(bundlePath(lambdaBundlesDir, 'health-check')),
        // Above every individual check's own timeoutMs ceiling (10s) to give
        // headroom for the ECS DescribeTasks + Secrets Manager calls that
        // precede the checked request itself.
        timeout: 30,
        vpcConfig: {
          subnetIds: publicSubnetIds,
          securityGroupIds: [healthCheckSg],
        },
        environment: { variables: { AWS_REGION_: awsRegion } },
        tags: { Name: `${projectName}-health-check` },
      },
      { ...opts, dependsOn: [healthCheckLogGroup] },
    );
  }

  // ── Watchdog Lambda + EventBridge schedule ─────────────────────────────────
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
          HEALTH_CHECKS: JSON.stringify(healthChecksByGame(gameServers)),
          HEALTH_CHECK_FUNCTION_NAME: healthCheckFunction ? healthCheckFunction.name : '',
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

  // ── DNS-updater Lambda + EventBridge ECS-state-change rule ────────────────
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
          DOMAIN_NAME: strippedHostedZoneName,
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

  // ── Per-game EFS-seeder Lambdas ─────────────────────────────────────────────
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
          tags: { Name: `${projectName}-efs-seeder-${game}-logs`, Game: game },
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
          tags: { Name: `${projectName}-efs-seeder-${game}`, Game: game },
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
    healthCheckLogGroup,
    healthCheckFunction,
  };
}
