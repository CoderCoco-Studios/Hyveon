/**
 * IAM roles and inline policies — ported from `terraform/aws/main.tf`'s
 * `## IAM` block (the ECS task-execution role and its managed-policy
 * attachment) plus every per-Lambda role/policy pair scattered across
 * `terraform/aws/{followup,interactions,route53,watchdog,efs-seeder}.tf`
 * (task 3.5 of `migrate-iac-to-pulumi`). Every `aws_iam_*` resource in the
 * HCL lives here, even the ones whose *consumers* (the EFS filesystem, the
 * Lambda functions themselves, the DynamoDB table, the Secrets Manager
 * secret, the Route 53 hosted-zone lookup) are ported by later dispatches —
 * see {@link DefineIamArgs}'s doc for how those forward references are
 * threaded.
 *
 * Six roles, five inline policies, one managed-policy attachment — matching
 * the task-3.5 brief's inventory exactly (confirmed by grepping the HCL for
 * `resource "aws_iam_`, no discrepancy found):
 *
 * | HCL address | This file |
 * | --- | --- |
 * | `aws_iam_role.ecs_task_execution` | {@link IamResources.ecsTaskExecutionRole} |
 * | `aws_iam_role_policy_attachment.ecs_task_execution` | {@link IamResources.ecsTaskExecutionPolicyAttachment} |
 * | `aws_iam_role.watchdog_lambda` | {@link IamResources.watchdogLambdaRole} |
 * | `aws_iam_role_policy.watchdog_lambda` | {@link IamResources.watchdogLambdaPolicy} |
 * | `aws_iam_role.followup_lambda` | {@link IamResources.followupLambdaRole} |
 * | `aws_iam_role_policy.followup_lambda` | {@link IamResources.followupLambdaPolicy} |
 * | `aws_iam_role.interactions_lambda` | {@link IamResources.interactionsLambdaRole} |
 * | `aws_iam_role_policy.interactions_lambda` | {@link IamResources.interactionsLambdaPolicy} |
 * | `aws_iam_role.dns_updater_lambda` | {@link IamResources.dnsUpdaterLambdaRole} |
 * | `aws_iam_role_policy.dns_updater_lambda` | {@link IamResources.dnsUpdaterLambdaPolicy} |
 * | `aws_iam_role.efs_seeder` (`for_each`) | {@link IamResources.efsSeederRoles} |
 * | `aws_iam_role_policy.efs_seeder` (`for_each`) | {@link IamResources.efsSeederPolicies} |
 *
 * NOT called from `program.ts`'s `defineAll` yet: four of the six roles'
 * inline policies interpolate ARNs of resources no earlier dispatch has
 * created (the EFS filesystem — task 3.2; the DynamoDB `discord` table and
 * the `discord_public_key` secret — task 3.8; the `followup` Lambda function
 * — task 3.6; the Route 53 hosted-zone lookup — task 3.9), so
 * {@link DefineIamArgs} declares those as required `pulumi.Input<string>`
 * parameters that do not yet have a real resource to supply them — inventing
 * placeholder values instead of leaving them as compile-time-enforced gaps
 * would silently ship a policy pointing at nothing. Per the task-3.5 brief's
 * explicit fallback ("define + unit-test the module now and leave the
 * closure wiring to the task that supplies the missing inputs"), `defineIam`
 * is fully implemented and unit-tested here, but `defineAll` does not call
 * it — see the `TODO(task 3.x)` comment on each deferred field below, and
 * `program.ts` for the corresponding wiring TODO.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { GameServerConfig } from '@hyveon/shared';

/** One IAM role paired with its single inline policy — the shape every per-Lambda role in this file declares. */
export interface RoleWithPolicy {
  /** The IAM role itself. */
  role: aws.iam.Role;
  /** The role's inline policy (`aws_iam_role_policy`). */
  policy: aws.iam.RolePolicy;
}

