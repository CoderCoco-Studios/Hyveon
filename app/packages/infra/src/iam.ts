/**
 * IAM roles and inline policies — ported from `terraform/aws/main.tf`'s
 * `## IAM` block (the ECS task-execution role and its managed-policy
 * attachment) plus every per-Lambda role/policy pair scattered across
 * `terraform/aws/{followup,interactions,route53,watchdog,efs-seeder}.tf`
 * (task 3.5 of `migrate-iac-to-pulumi`). Every `aws_iam_*` resource in the
 * HCL lives here, even the ones whose *consumers* (the EFS filesystem, the
 * Lambda functions themselves, the DynamoDB table, the Secrets Manager
 * secret, the Route 53 hosted-zone lookup) are ported by later dispatches —
 * see {@link DefineIamPoliciesArgs}'s doc for how those forward references
 * are threaded.
 *
 * Six roles, five inline policies, one managed-policy attachment — matching
 * the task-3.5 brief's inventory exactly (confirmed by grepping the HCL for
 * `resource "aws_iam_`, no discrepancy found):
 *
 * | HCL address | This file |
 * | --- | --- |
 * | `aws_iam_role.ecs_task_execution` | {@link IamRoleResources.ecsTaskExecutionRole} |
 * | `aws_iam_role_policy_attachment.ecs_task_execution` | {@link IamRoleResources.ecsTaskExecutionPolicyAttachment} |
 * | `aws_iam_role.watchdog_lambda` | {@link IamRoleResources.watchdogLambdaRole} |
 * | `aws_iam_role_policy.watchdog_lambda` | {@link IamPolicyResources.watchdogLambdaPolicy} |
 * | `aws_iam_role.followup_lambda` | {@link IamRoleResources.followupLambdaRole} |
 * | `aws_iam_role_policy.followup_lambda` | {@link IamPolicyResources.followupLambdaPolicy} |
 * | `aws_iam_role.interactions_lambda` | {@link IamRoleResources.interactionsLambdaRole} |
 * | `aws_iam_role_policy.interactions_lambda` | {@link IamPolicyResources.interactionsLambdaPolicy} |
 * | `aws_iam_role.dns_updater_lambda` | {@link IamRoleResources.dnsUpdaterLambdaRole} |
 * | `aws_iam_role_policy.dns_updater_lambda` | {@link IamPolicyResources.dnsUpdaterLambdaPolicy} |
 * | `aws_iam_role.efs_seeder` (`for_each`) | {@link IamRoleResources.efsSeederRoles} |
 * | `aws_iam_role_policy.efs_seeder` (`for_each`) | {@link IamPolicyResources.efsSeederPolicies} |
 *
 * ## Why this is two functions, not one
 *
 * The HCL has no cycle: `aws_lambda_function.followup` (followup.tf)
 * consumes `aws_iam_role.followup_lambda.arn`, while
 * `aws_iam_role_policy.interactions_lambda` (interactions.tf) separately
 * consumes `aws_lambda_function.followup.arn` — role and policy are
 * independent graph nodes, and Terraform's declarative evaluation doesn't
 * care which "file" they live in. An earlier version of this module fused
 * every role AND every policy into one eagerly-evaluated `defineIam(...)`
 * call, which collapsed both nodes into one: that function would have to
 * run *before* `defineLambdas` (task 3.6, which needs role ARNs to create
 * the Lambda functions) while simultaneously *requiring* a Lambda ARN
 * (`followupLambdaArn`) as an input — no call order satisfies both, so the
 * deferred-parameter contract was unsatisfiable as written.
 *
 * Splitting into {@link defineIamRoles} (the six roles + the managed-policy
 * attachment — needs nothing from any later task) and
 * {@link defineIamPolicies} (the five inline policies — needs the roles
 * back, plus every deferred ARN) mirrors the HCL's own separation and
 * restores a satisfiable order: `defineIamRoles()` → `defineLambdas()`
 * (task 3.6, using `roles.followupLambdaRole.arn` etc.) → `defineIamPolicies()`
 * (using the roles plus the now-real `followupLambdaArn` from the Lambda
 * step, and whatever DynamoDB/EFS/Secrets/Route53 ARNs tasks 3.2/3.8/3.9
 * have supplied by then).
 *
 * NOT called from `program.ts`'s `defineAll` yet — see the `TODO(task 3.6)`
 * comment there for the order above, spelled out against real call sites.
 * `defineIamRoles` itself has no deferred inputs and could be wired in
 * immediately; it is left alongside `defineIamPolicies` for a later task to
 * wire in together, since `program.ts`'s `InfraResources` doesn't yet have
 * anywhere meaningful to route a bare role set on its own.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';

/** Every IAM role and the managed-policy attachment {@link defineIamRoles} declares — see this file's doc for the full HCL→Pulumi address table. */
export interface IamRoleResources {
  /** ECS task-execution role (`aws_iam_role.ecs_task_execution`) — assumed by `ecs-tasks.amazonaws.com` to pull images and write logs on every game-server task. */
  ecsTaskExecutionRole: aws.iam.Role;
  /** Attaches the AWS-managed `AmazonECSTaskExecutionRolePolicy` to {@link ecsTaskExecutionRole} (`aws_iam_role_policy_attachment.ecs_task_execution`). */
  ecsTaskExecutionPolicyAttachment: aws.iam.RolePolicyAttachment;
  /** Watchdog Lambda's role (`aws_iam_role.watchdog_lambda`). */
  watchdogLambdaRole: aws.iam.Role;
  /** Followup Lambda's role (`aws_iam_role.followup_lambda`). */
  followupLambdaRole: aws.iam.Role;
  /** Interactions Lambda's role (`aws_iam_role.interactions_lambda`). */
  interactionsLambdaRole: aws.iam.Role;
  /** DNS-updater Lambda's role (`aws_iam_role.dns_updater_lambda`). */
  dnsUpdaterLambdaRole: aws.iam.Role;
  /**
   * Per-game EFS-seeder role, keyed by game name — one entry per
   * {@link gamesWithFileSeeds} key (`aws_iam_role.efs_seeder`'s `for_each`).
   */
  efsSeederRoles: Record<string, aws.iam.Role>;
}

