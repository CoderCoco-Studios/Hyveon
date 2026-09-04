/**
 * IAM roles and inline policies — the ECS task-execution role and its
 * managed-policy attachment, plus every per-Lambda role/policy pair
 * (watchdog, followup, interactions, DNS-updater, health-check, per-game
 * EFS-seeder). See `docs/docs/components/infra.md` for the full resource
 * inventory.
 *
 * ## Why this is two functions, not one
 *
 * Role and policy declaration can't collapse into a single eagerly-evaluated
 * function: the followup Lambda's role must exist *before* `defineLambdas`
 * runs (it needs the role's ARN to create the Lambda function), while the
 * interactions Lambda's inline policy needs the followup Lambda's ARN back
 * (to grant it `lambda:InvokeFunction`) — no single call, run once, can
 * satisfy both directions.
 *
 * Splitting into {@link defineIamRoles} (needs nothing from any later step)
 * and {@link defineIamPolicies} (needs the roles back, plus every deferred
 * ARN) resolves this: `defineIamRoles()` → `defineLambdas()` (using
 * `roles.followupLambdaRole.arn` etc.) → `defineIamPolicies()` (using the
 * roles plus the now-real `followupLambdaArn`). `program.ts`'s `defineAll`
 * calls both functions in exactly this order.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';

/** Every IAM role and the managed-policy attachment {@link defineIamRoles} declares — see this file's doc for the full resource table. */
export interface IamRoleResources {
  /** ECS task-execution role — assumed by `ecs-tasks.amazonaws.com` to pull images and write logs on every game-server task. */
  ecsTaskExecutionRole: aws.iam.Role;
  /** Attaches the AWS-managed `AmazonECSTaskExecutionRolePolicy` to {@link ecsTaskExecutionRole}. */
  ecsTaskExecutionPolicyAttachment: aws.iam.RolePolicyAttachment;
  /** Watchdog Lambda's role. */
  watchdogLambdaRole: aws.iam.Role;
  /** Followup Lambda's role. */
  followupLambdaRole: aws.iam.Role;
  /** Interactions Lambda's role. */
  interactionsLambdaRole: aws.iam.Role;
  /** DNS-updater Lambda's role. */
  dnsUpdaterLambdaRole: aws.iam.Role;
  /**
   * Per-game EFS-seeder role, keyed by game name — one entry per
   * {@link gamesWithFileSeeds} key.
   */
  efsSeederRoles: Record<string, aws.iam.Role>;
  /**
   * Role EventBridge Scheduler assumes to invoke `ecs:StopTask` for the
   * FileBrowser helper's one-time auto-stop schedule — trust-scoped to
   * `scheduler.amazonaws.com`, no HCL analogue (added post-migration).
   */
  fileBrowserSchedulerRole: aws.iam.Role;
  /**
   * The health-check Lambda's role — a single shared role (not one per game,
   * unlike {@link efsSeederRoles}), created only when
   * {@link gamesWithHealthChecks} is non-empty. `undefined` in every
   * deployment where no game declares a `healthCheck`, which is what makes
   * that capability's zero-footprint requirement hold at the IAM layer. No
   * HCL analogue (added post-migration).
   */
  healthCheckLambdaRole: aws.iam.Role | undefined;
}

/** Every inline policy {@link defineIamPolicies} declares — see this file's doc for the full resource table. */
export interface IamPolicyResources {
  /** Watchdog Lambda's inline policy. */
  watchdogLambdaPolicy: aws.iam.RolePolicy;
  /** Followup Lambda's inline policy. */
  followupLambdaPolicy: aws.iam.RolePolicy;
  /** Interactions Lambda's inline policy. */
  interactionsLambdaPolicy: aws.iam.RolePolicy;
  /** DNS-updater Lambda's inline policy. */
  dnsUpdaterLambdaPolicy: aws.iam.RolePolicy;
  /**
   * Per-game EFS-seeder inline policy, keyed the same way as
   * {@link IamRoleResources.efsSeederRoles}.
   */
  efsSeederPolicies: Record<string, aws.iam.RolePolicy>;
  /**
   * {@link IamRoleResources.fileBrowserSchedulerRole}'s inline policy —
   * grants `ecs:StopTask` scoped to tasks in the deployed ECS cluster only.
   * No HCL analogue (added post-migration).
   */
  fileBrowserSchedulerPolicy: aws.iam.RolePolicy;
  /**
   * {@link IamRoleResources.healthCheckLambdaRole}'s inline policy —
   * `undefined` whenever that role is, i.e. whenever no game declares a
   * `healthCheck`. No HCL analogue (added post-migration).
   */
  healthCheckLambdaPolicy: aws.iam.RolePolicy | undefined;
}