/** Every resource {@link defineIam} declares, keyed by HCL identity — see this file's doc for the full HCL→Pulumi address table. */
export interface IamResources {
  /** ECS task-execution role (`aws_iam_role.ecs_task_execution`) — assumed by `ecs-tasks.amazonaws.com` to pull images and write logs on every game-server task. */
  ecsTaskExecutionRole: aws.iam.Role;
  /** Attaches the AWS-managed `AmazonECSTaskExecutionRolePolicy` to {@link ecsTaskExecutionRole} (`aws_iam_role_policy_attachment.ecs_task_execution`). */
  ecsTaskExecutionPolicyAttachment: aws.iam.RolePolicyAttachment;
  /** Watchdog Lambda's role (`aws_iam_role.watchdog_lambda`). */
  watchdogLambdaRole: aws.iam.Role;
  /** Watchdog Lambda's inline policy (`aws_iam_role_policy.watchdog_lambda`). */
  watchdogLambdaPolicy: aws.iam.RolePolicy;
  /** Followup Lambda's role (`aws_iam_role.followup_lambda`). */
  followupLambdaRole: aws.iam.Role;
  /** Followup Lambda's inline policy (`aws_iam_role_policy.followup_lambda`). */
  followupLambdaPolicy: aws.iam.RolePolicy;
  /** Interactions Lambda's role (`aws_iam_role.interactions_lambda`). */
  interactionsLambdaRole: aws.iam.Role;
  /** Interactions Lambda's inline policy (`aws_iam_role_policy.interactions_lambda`). */
  interactionsLambdaPolicy: aws.iam.RolePolicy;
  /** DNS-updater Lambda's role (`aws_iam_role.dns_updater_lambda`). */
  dnsUpdaterLambdaRole: aws.iam.Role;
  /** DNS-updater Lambda's inline policy (`aws_iam_role_policy.dns_updater_lambda`). */
  dnsUpdaterLambdaPolicy: aws.iam.RolePolicy;
  /**
   * Per-game EFS-seeder role, keyed by game name — one entry per
   * {@link gamesWithFileSeeds} key (`aws_iam_role.efs_seeder`'s `for_each`).
   */
  efsSeederRoles: Record<string, aws.iam.Role>;
  /**
   * Per-game EFS-seeder inline policy, keyed the same way as
   * {@link efsSeederRoles} (`aws_iam_role_policy.efs_seeder`'s `for_each`).
   */
  efsSeederPolicies: Record<string, aws.iam.RolePolicy>;
}

/** Arguments {@link defineIam} needs to declare every IAM role and policy. */
export interface DefineIamArgs {
  /** Mirrors `var.project_name` — every role/policy name below is `${projectName}-...`, matching the HCL exactly. */
  projectName: string;
  /**
   * The configured game-server map (`DeploymentConfig.gameServers`) —
   * {@link gamesWithFileSeeds} filters it down to the games that get a
   * per-game EFS-seeder role/policy pair.
   */
  gameServers: Record<string, GameServerConfig>;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;

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
   * because the Lambda functions have not been ported yet — note the
   * followup Lambda function itself will in turn need
   * {@link IamResources.followupLambdaRole}'s `.arn` (created by *this*
   * module) to exist, so task 3.6's wiring order is: `defineIam` (for the
   * role) → `defineLambdas` (for the function) → back into whatever supplies
   * this parameter to `defineIam`'s eventual live call.
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
 * per-game EFS-seeder IAM role/policy pair declared by {@link defineIam}.
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

/** The `logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents` statement every Lambda inline policy in the ported HCL opens with, granted against the same `arn:aws:logs:*:*:*` wildcard in every case. */
const LOG_STATEMENT = {
  Effect: 'Allow',
  Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
  Resource: 'arn:aws:logs:*:*:*',
};

/**
 * Declares every IAM role, inline policy, and managed-policy attachment
 * ported from the HCL (task 3.5 of `migrate-iac-to-pulumi`) — see this
 * file's doc for the full HCL→Pulumi address table and why `defineAll` does
 * not call this function yet. Must be called from inside the Pulumi
 * inline-program closure, never at module scope.
 *
 * @param args - Naming, config, provider, and deferred-ARN inputs — see
 *   {@link DefineIamArgs}.
 * @returns The declared resources — see {@link IamResources}.
 */