/** Every inline policy {@link defineIamPolicies} declares — see this file's doc for the full HCL→Pulumi address table. */
export interface IamPolicyResources {
  /** Watchdog Lambda's inline policy (`aws_iam_role_policy.watchdog_lambda`). */
  watchdogLambdaPolicy: aws.iam.RolePolicy;
  /** Followup Lambda's inline policy (`aws_iam_role_policy.followup_lambda`). */
  followupLambdaPolicy: aws.iam.RolePolicy;
  /** Interactions Lambda's inline policy (`aws_iam_role_policy.interactions_lambda`). */
  interactionsLambdaPolicy: aws.iam.RolePolicy;
  /** DNS-updater Lambda's inline policy (`aws_iam_role_policy.dns_updater_lambda`). */
  dnsUpdaterLambdaPolicy: aws.iam.RolePolicy;
  /**
   * Per-game EFS-seeder inline policy, keyed the same way as
   * {@link IamRoleResources.efsSeederRoles} (`aws_iam_role_policy.efs_seeder`'s
   * `for_each`).
   */
  efsSeederPolicies: Record<string, aws.iam.RolePolicy>;
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
  /** Mirrors `var.project_name` — every role name below is `${projectName}-...`, matching the HCL exactly. */
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
  /** Mirrors `var.project_name` — every policy name below is `${projectName}-...`, matching the HCL exactly. */
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
   * `elasticfilesystem:ClientMount`/`ClientWrite` against. TODO(task 3.2):
   * threaded here as a required parameter because `defineEfs` (task 3.2 of
   * `migrate-iac-to-pulumi`) has not run yet — `program.ts` must pass its
   * real `aws_efs_file_system.saves` equivalent's `.arn` once it exists.
   */
  efsFileSystemArn: pulumi.Input<string>;
  /**
   * `aws_dynamodb_table.discord.arn` — the shared Discord state table.
   * Granted to the followup Lambda (`dynamodb:GetItem`/`PutItem`), the
   * interactions Lambda (`dynamodb:GetItem`), and the DNS-updater Lambda
   * (`dynamodb:GetItem`/`DeleteItem`). TODO(task 3.8): threaded here as a
   * required parameter because the DynamoDB tables have not been ported yet
   * — `program.ts` must pass the real table's `.arn` once it exists.
   */
  dynamodbDiscordTableArn: pulumi.Input<string>;
  /**
   * `aws_secretsmanager_secret.discord_public_key.arn` — granted to the
   * interactions Lambda (`secretsmanager:GetSecretValue`) to verify Discord's
   * Ed25519 request signature. TODO(task 3.8): threaded here as a required
   * parameter because the Secrets Manager secrets have not been ported yet.
   */
  discordPublicKeySecretArn: pulumi.Input<string>;
  /**
   * `aws_lambda_function.followup.arn` — granted to the interactions Lambda
   * (`lambda:InvokeFunction`) so it can async-invoke the followup Lambda for
   * slow ECS work. TODO(task 3.6): threaded here as a required parameter
   * because the Lambda functions have not been ported yet. Satisfiable in
   * order: `defineIamRoles()` supplies `roles.followupLambdaRole.arn` for
   * the Lambda function's own `role` argument; `defineLambdas()` (task 3.6)
   * creates that function and its `.arn` flows into this field for the
   * `defineIamPolicies()` call that follows — see this file's doc.
   */
  followupLambdaArn: pulumi.Input<string>;
  /**
   * `data.aws_route53_zone.main.zone_id` — the looked-up hosted zone,
   * interpolated into the DNS-updater Lambda's `route53:*` resource ARNs
   * (`arn:aws:route53:::hostedzone/${zone_id}`). TODO(task 3.9): threaded
   * here as a required parameter because the Route 53 hosted-zone lookup has
   * not been ported yet.
   */
  hostedZoneId: pulumi.Input<string>;
}