/**
 * The full IAM resource set once both {@link defineIamRoles} and
 * {@link defineIamPolicies} have run — a convenience type for a caller that
 * wants to hold every declared role and policy in one object (e.g.
 * `program.ts` merging both calls' results into `InfraResources`). Neither
 * `defineIamRoles` nor `defineIamPolicies` returns this shape directly; see
 * this file's doc for why they stay two separate functions/calls.
 */
export type IamResources = IamRoleResources & IamPolicyResources;

/** Arguments {@link defineIamRoles} needs to declare every IAM role and the managed-policy attachment. */
export interface DefineIamRolesArgs {
  /** Every role name below is `${projectName}-...`. */
  projectName: string;
  /**
   * The configured game-server map (`DeploymentConfig.gameServers`) —
   * {@link gamesWithFileSeeds} filters it down to the games that get a
   * per-game EFS-seeder role.
   */
  gameServers: Record<string, GameServerConfig>;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/** Arguments {@link defineIamPolicies} needs to declare every inline policy. */
export interface DefineIamPoliciesArgs {
  /** Every policy name below is `${projectName}-...`. */
  projectName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
  /**
   * The role set {@link defineIamRoles} returned — every policy attaches to
   * one of these roles by `.id`, and the followup policy's `iam:PassRole`
   * statement targets {@link IamRoleResources.ecsTaskExecutionRole}'s `.arn`
   * directly (a live, same-program reference, not a deferred parameter).
   * The per-game EFS-seeder policies are declared for exactly the games
   * present in `roles.efsSeederRoles` — this function does not re-derive
   * that set from a `gameServers` map of its own, so it can never drift from
   * the roles {@link defineIamRoles} actually created.
   */
  roles: IamRoleResources;