export function defineIam(args: DefineIamArgs): IamResources {
  const {
    projectName,
    gameServers,
    provider,
    efsFileSystemArn,
    dynamodbDiscordTableArn,
    discordPublicKeySecretArn,
    followupLambdaArn,
    hostedZoneId,
  } = args;
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

  // ── Watchdog Lambda role/policy (watchdog.tf) ─────────────────────────────
  const watchdogLambdaRole = new aws.iam.Role(
    `${projectName}-watchdog-lambda`,
    { name: `${projectName}-watchdog-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const watchdogLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-watchdog-lambda-policy`,
    {
      name: `${projectName}-watchdog-lambda-policy`,
      role: watchdogLambdaRole.id,
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          LOG_STATEMENT,
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

  // ── Followup Lambda role/policy (followup.tf) ─────────────────────────────
  const followupLambdaRole = new aws.iam.Role(
    `${projectName}-followup-lambda`,
    { name: `${projectName}-followup-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const followupLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-followup-lambda-policy`,
    {
      name: `${projectName}-followup-lambda-policy`,
      role: followupLambdaRole.id,
      // `iam:PassRole` targets the ECS task-execution role declared above
      // (live, same module) — the DynamoDB grant targets the `discord` table
      // (deferred, task 3.8) — hence `pulumi.jsonStringify` rather than a
      // plain `JSON.stringify`, to resolve both Output-typed ARNs into the
      // final JSON string.
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          LOG_STATEMENT,
          { Effect: 'Allow', Action: ['ecs:RunTask', 'ecs:StopTask', 'ecs:ListTasks', 'ecs:DescribeTasks'], Resource: '*' },
          { Effect: 'Allow', Action: ['iam:PassRole'], Resource: ecsTaskExecutionRole.arn },
          { Effect: 'Allow', Action: ['ec2:DescribeNetworkInterfaces'], Resource: '*' },
          { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem'], Resource: dynamodbDiscordTableArn },
        ],
      }),
    },
    opts,
  );

  // ── Interactions Lambda role/policy (interactions.tf) ─────────────────────
  const interactionsLambdaRole = new aws.iam.Role(
    `${projectName}-interactions-lambda`,
    { name: `${projectName}-interactions-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const interactionsLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-interactions-lambda-policy`,
    {
      name: `${projectName}-interactions-lambda-policy`,
      role: interactionsLambdaRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          LOG_STATEMENT,
          { Effect: 'Allow', Action: ['dynamodb:GetItem'], Resource: dynamodbDiscordTableArn },
          { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: discordPublicKeySecretArn },
          { Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: followupLambdaArn },
        ],
      }),
    },
    opts,
  );

  // ── DNS-updater Lambda role/policy (route53.tf) ───────────────────────────
  const dnsUpdaterLambdaRole = new aws.iam.Role(
    `${projectName}-dns-updater-lambda`,
    { name: `${projectName}-dns-updater-lambda`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    opts,
  );

  const dnsUpdaterLambdaPolicy = new aws.iam.RolePolicy(
    `${projectName}-dns-updater-lambda-policy`,
    {
      name: `${projectName}-dns-updater-lambda-policy`,
      role: dnsUpdaterLambdaRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          LOG_STATEMENT,
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

  // ── Per-game EFS-seeder roles/policies (efs-seeder.tf) ────────────────────
  const efsSeederRoles: Record<string, aws.iam.Role> = {};
  const efsSeederPolicies: Record<string, aws.iam.RolePolicy> = {};

  for (const game of Object.keys(gamesWithFileSeeds(gameServers))) {
    const role = new aws.iam.Role(
      `${projectName}-efs-seeder-${game}`,
      { name: `${projectName}-efs-seeder-${game}`, assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
      opts,
    );
    efsSeederRoles[game] = role;

    efsSeederPolicies[game] = new aws.iam.RolePolicy(
      `${projectName}-efs-seeder-${game}-policy`,
      {
        name: `${projectName}-efs-seeder-${game}-policy`,
        role: role.id,
        policy: pulumi.jsonStringify({
          Version: '2012-10-17',
          Statement: [
            LOG_STATEMENT,
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

  return {
    ecsTaskExecutionRole,
    ecsTaskExecutionPolicyAttachment,
    watchdogLambdaRole,
    watchdogLambdaPolicy,
    followupLambdaRole,
    followupLambdaPolicy,
    interactionsLambdaRole,
    interactionsLambdaPolicy,
    dnsUpdaterLambdaRole,
    dnsUpdaterLambdaPolicy,
    efsSeederRoles,
    efsSeederPolicies,
  };
}