/**
 * Filters a game-server map down to entries declaring at least one file
 * seed, mirroring `terraform/aws/efs-seeder.tf`'s `local.games_with_seeds`
 * local (`if length(cfg.file_seeds) > 0`) — exactly the games that get a
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
 * Declares every IAM role and the managed-policy attachment ported from the
 * HCL (task 3.5 of `migrate-iac-to-pulumi`) — see this file's doc for the
 * full HCL→Pulumi address table and why roles and policies are split across
 * two functions. Needs nothing from any later dispatch (every role's trust
 * policy is a static literal). Must be called from inside the Pulumi
 * inline-program closure, never at module scope.
 *
 * @param args - Naming, config, and provider inputs — see
 *   {@link DefineIamRolesArgs}.
 * @returns The declared roles/attachment — see {@link IamRoleResources}.
 */
export function defineIamRoles(args: DefineIamRolesArgs): IamRoleResources {
  const { projectName, gameServers, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // ── ECS task-execution role (main.tf) ─────────────────────────────────────
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

  // ── Per-Lambda roles (watchdog.tf, followup.tf, interactions.tf, route53.tf) ─
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

  // ── Per-game EFS-seeder roles (efs-seeder.tf) ─────────────────────────────
  const efsSeederRoles: Record<string, aws.iam.Role> = {};
  for (const game of Object.keys(gamesWithFileSeeds(gameServers))) {
    efsSeederRoles[game] = new aws.iam.Role(
      `${projectName}-efs-seeder-${game}`,
      { name: `${projectName}-efs-seeder-${game}`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
      opts,
    );
  }

  return {
    ecsTaskExecutionRole,
    ecsTaskExecutionPolicyAttachment,
    watchdogLambdaRole,
    followupLambdaRole,
    interactionsLambdaRole,
    dnsUpdaterLambdaRole,
    efsSeederRoles,
  };
}

/**
 * Declares every inline policy ported from the HCL (task 3.5 of
 * `migrate-iac-to-pulumi`) — see this file's doc for the full HCL→Pulumi
 * address table and why roles and policies are split across two functions.
 * Must run after {@link defineIamRoles} (its `roles` argument) and, in a
 * live `defineAll` wiring, after `defineLambdas` (task 3.6) has supplied
 * `args.followupLambdaArn` — see {@link DefineIamPoliciesArgs}'s doc. Must
 * be called from inside the Pulumi inline-program closure, never at module
 * scope.
 *
 * @param args - The role set, provider, and deferred-ARN inputs — see
 *   {@link DefineIamPoliciesArgs}.
 * @returns The declared policies — see {@link IamPolicyResources}.
 */
export function defineIamPolicies(args: DefineIamPoliciesArgs): IamPolicyResources {
  const { projectName, provider, roles, efsFileSystemArn, dynamodbDiscordTableArn, discordPublicKeySecretArn, followupLambdaArn, hostedZoneId } =
    args;
  const opts: pulumi.CustomResourceOptions = { provider };

  // ── Watchdog Lambda policy (watchdog.tf) — no external ARN dependency ─────
  const watchdogLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-watchdog-lambda-policy`,
    {
      name: `${projectName}-watchdog-lambda-policy`,
      role: roles.watchdogLambdaRole.id,
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          logStatement(),
          {
            Effect: 'Allow',
            Action: ['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:StopTask', 'ecs:TagResource', 'ecs:ListTagsForResource'],
            Resource: '*',
          },
          { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
          { Effect: 'Allow', Action: ['cloudwatch:GetMetricStatistics'], Resource: '*' },
        ],
      }),
    },
    opts,
  );

  // ── Followup Lambda policy (followup.tf) ──────────────────────────────────
  const followupLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-followup-lambda-policy`,
    {
      name: `${projectName}-followup-lambda-policy`,
      role: roles.followupLambdaRole.id,
      // `iam:PassRole` targets the ECS task-execution role from `roles`
      // (live, same-program reference) — the DynamoDB grant targets the
      // `discord` table (deferred, task 3.8) — hence `pulumi.jsonStringify`
      // rather than a plain `JSON.stringify`, to resolve both Output-typed
      // ARNs into the final JSON string.
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          logStatement(),
          { Effect: 'Allow', Action: ['ecs:RunTask', 'ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'], Resource: '*' },
          { Effect: 'Allow', Action: ['iam:PassRole'], Resource: roles.ecsTaskExecutionRole.arn },
          { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
          { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: dynamodbDiscordTableArn },
        ],
      }),
    },
    opts,
  );

  // ── Interactions Lambda policy (interactions.tf) ──────────────────────────
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

  // ── DNS-updater Lambda policy (route53.tf) ────────────────────────────────
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

  // ── Per-game EFS-seeder policies (efs-seeder.tf) ──────────────────────────
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
            {
              // Required for Lambda VPC networking.
              Effect: 'Allow',
              Action: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface'],
              Resource: '*',
            },
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

  return { watchdogLambdaPolicy, followupLambdaPolicy, interactionsLambdaPolicy, dnsUpdaterLambdaPolicy, efsSeederPolicies };
}