  /**
   * `aws_efs_file_system.saves.arn` — the shared EFS filesystem every
   * per-game EFS-seeder role's inline policy grants
   * `elasticfilesystem:ClientMount`/`ClientWrite` against. Threaded here as a
   * required parameter (rather than constructed by this function) because
   * `efs.ts`'s `defineEfs` owns that resource; `program.ts`'s `defineAll`
   * passes `efs.fileSystem.arn`.
   */
  efsFileSystemArn: pulumi.Input<string>;
  /**
   * `aws_dynamodb_table.discord.arn` — the shared Discord state table.
   * Granted to the followup Lambda (`dynamodb:GetItem`/`PutItem`), the
   * interactions Lambda (`dynamodb:GetItem`), and the DNS-updater Lambda
   * (`dynamodb:GetItem`/`DeleteItem`). Threaded here as a required parameter
   * because `dynamodb.ts`'s `defineDynamoDb` owns that table; `program.ts`'s
   * `defineAll` passes `dynamoDb.discordTable.arn`.
   */
  dynamodbDiscordTableArn: pulumi.Input<string>;
  /**
   * `aws_secretsmanager_secret.discord_public_key.arn` — granted to the
   * interactions Lambda (`secretsmanager:GetSecretValue`) to verify Discord's
   * Ed25519 request signature. Threaded here as a required parameter because
   * `secrets.ts`'s `defineSecrets` owns that secret; `program.ts`'s
   * `defineAll` passes `secrets.discordPublicKeySecret.arn`.
   */
  discordPublicKeySecretArn: pulumi.Input<string>;
  /**
   * `aws_lambda_function.followup.arn` — granted to the interactions Lambda
   * (`lambda:InvokeFunction`) so it can async-invoke the followup Lambda for
   * slow ECS work. Threaded here as a required parameter because
   * `lambdas.ts`'s `defineLambdas` owns that function and must run first —
   * see this file's doc for the full call-order rationale. `program.ts`'s
   * `defineAll` calls `defineLambdas()` before `defineIamPolicies()` and
   * passes `lambdas.followupFunction.arn`.
   */
  followupLambdaArn: pulumi.Input<string>;
  /**
   * `data.aws_route53_zone.main.zone_id` — the looked-up hosted zone,
   * interpolated into the DNS-updater Lambda's `route53:*` resource ARNs
   * (`arn:aws:route53:::hostedzone/${zone_id}`). Threaded here as a required
   * parameter because `route53.ts`'s `defineRoute53` owns that lookup;
   * `program.ts`'s `defineAll` passes `route53.zoneId`.
   */
  hostedZoneId: pulumi.Input<string>;
  /**
   * `aws_ecs_cluster.main.name` — scopes
   * {@link IamPolicyResources.fileBrowserSchedulerPolicy}'s `ecs:StopTask`
   * grant, and {@link IamPolicyResources.healthCheckLambdaPolicy}'s
   * `ecs:DescribeTasks` grant, to `arn:aws:ecs:*:*:task/${ecsClusterName}/*`
   * rather than every task in the account. Threaded here as a required
   * parameter because `ecs.ts`'s `defineEcs` owns that cluster; `program.ts`'s
   * `defineAll` passes `ecs.cluster.name`.
   */
  ecsClusterName: pulumi.Input<string>;
  /**
   * The configured game-server map — re-read here (not just via `roles`) so
   * {@link IamPolicyResources.healthCheckLambdaPolicy} can scope its
   * `secretsmanager:GetSecretValue` grant to exactly the `auth.secretArn`
   * values opted-in games reference. These ARNs are plain config strings,
   * not Pulumi-deferred outputs, so no separate threaded parameter is
   * needed for them the way {@link followupLambdaArn} etc. are.
   */
  gameServers: Record<string, GameServerConfig>;
  /**
   * `aws_lambda_function.health_check.arn` — granted to the watchdog Lambda
   * (`lambda:InvokeFunction`) so it can invoke the health-check Lambda for
   * an opted-in game's idle decision. `undefined` whenever no game declares
   * a `healthCheck`, in which case the watchdog policy gets no
   * `lambda:InvokeFunction` statement at all. Threaded here as a required
   * parameter for the same call-order reason as {@link followupLambdaArn}:
   * `lambdas.ts`'s `defineLambdas` owns that function and must run first;
   * `program.ts`'s `defineAll` passes `lambdas.healthCheckFunction?.arn`.
   */
  healthCheckFunctionArn: pulumi.Input<string> | undefined;
}

/**
 * Filters a game-server map down to entries declaring at least one file
 * seed, mirroring the legacy tool's EFS-seeder resource area's
 * `local.games_with_seeds` local (`if length(cfg.file_seeds) > 0`) — exactly the games that get a
 * per-game EFS-seeder IAM role declared by {@link defineIamRoles} (and, in
 * turn, a policy declared by {@link defineIamPolicies}).
 *
 * @param gameServers - The configured game-server map to filter.
 * @returns The subset of `gameServers` entries with at least one file seed, keyed the same way.
 */
export function gamesWithFileSeeds(gameServers: Record<string, GameServerConfig>): Record<string, GameServerConfig> {
  const result: Record<string, GameServerConfig> = {};
  for (const [game, config] of Object.entries(gameServers)) {
    if ((config.file_seeds?.length ?? 0) > 0) {
      result[game] = config;
    }
  }
  return result;
}

/**
 * Filters a game-server map down to entries declaring a `healthCheck` —
 * exactly the games whose running tasks are checked via the shared
 * health-check Lambda instead of the network-traffic heuristic, and thus the
 * set that determines whether that Lambda, its role, and its security group
 * are provisioned at all (see `lambda-runtime-currency`/`game-health-checks`
 * OpenSpec capabilities). Unlike {@link gamesWithFileSeeds}, this set backs a
 * single shared role rather than one role per game.
 *
 * @param gameServers - The configured game-server map to filter.
 * @returns The subset of `gameServers` entries declaring a `healthCheck`, keyed the same way.
 */
export function gamesWithHealthChecks(gameServers: Record<string, GameServerConfig>): Record<string, GameServerConfig> {
  const result: Record<string, GameServerConfig> = {};
  for (const [game, config] of Object.entries(gameServers)) {
    if (config.healthCheck != null) {
      result[game] = config;
    }
  }
  return result;
}

/**
 * Builds an IAM trust (assume-role) policy document granting `sts:AssumeRole`
 * to a single AWS service principal, JSON-encoded exactly as every ported
 * HCL `assume_role_policy` block's `jsonencode(...)` call produces — the
 * identical trust document repeated verbatim across the HCL
 * (`ecs-tasks.amazonaws.com` for the ECS task-execution role,
 * `lambda.amazonaws.com` for every Lambda role). Returned as a plain JSON
 * string (not `pulumi.jsonStringify`) since the service principal is always
 * a static literal, never a Pulumi `Output`.
 *
 * @param service - The AWS service principal allowed to assume the role
 *   (e.g. `"lambda.amazonaws.com"`).
 * @returns The trust policy document as a JSON string.
 */
function assumeRolePolicyForService(service: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: service } }],
  });
}

/** The `lambda.amazonaws.com` trust policy shared by every Lambda role this module declares. */
const LAMBDA_ASSUME_ROLE_POLICY = assumeRolePolicyForService('lambda.amazonaws.com');

/**
 * Builds the `logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents` statement
 * every Lambda inline policy in the ported HCL opens with, granted against
 * the same `arn:aws:logs:*:*:*` wildcard in every case. A factory (rather
 * than a shared constant) so each of the five inline policies below embeds
 * its own object — and its own `Action` array — instead of five documents
 * holding references to one mutable object graph.
 *
 * @returns A fresh `Statement` entry object for the logs grant.
 */
function logStatement(): { Effect: string; Action: string[]; Resource: string } {
  return {
    Effect: 'Allow',
    Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
    Resource: 'arn:aws:logs:*:*:*',
  };
}

/**
 * Builds the `ec2:CreateNetworkInterface`/`DescribeNetworkInterfaces`/`DeleteNetworkInterface`
 * statement every VPC-attached Lambda inline policy in this module needs to
 * manage its ENI. A factory for the same reason as {@link logStatement}.
 *
 * @returns A fresh `Statement` entry object for the VPC-networking grant.
 */
function vpcNetworkingStatement(): { Effect: string; Action: string[]; Resource: string } {
  return {
    Effect: 'Allow',
    Action: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface'],
    Resource: '*',
  };
}

/**
 * Declares every IAM role and the managed-policy attachment — see this
 * file's doc for the full address table and why roles and policies are
 * split across two functions. Needs nothing from any later step (every
 * role's trust policy is a static literal). Must be called from inside the
 * Pulumi inline-program closure, never at module scope.
 *
 * @param args - Naming, config, and provider inputs — see
 *   {@link DefineIamRolesArgs}.
 * @returns The declared roles/attachment — see {@link IamRoleResources}.
 */
export function defineIamRoles(args: DefineIamRolesArgs): IamRoleResources {
  const { projectName, gameServers, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // ── ECS task-execution role ────────────────────────────────────────────────
  const ecsTaskExecutionRole = new aws.iam.Role(
    `${projectName}-task-execution`,
    {
      name: `${projectName}-task-execution`,
      assumeRolePolicy: assumeRolePolicyForService('ecs-tasks.amazonaws.com'),
    },
    opts,
  );

  const ecsTaskExecutionPolicyAttachment = new aws.iam.RolePolicyAttachment(
    `${projectName}-task-execution-attachment`,
    {
      role: ecsTaskExecutionRole.name,
      policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    },
    opts,
  );

  // ── Per-Lambda roles (watchdog, followup, interactions, dns-updater) ──────
  const watchdogLambdaRole = new aws.iam.Role(
    `${projectName}-watchdog-lambda`,
    { name: `${projectName}-watchdog-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const followupLambdaRole = new aws.iam.Role(
    `${projectName}-followup-lambda`,
    { name: `${projectName}-followup-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const interactionsLambdaRole = new aws.iam.Role(
    `${projectName}-interactions-lambda`,
    { name: `${projectName}-interactions-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const dnsUpdaterLambdaRole = new aws.iam.Role(
    `${projectName}-dns-updater-lambda`,
    { name: `${projectName}-dns-updater-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  // ── Per-game EFS-seeder roles ──────────────────────────────────────────────
  const efsSeederRoles: Record<string, aws.iam.Role> = {};
  for (const game of Object.keys(gamesWithFileSeeds(gameServers))) {
    efsSeederRoles[game] = new aws.iam.Role(
      `${projectName}-efs-seeder-${game}`,
      { name: `${projectName}-efs-seeder-${game}`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
      opts,
    );
  }

  // ── FileBrowser auto-stop scheduler role (no HCL analogue) ────────────────
  const fileBrowserSchedulerRole = new aws.iam.Role(
    `${projectName}-filebrowser-scheduler`,
    { name: `${projectName}-filebrowser-scheduler`, assumeRolePolicy: assumeRolePolicyForService('scheduler.amazonaws.com') },
    opts,
  );

  // ── Health-check Lambda role — single shared role, conditional ────────────
  const healthCheckLambdaRole =
    Object.keys(gamesWithHealthChecks(gameServers)).length > 0
      ? new aws.iam.Role(
          `${projectName}-health-check-lambda`,
          { name: `${projectName}-health-check-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
          opts,
        )
      : undefined;

  return {
    ecsTaskExecutionRole,
    ecsTaskExecutionPolicyAttachment,
    watchdogLambdaRole,
    followupLambdaRole,
    interactionsLambdaRole,
    dnsUpdaterLambdaRole,
    efsSeederRoles,
    fileBrowserSchedulerRole,
    healthCheckLambdaRole,
  };
}

/**
 * Declares every inline policy — see this file's doc for the full address
 * table and why roles and policies are split across two functions. Must run
 * after {@link defineIamRoles} (its `roles` argument) and, in a live
 * `defineAll` wiring, after `defineLambdas` has supplied
 * `args.followupLambdaArn` — see {@link DefineIamPoliciesArgs}'s doc. Must
 * be called from inside the Pulumi inline-program closure, never at module
 * scope.
 *
 * @param args - The role set, provider, and deferred-ARN inputs — see
 *   {@link DefineIamPoliciesArgs}.
 * @returns The declared policies — see {@link IamPolicyResources}.
 */
export function defineIamPolicies(args: DefineIamPoliciesArgs): IamPolicyResources {
  const {
    projectName,
    provider,
    roles,
    efsFileSystemArn,
    dynamodbDiscordTableArn,
    discordPublicKeySecretArn,
    followupLambdaArn,
    hostedZoneId,
    ecsClusterName,
    gameServers,
    healthCheckFunctionArn,
  } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // ── Watchdog Lambda policy ──────────────────────────────────────────────
  // `pulumi.jsonStringify` (not a plain `JSON.stringify`) because
  // `healthCheckFunctionArn` may be a deferred Output when a health check is
  // declared; the statement list is built up front so the conditional
  // `lambda:InvokeFunction` grant reads as a single insertion point instead
  // of two near-duplicate policy literals.
  const watchdogStatements: pulumi.Input<Record<string, unknown>>[] = [
    logStatement(),
    {
      Effect: 'Allow',
      Action: ['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:StopTask', 'ecs:TagResource', 'ecs:ListTagsForResource'],
      Resource: '*',
    },
    { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
    { Effect: 'Allow', Action: ['cloudwatch:GetMetricStatistics'], Resource: '*' },
  ];
  if (healthCheckFunctionArn) {
    watchdogStatements.push({ Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: healthCheckFunctionArn });
  }
  const watchdogLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-watchdog-lambda-policy`,
    {
      name: `${projectName}-watchdog-lambda-policy`,
      role: roles.watchdogLambdaRole.id,
      policy: pulumi.jsonStringify({ Version: '2012-10-17', Statement: watchdogStatements }),
    },
    opts,
  );

  // ── Followup Lambda policy ─────────────────────────────────────────────────
  const followupLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-followup-lambda-policy`,
    {
      name: `${projectName}-followup-lambda-policy`,
      role: roles.followupLambdaRole.id,
      // `iam:PassRole` targets the ECS task-execution role from `roles`
      // (live, same-program reference) — the DynamoDB grant targets the
      // `discord` table (a deferred ARN) — hence `pulumi.jsonStringify`
      // rather than a plain `JSON.stringify`, to resolve both Output-typed
      // ARNs into the final JSON string.
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          logStatement(),
          { Effect: 'Allow', Action: ['ecs:RunTask', 'ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'], Resource: '*' },
          {
            Effect: 'Allow',
            Action: ['ecs:TagResource'],
            Resource: '*',
            Condition: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
          },
          { Effect: 'Allow', Action: ['iam:PassRole'], Resource: roles.ecsTaskExecutionRole.arn },
          { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
          { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: dynamodbDiscordTableArn },
        ],
      }),
    },
    opts,
  );

  // ── Interactions Lambda policy ─────────────────────────────────────────────
  const interactionsLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-interactions-lambda-policy`,
    {
      name: `${projectName}-interactions-lambda-policy`,
      role: roles.interactionsLambdaRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          logStatement(),
          { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: dynamodbDiscordTableArn },
          { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: discordPublicKeySecretArn },
          { Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: followupLambdaArn },
        ],
      }),
    },
    opts,
  );

  // ── DNS-updater Lambda policy ──────────────────────────────────────────────
  const dnsUpdaterLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-dns-updater-lambda-policy`,
    {
      name: `${projectName}-dns-updater-lambda-policy`,
      role: roles.dnsUpdaterLambdaRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          logStatement(),
          { Effect: 'Allow', Action: ['ecs:DescribeTasks'], Resource: '*' },
          { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
          {
            Effect: 'Allow',
            Action: ['route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets', 'route53:GetChange'],
            Resource: [pulumi.interpolate`arn:aws:route53:::hostedzone/${hostedZoneId}`, 'arn:aws:route53:::change/*'],
          },
          { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:DeleteItem'], Resource: dynamodbDiscordTableArn },
        ],
      }),
    },
    opts,
  );

  // ── Per-game EFS-seeder policies ───────────────────────────────────────────
  // Iterates `roles.efsSeederRoles` (not a freshly-recomputed
  // `gamesWithFileSeeds`) so the policies declared here can never drift from
  // the roles `defineIamRoles` actually created — see `DefineIamPoliciesArgs`
  // `roles`' doc.
  const efsSeederPolicies: Record<string, aws.iam.RolePolicy> = {};
  for (const [game, role] of Object.entries(roles.efsSeederRoles)) {
    efsSeederPolicies[game] = new aws.iam.RolePolicy(
      `${projectName}-efs-seeder-${game}-policy`,
      {
        name: `${projectName}-efs-seeder-${game}-policy`,
        role: role.id,
        policy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: [
            logStatement(),
            vpcNetworkingStatement(),
            {
              Effect: 'Allow',
              Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
              Resource: efsFileSystemArn,
            },
          ],
        }),
      },
      opts,
    );
  }

  // ── FileBrowser auto-stop scheduler policy (no HCL analogue) ──────────────
  // `ecs:StopTask` scoped to tasks in the deployed cluster only — tighter
  // than the watchdog/followup policies' `Resource: '*'` above, since this
  // role's only job is stopping one task EventBridge Scheduler was told to
  // stop, never listing or describing anything else in the account.
  const fileBrowserSchedulerPolicy = new aws.iam.RolePolicy(
    `${projectName}-filebrowser-scheduler-policy`,
    {
      name: `${projectName}-filebrowser-scheduler-policy`,
      role: roles.fileBrowserSchedulerRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['ecs:StopTask'],
            Resource: pulumi.interpolate`arn:aws:ecs:*:*:task/${ecsClusterName}/*`,
          },
        ],
      }),
    },
    opts,
  );

  // ── Health-check Lambda policy — single shared, conditional ───────────────
  // `roles.healthCheckLambdaRole` is `undefined` in the same deployments
  // where `gamesWithHealthChecks(gameServers)` is empty (both derive from
  // the same set — see `defineIamRoles`), so branching on the role rather
  // than re-deriving the set here keeps this policy from ever drifting from
  // the role `defineIamRoles` actually created, the same discipline the
  // per-game EFS-seeder policies above follow.
  const healthCheckSecretArns = Object.values(gamesWithHealthChecks(gameServers))
    .map((config) => config.healthCheck?.auth?.secretArn)
    .filter((arn): arn is string => arn != null);

  const healthCheckLambdaPolicy = roles.healthCheckLambdaRole
    ? new aws.iam.RolePolicy(
        `${projectName}-health-check-lambda-policy`,
        {
          name: `${projectName}-health-check-lambda-policy`,
          role: roles.healthCheckLambdaRole.id,
          policy: pulumi.jsonStringify({
            Version: '2012-10-17',
            Statement: [
              logStatement(),
              vpcNetworkingStatement(),
              {
                Effect: 'Allow',
                Action: ['ecs:DescribeTasks'],
                Resource: pulumi.interpolate`arn:aws:ecs:*:*:task/${ecsClusterName}/*`,
              },
              ...(healthCheckSecretArns.length > 0
                ? [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: healthCheckSecretArns }]
                : []),
            ],
          }),
        },
        opts,
      )
    : undefined;

  return {
    watchdogLambdaPolicy,
    followupLambdaPolicy,
    interactionsLambdaPolicy,
    dnsUpdaterLambdaPolicy,
    efsSeederPolicies,
    fileBrowserSchedulerPolicy,
    healthCheckLambdaPolicy,
  };
}
