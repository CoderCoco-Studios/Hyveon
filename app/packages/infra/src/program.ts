/**
 * The Pulumi inline-program factory — the `@hyveon/infra` package's public
 * entry point (re-exported from `index.ts`). Establishes the pattern every
 * resource-area module (EFS, ECS, IAM, Lambdas, ...) follows: one
 * `defineX(...)` module per Terraform-file-shaped resource area, all wired
 * together inside the closure {@link createInfraProgram} returns.
 *
 * ## Resource-inventory audit
 *
 * This package's `defineAll` (below) is the FULL Pulumi resource graph for
 * the retired `terraform/` tree's 69 `resource` blocks (21 `.tf` files, 2837
 * lines, independently verified below). Every block maps to exactly one
 * entry in the table below: a Pulumi counterpart (file + field on
 * {@link InfraResources}), or an explicit omission with its reason. Zero
 * blocks are unaccounted for.
 *
 * Re-verification command: `grep -rn '^resource "' terraform/*.tf terraform/aws/*.tf terraform/bootstrap/*.tf | wc -l` → `69`.
 *
 * | # | HCL address | Pulumi counterpart | Notes |
 * | --- | --- | --- | --- |
 * | 1 | `aws_vpc.main` | `network.vpc` | |
 * | 2 | `aws_internet_gateway.main` | `network.internetGateway` | |
 * | 3 | `aws_subnet.public` (`count=2`) | `network.publicSubnets` | one HCL block, one Pulumi array of 2 |
 * | 4 | `aws_route_table.public` | `network.routeTable` | |
 * | 5 | `aws_route_table_association.public` (`count=2`) | `network.routeTableAssociations` | one HCL block, one Pulumi array of 2 |
 * | 6 | `aws_security_group.game_servers` | `securityGroups.gameServers` | |
 * | 7 | `aws_security_group.file_manager` | `securityGroups.fileManager` | |
 * | 8 | `aws_security_group.efs` | `securityGroups.efs` | |
 * | 9 | `aws_efs_file_system.saves` | `efs.fileSystem` | |
 * | 10 | `aws_efs_mount_target.saves` (`count=2`) | `efs.mountTargets` | one HCL block, one Pulumi array of 2 |
 * | 11 | `aws_efs_access_point.game` (`for_each`) | `efs.gameAccessPoints` | |
 * | 12 | `aws_efs_access_point.caddy_data` (`for_each`) | `efs.caddyDataAccessPoints` | |
 * | 13 | `aws_cloudwatch_log_group.game` (`for_each`) | `ecs.logGroups` | |
 * | 14 | `aws_iam_role.ecs_task_execution` | `iamRoles.ecsTaskExecutionRole` | |
 * | 15 | `aws_iam_role_policy_attachment.ecs_task_execution` | `iamRoles.ecsTaskExecutionPolicyAttachment` | |
 * | 16 | `aws_ecs_cluster.main` | `ecs.cluster` | |
 * | 17 | `aws_ecs_task_definition.game` (`for_each`) | `ecs.taskDefinitions` | |
 * | 18 | `aws_security_group.efs_seeder` (`count`) | `securityGroups.efsSeeder` | `undefined` when no game has `file_seeds`, matching the HCL's `count` gate |
 * | 19 | `aws_iam_role.efs_seeder` (`for_each`) | `iamRoles.efsSeederRoles` | |
 * | 20 | `aws_iam_role_policy.efs_seeder` (`for_each`) | `iamPolicies.efsSeederPolicies` | |
 * | 21 | `aws_cloudwatch_log_group.efs_seeder` (`for_each`) | `lambdas.efsSeederLogGroups` | |
 * | 22 | `aws_lambda_function.efs_seeder` (`for_each`) | `lambdas.efsSeederFunctions` | |
 * | 23 | `aws_lambda_invocation.efs_seeder` (`for_each`) | `efsSeederInvocations` | |
 * | 24 | `aws_iam_role.followup_lambda` | `iamRoles.followupLambdaRole` | |
 * | 25 | `aws_iam_role_policy.followup_lambda` | `iamPolicies.followupLambdaPolicy` | |
 * | 26 | `aws_lambda_function.followup` | `lambdas.followupFunction` | |
 * | 27 | `aws_cloudwatch_log_group.followup` | `lambdas.followupLogGroup` | |
 * | 28 | `aws_iam_role.interactions_lambda` | `iamRoles.interactionsLambdaRole` | |
 * | 29 | `aws_iam_role_policy.interactions_lambda` | `iamPolicies.interactionsLambdaPolicy` | |
 * | 30 | `aws_lambda_function.interactions` | `lambdas.interactionsFunction` | |
 * | 31 | `aws_cloudwatch_log_group.interactions` | `lambdas.interactionsLogGroup` | |
 * | 32 | `aws_lambda_function_url.interactions` | `lambdas.interactionsFunctionUrl` | |
 * | 33 | `aws_lambda_permission.interactions_url_invoke_url` | `lambdas.interactionsUrlInvokeUrlPermission` | |
 * | 34 | `aws_lambda_permission.interactions_url_invoke` | `lambdas.interactionsUrlInvokePermission` | |
 * | 35 | `aws_iam_role.watchdog_lambda` | `iamRoles.watchdogLambdaRole` | |
 * | 36 | `aws_iam_role_policy.watchdog_lambda` | `iamPolicies.watchdogLambdaPolicy` | |
 * | 37 | `aws_lambda_function.watchdog` | `lambdas.watchdogFunction` | |
 * | 38 | `aws_cloudwatch_log_group.watchdog` | `lambdas.watchdogLogGroup` | |
 * | 39 | `aws_cloudwatch_event_rule.watchdog_schedule` | `lambdas.watchdogScheduleRule` | |
 * | 40 | `aws_cloudwatch_event_target.watchdog` | `lambdas.watchdogScheduleTarget` | |
 * | 41 | `aws_lambda_permission.watchdog_eventbridge` | `lambdas.watchdogEventBridgePermission` | |
 * | 42 | `aws_iam_role.dns_updater_lambda` | `iamRoles.dnsUpdaterLambdaRole` | |
 * | 43 | `aws_iam_role_policy.dns_updater_lambda` | `iamPolicies.dnsUpdaterLambdaPolicy` | |
 * | 44 | `aws_lambda_function.dns_updater` | `lambdas.dnsUpdaterFunction` | |
 * | 45 | `aws_cloudwatch_log_group.dns_updater` | `lambdas.dnsUpdaterLogGroup` | |
 * | 46 | `aws_cloudwatch_event_rule.ecs_task_change` | `lambdas.ecsTaskChangeRule` | |
 * | 47 | `aws_cloudwatch_event_target.dns_updater` | `lambdas.dnsUpdaterEventTarget` | |
 * | 48 | `aws_lambda_permission.dns_updater_eventbridge` | `lambdas.dnsUpdaterEventBridgePermission` | (`data.aws_route53_zone.main` is a data source, not a `resource` block — not part of the 69; ported as `route53.zone`/`route53.zoneId`) |
 * | 49 | `aws_dynamodb_table.discord` | `dynamoDb.discordTable` | |
 * | 50 | `aws_secretsmanager_secret.discord_bot_token` | `secrets.discordBotTokenSecret` | |
 * | 51 | `aws_secretsmanager_secret_version.discord_bot_token` | `secrets.discordBotTokenSecretVersion` | |
 * | 52 | `aws_secretsmanager_secret.discord_public_key` | `secrets.discordPublicKeySecret` | |
 * | 53 | `aws_secretsmanager_secret_version.discord_public_key` | `secrets.discordPublicKeySecretVersion` | |
 * | 54 | `terraform_data.discord_register_commands` | **omitted** | Requires the live Discord bot token as an input, which this program's "no secret material enters the stack" invariant forbids; `DeploymentConfig` has no such field. Permanent, not deferred — the app's existing per-guild "Register commands" UI (`DiscordCommandRegistrar.ts`) is the surviving manual path. See `escapes.ts`'s file doc, "Why `terraform_data.discord_register_commands` has no Pulumi analogue." |
 * | 55 | `aws_dynamodb_table_item.discord_base_config` | `discordTableItems.discordBaseConfigItem` | |
 * | 56 | `aws_dynamodb_table_item.discord_config_seed` | `discordTableItems.discordConfigSeedItem` | |
 * | 57 | `aws_acm_certificate.discord` | `discordDomain.certificate` | |
 * | 58 | `aws_route53_record.discord_acm_validation` (`for_each`, 1 entry) | `discordDomain.certificateValidationRecord` | |
 * | 59 | `aws_acm_certificate_validation.discord` | `discordDomain.certificateValidation` | |
 * | 60 | `aws_cloudfront_distribution.discord` | `discordDomain.distribution` | |
 * | 61 | `aws_route53_record.discord` | `discordDomain.aliasRecord` | |
 * | 62 | `aws_route53_record.discord_aaaa` | `discordDomain.aliasRecordAaaa` | |
 * | 63 | `aws_dynamodb_table.audit` | `dynamoDb.auditTable` | |
 * | 64 | `aws_dynamodb_table.runs` | `dynamoDb.runsTable` | |
 * | 65 | `aws_s3_bucket.tfvars` (`terraform/bootstrap/main.tf`) | **omitted from this program** | Ported to `BootstrapService.ensureTfvarsBucket` over the AWS SDK instead, not into this Pulumi stack. This bucket is the operator's configuration bucket and holds `DeploymentConfig`, this program's own input, so it must exist and be populated before `defineAll`/`createInfraProgram` can be invoked with a real config. It is NOT the Pulumi state bucket — see the note below the table for that distinct resource. |
 * | 66 | `aws_s3_bucket_versioning.tfvars` | **omitted from this program** | Same reason as #65 — `BootstrapService.ensureTfvarsBucket`. |
 * | 67 | `aws_s3_bucket_server_side_encryption_configuration.tfvars` | **omitted from this program** | Same reason as #65 — `BootstrapService.ensureTfvarsBucket`. |
 * | 68 | `aws_s3_bucket_public_access_block.tfvars` | **omitted from this program** | Same reason as #65 — `BootstrapService.ensureTfvarsBucket`. |
 * | 69 | `aws_s3_bucket_lifecycle_configuration.tfvars` | **omitted from this program** | Same reason as #65 — `BootstrapService.ensureTfvarsBucket`. |
 *
 * **Not the Pulumi state bucket.** `BootstrapService` also provisions a
 * SEPARATE bucket, `ensureStateBucket`, that backs the Pulumi `s3://`
 * state backend this program's own stack persists to. That bucket has NO
 * Terraform HCL counterpart at all — confirmed by `BootstrapService.ts`'s
 * own TSDoc on `ensureStateBucket`: "Mirrors the intent of
 * `terraform/bootstrap/` (which provisions the tfvars bucket, not this one
 * — there is no Terraform resource for the state bucket itself, since
 * Terraform can't manage the backend it also reads from)." It is therefore
 * out of scope for this 69-resource audit entirely — not one of the 69
 * rows, not an omission from this program, a pre-existing SDK-only
 * resource with no HCL history to diff against.
 *
 * ## Other intentional omissions (not tied to a single numbered HCL block)
 *
 * - **`Environment`/`ManagedBy` default tags.** `terraform/variables.tf`'s
 *   root-only `tags` variable default carried an `Environment` entry and a
 *   `ManagedBy` entry set to the literal string `terraform`, alongside
 *   `Project = "hyveon"`. Neither is replicated in {@link DEFAULT_TAGS}
 *   below: a `ManagedBy` value of `terraform` would be actively wrong
 *   post-migration, and nothing in the app reads
 *   `Environment` (no Lambda, service, or cost-tooling filters on it) — only
 *   the tag CLAUDE.md documents as load-bearing (AWS Cost-allocation tag
 *   activation) is preserved. `tags` itself was never operator-configurable
 *   and is deliberately excluded from `DeploymentConfig` — see
 *   {@link DEFAULT_TAGS}'s own doc for the full rationale.
 * - **`applied_game_servers` was `sensitive = true` in the HCL**
 *   (`terraform/aws/outputs.tf`), a marking this program's
 *   {@link StackOutputValues.appliedGameServers} does NOT replicate — Pulumi
 *   stack outputs have no per-field sensitivity marking in the
 *   `Record<string, any>` a `PulumiFn` returns (sensitivity is an
 *   `Output`-level property, `pulumi.secret(...)`, not applicable to a plain
 *   config echo like this field). This matters because `GameServerConfig`
 *   (the value's element type) carries `environment` — operator-set
 *   container environment variables, which may hold values the operator
 *   considers sensitive even though they are not routed through Secrets
 *   Manager. Pulumi prints stack outputs by default where Terraform
 *   redacted this one, so whatever surfaces `appliedGameServers` downstream
 *   (`PulumiService`, CLI-equivalent logging, `pulumi up` output) must apply
 *   its own redaction — this program cannot provide it at the
 *   `PulumiFn`-return-value layer.
 *
 * Confirmed zero unclaimed resources: every one of the 69 blocks above has
 * either a named Pulumi counterpart or an explicit, reasoned omission.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import type { DeploymentConfig, GameServerConfig, StackOutputs } from '@hyveon/shared';
import { defineNetwork, type NetworkResources } from './network.js';
import { defineSecurityGroups, type SecurityGroupResources } from './securityGroups.js';
import { defineIamRoles, defineIamPolicies, type IamRoleResources, type IamPolicyResources } from './iam.js';
import { defineEfs, type EfsResources } from './efs.js';
import { defineEcs, type EcsResources } from './ecs.js';
import { defineLambdas, type LambdaResources } from './lambdas.js';
import { defineDynamoDb, type DynamoDbResources } from './dynamodb.js';
import { defineSecrets, type SecretsResources } from './secrets.js';
import { defineRoute53, type Route53Resources } from './route53.js';
import { defineDiscordTableItems, defineEfsSeederInvocations, type DiscordTableItemResources } from './escapes.js';
import { defineDiscordDomain, type DiscordDomainResources } from './discordDomain.js';

/**
 * Fixed AWS tag set applied to every resource via the provider's
 * `defaultTags`, replicating the `Project = "hyveon"` entry of
 * `terraform/variables.tf`'s `tags` variable default (the one CLAUDE.md
 * documents as an invariant: "All AWS resources are tagged Project=hyveon").
 *
 * Deliberately NOT derived from `config.projectName`: `deploymentConfig.ts`'s
 * file doc excludes `tags` from `DeploymentConfig` specifically because tag
 * value is "a resource-tagging concern for the Pulumi program to own
 * directly (e.g. a fixed Project=hyveon tag set)" — a fixed value,
 * independent of the (renameable, used for resource *naming* only)
 * `projectName`. The Terraform default also carried an `Environment` entry
 * and a `ManagedBy` entry set to the literal string "terraform"; neither is
 * replicated here: a `ManagedBy` value of "terraform" would be actively
 * wrong post-migration, and `Environment` has no reader in the app (no
 * Lambda, service, or cost-tooling filters on it) — only the tag CLAUDE.md
 * documents as load-bearing (AWS Cost-allocation tag activation) is
 * preserved.
 */
const DEFAULT_TAGS: Record<string, string> = { Project: 'hyveon' };

/**
 * Machine-local inputs {@link defineAll}/{@link createInfraProgram} need
 * that do NOT belong in `DeploymentConfig` (`@hyveon/shared`) — that object
 * is persisted verbatim as JSON in the operator's configuration S3 bucket
 * and is meant to be portable across whichever machine runs a deploy,
 * whereas a filesystem path is inherently tied to the machine it was
 * resolved on. Modeled as a separate, required second parameter rather than
 * folded into `DeploymentConfig` for exactly that reason.
 */
export interface InfraProgramOptions {
  /**
   * The directory every `@hyveon/lambda-*` package's prebuilt
   * `dist/handler.cjs` bundle is resolved against — `lambdas.ts`'s
   * `DefineLambdasArgs.lambdaBundlesDir`, threaded straight through to the
   * `defineLambdas` call inside {@link defineAll}. See `lambdas.ts`'s file
   * doc, "The lambda-bundle path contract", for the full rationale
   * (including why it has no default anywhere in this package). The caller
   * — `PulumiService` — must resolve this path and supply it here at
   * runtime.
   */
  lambdaBundlesDir: string;
}

/**
 * Every resource area {@link defineAll} declares, keyed by module —
 * including the AWS provider itself, since it too is a real Pulumi resource
 * (`pulumi:providers:aws`) whose region/tags are worth asserting on
 * directly. This is the type `defineAll`'s tests hold real handles against;
 * `createInfraProgram`'s closure also binds this shape to a local variable
 * and passes it straight to {@link buildStackOutputs} so every stack-output
 * field is derived from a live resource handle rather than re-declared or
 * re-derived.
 */
export interface InfraResources {
  /** The AWS provider every resource below is declared against. */
  provider: aws.Provider;
  /**
   * The us-east-1-pinned AWS provider — CloudFront requires its ACM
   * certificate to live in us-east-1 regardless of `config.awsRegion`.
   * Threaded ONLY into `discordDomain`'s certificate + certificate-validation
   * resources — see `discordDomain.ts`'s file doc, "us-east-1 provider
   * alias."
   */
  usEast1Provider: aws.Provider;
  /** Networking resources — see {@link NetworkResources}. */
  network: NetworkResources;
  /**
   * Security-group resources, plus the EFS-seeder security group and its
   * conditional ingress rule on `efs` (folded into `defineSecurityGroups` —
   * see that file's doc) — see {@link SecurityGroupResources}.
   */
  securityGroups: SecurityGroupResources;
  /** IAM roles + the ECS task-execution managed-policy attachment — see {@link IamRoleResources}. */
  iamRoles: IamRoleResources;
  /** EFS resources — see {@link EfsResources}. */
  efs: EfsResources;
  /** ECS cluster, log groups, and task definitions — see {@link EcsResources}. */
  ecs: EcsResources;
  /** DynamoDB tables — see {@link DynamoDbResources}. */
  dynamoDb: DynamoDbResources;
  /** Discord Secrets Manager secrets and their create-only placeholder versions — see {@link SecretsResources}. */
  secrets: SecretsResources;
  /** The Route 53 hosted-zone lookup — see {@link Route53Resources}. No DNS record resource is ever part of this — see `route53.ts`'s file doc. */
  route53: Route53Resources;
  /** The five Lambda functions and their EventBridge/permission wiring — see {@link LambdaResources}. */
  lambdas: LambdaResources;
  /**
   * The five inline IAM policies (see `iam.ts`'s file doc for why roles and
   * policies are split across two functions) — see {@link IamPolicyResources}.
   */
  iamPolicies: IamPolicyResources;
  /** The two conditional Discord DynamoDB seed rows — see {@link DiscordTableItemResources}. */
  discordTableItems: DiscordTableItemResources;
  /** One `aws.lambda.Invocation` per game with `file_seeds` — see `escapes.ts`'s `defineEfsSeederInvocations`. */
  efsSeederInvocations: Record<string, aws.lambda.Invocation>;
  /** The Discord custom-domain resource set — see {@link DiscordDomainResources}. */
  discordDomain: DiscordDomainResources;
}

/**
 * Declares every resource this program's infrastructure graph covers and
 * wires them together: constructs the shared AWS provider, then calls each
 * `defineX(...)` module in dependency order, threading the provider and each
 * module's output into the next. This is the function
 * {@link createInfraProgram}'s closure delegates to — pulled out to a
 * separate, synchronously-returning function (rather than left inline in the
 * closure) specifically so tests get real resource handles to await
 * precisely with `promiseOf` (see `testing/pulumiMocks.ts`), instead of
 * having to infer completion from the closure's opaque
 * `Promise<Record<string, any> | void>` return.
 *
 * Adding a new resource area (EFS, ECS, IAM, Lambdas, ...) follows the same
 * pattern: construct/derive whatever inputs it needs from `config` and the
 * resources already returned above it, append its result to the returned
 * object, and extend {@link InfraResources} to match.
 *
 * The AWS provider is constructed once per call, with its region taken from
 * `config.awsRegion` (never an ambient env var) and {@link DEFAULT_TAGS}
 * applied via `defaultTags` — the mechanism Pulumi provides for Terraform's
 * provider-level `default_tags` block. It is threaded explicitly into every
 * `defineX(...)` call (as `provider` in each function's args) rather than
 * relying on Pulumi's implicit default-provider resolution, so every
 * resource's region/tags are traceably wired rather than picked up
 * ambiently.
 *
 * @param config - The full deployment configuration to derive infrastructure
 *   from.
 * @param options - Machine-local inputs `DeploymentConfig` deliberately
 *   excludes — see {@link InfraProgramOptions}. `options.lambdaBundlesDir` is
 *   threaded straight through to the `defineLambdas` call below.
 * @returns Every declared resource area, keyed by module — see
 *   {@link InfraResources}.
 */
export function defineAll(config: DeploymentConfig, options: InfraProgramOptions): InfraResources {
  const provider = new aws.Provider('aws', {
    region: config.awsRegion,
    defaultTags: { tags: DEFAULT_TAGS },
  });

  // CloudFront's ACM certificate must live in us-east-1 regardless of
  // `config.awsRegion` — mirrors `terraform/main.tf`'s aliased
  // `provider "aws" { alias = "us_east_1" }` block. Threaded ONLY into
  // `discordDomain`'s certificate + certificate-validation resources below;
  // every other resource in this program uses the regional `provider` above.
  const usEast1Provider = new aws.Provider('aws-us-east-1', {
    region: 'us-east-1',
    defaultTags: { tags: DEFAULT_TAGS },
  });

  const network = defineNetwork({
    projectName: config.projectName,
    vpcCidr: config.vpcCidr,
    provider,
  });

  const securityGroups = defineSecurityGroups({
    projectName: config.projectName,
    gameServers: config.gameServers,
    vpcId: network.vpc.id,
    provider,
  });

  // `defineIamRoles(...)` needs nothing declared later in this function
  // (every role's trust policy is a static literal) — wired in now because
  // `defineEcs` below consumes `iamRoles.ecsTaskExecutionRole.arn` for every
  // task definition's `execution_role_arn`.
  const iamRoles = defineIamRoles({
    projectName: config.projectName,
    gameServers: config.gameServers,
    provider,
  });

  const efs = defineEfs({
    projectName: config.projectName,
    gameServers: config.gameServers,
    publicSubnets: network.publicSubnets.map((subnet) => subnet.id),
    efsSecurityGroupId: securityGroups.efs.id,
    provider,
  });

  const ecs = defineEcs({
    projectName: config.projectName,
    awsRegion: config.awsRegion,
    hostedZoneName: config.hostedZoneName,
    gameServers: config.gameServers,
    efs,
    executionRoleArn: iamRoles.ecsTaskExecutionRole.arn,
    provider,
  });

  // NOTE: `aws_security_group.efs_seeder` and the seeder-sourced ingress
  // rule on the `efs` security group are ALREADY wired in above, as part of
  // `defineSecurityGroups` — `securityGroups.efsSeeder` is real whenever at
  // least one game declares `file_seeds` (see `securityGroups.ts`'s file
  // doc).

  // ── DynamoDB tables + Secrets Manager secrets ──────────────────────────────
  // Neither depends on anything declared above — both need only `config`
  // and `provider` — so they're free to run anywhere in this function; kept
  // here so every later call that still needs one of their outputs
  // (`defineLambdas`, `defineIamPolicies`, `defineDiscordTableItems` below)
  // can find it already in scope.
  const dynamoDb = defineDynamoDb({
    projectName: config.projectName,
    auditTableName: config.auditTableName,
    runsTableName: config.runsTableName,
    provider,
  });

  const secrets = defineSecrets({
    projectName: config.projectName,
    provider,
  });

  // ── Route 53 hosted-zone lookup ────────────────────────────────────────────
  const route53 = defineRoute53({
    hostedZoneName: config.hostedZoneName,
    provider,
  });

  // ── The two conditional Discord DynamoDB seed rows ─────────────────────────
  // Only needs `dynamoDb.discordTable` (just declared above) plus plain
  // config fields — no dependency on `lambdas`/`iamPolicies` below, unlike
  // `defineEfsSeederInvocations` further down.
  const discordTableItems = defineDiscordTableItems({
    projectName: config.projectName,
    provider,
    discordTable: dynamoDb.discordTable,
    baseAllowedGuilds: config.baseAllowedGuilds,
    baseAdminUserIds: config.baseAdminUserIds,
    baseAdminRoleIds: config.baseAdminRoleIds,
    discordApplicationId: config.discordApplicationId,
  });

  // ── Lambda functions ────────────────────────────────────────────────────────
  // Every deferred input `lambdas.ts`'s file doc flagged as blocking this
  // wiring is now real: `dynamoDb.discordTable.name`/`secrets.discordPublicKeySecret.arn`
  // and `route53.zoneId` (both just declared above).
  const lambdas = defineLambdas({
    projectName: config.projectName,
    awsRegion: config.awsRegion,
    hostedZoneName: config.hostedZoneName,
    dnsTtl: config.dnsTtl,
    watchdogIntervalMinutes: config.watchdogIntervalMinutes,
    watchdogIdleChecks: config.watchdogIdleChecks,
    watchdogMinPackets: config.watchdogMinPackets,
    gameServers: config.gameServers,
    roles: iamRoles,
    publicSubnetIds: network.publicSubnets.map((subnet) => subnet.id),
    efsSeederSecurityGroupId: securityGroups.efsSeeder?.id,
    gameServersSecurityGroupId: securityGroups.gameServers.id,
    ecsClusterName: ecs.cluster.name,
    ecsClusterArn: ecs.cluster.arn,
    efs,
    lambdaBundlesDir: options.lambdaBundlesDir,
    dynamodbDiscordTableName: dynamoDb.discordTable.name,
    discordPublicKeySecretArn: secrets.discordPublicKeySecret.arn,
    hostedZoneId: route53.zoneId,
    provider,
  });

  // ── Discord custom domain ───────────────────────────────────────────────────
  // Needs `lambdas.interactionsFunctionUrl.functionUrl` (CloudFront's origin,
  // just declared above) and `route53.zoneId`. No dependency on
  // `iamPolicies` below, so this can — and does — run before it.
  const discordDomain = defineDiscordDomain({
    projectName: config.projectName,
    hostedZoneName: config.hostedZoneName,
    zoneId: route53.zoneId,
    interactionsFunctionUrl: lambdas.interactionsFunctionUrl.functionUrl,
    provider,
    usEast1Provider,
  });

  // ── IAM inline policies ─────────────────────────────────────────────────────
  // Necessarily last among the resource areas above: `followupLambdaArn`
  // does not exist until `defineLambdas` (just above) has created the
  // followup function — see `iam.ts`'s file doc, "Why this is two functions,
  // not one", for why no other call order satisfies every dependency.
  const iamPolicies = defineIamPolicies({
    projectName: config.projectName,
    provider,
    roles: iamRoles,
    efsFileSystemArn: efs.fileSystem.arn,
    dynamodbDiscordTableArn: dynamoDb.discordTable.arn,
    discordPublicKeySecretArn: secrets.discordPublicKeySecret.arn,
    followupLambdaArn: lambdas.followupFunction.arn,
    hostedZoneId: route53.zoneId,
  });

  // ── Per-game EFS-seeder Lambda invocations ──────────────────────────────────
  // Runs last: needs both `lambdas.efsSeederFunctions` (just above) and
  // `iamPolicies.efsSeederPolicies` (just above) — the latter for the
  // `dependsOn` edge it requires; see `escapes.ts`'s file doc.
  const efsSeederInvocations = defineEfsSeederInvocations({
    projectName: config.projectName,
    provider,
    gameServers: config.gameServers,
    efsSeederFunctions: lambdas.efsSeederFunctions,
    efsSeederPolicies: iamPolicies.efsSeederPolicies,
  });

  return {
    provider,
    usEast1Provider,
    network,
    securityGroups,
    iamRoles,
    efs,
    ecs,
    dynamoDb,
    secrets,
    route53,
    lambdas,
    iamPolicies,
    discordTableItems,
    efsSeederInvocations,
    discordDomain,
  };
}

/**
 * The stack-output values {@link buildStackOutputs} returns — the same field
 * set as `@hyveon/shared`'s {@link StackOutputs}, but with every
 * resource-derived field left as its live `pulumi.Output<T>` rather than a
 * resolved plain value. This is deliberate, not a shortcut: `createInfraProgram`'s
 * closure returns this object directly as its `PulumiFn` result (see that
 * function's doc, "Outputs mechanism"), and the Automation API's own
 * `massage()` step (confirmed by reading `@pulumi/pulumi`'s
 * `runtime/stack.js`) resolves `Output`/`Promise`/plain values recursively
 * when it registers them as the stack's outputs — pre-resolving here would
 * only discard the dependency edges the engine uses for its own graph
 * tracking, for no benefit. `PulumiService` reads the resolved plain values
 * back via `stack.outputs()`, which is where a {@link StackOutputs} value is
 * actually materialized.
 *
 * Only four fields are plain (not `Output`-wrapped), because they are
 * already known synchronously from `config` with no resource round-trip
 * needed: {@link awsRegion}, {@link domainName}, {@link gameNames}, and
 * {@link appliedGameServers} — mirroring the four Terraform outputs
 * (`aws_region`, `domain_name`, `game_names`, `applied_game_servers`) whose
 * HCL `value` is a bare `var.*`/`keys(var.*)` expression, never a resource
 * attribute.
 *
 * `extends Record<keyof StackOutputs, unknown>` is a genuine compile-time
 * completeness check, not decoration: it fails to build if this interface
 * ever drops a field {@link StackOutputs} declares (or a future
 * {@link StackOutputs} field has no matching entry here), so this type's
 * field-by-field parity with `StackOutputs` can't silently drift.
 */
export interface StackOutputValues extends Record<keyof StackOutputs, unknown> {
  /** Mirrors {@link StackOutputs.awsRegion} — `terraform/aws/outputs.tf`'s `aws_region` output is a bare `var.aws_region` echo, so this is `config.awsRegion` directly, no resource involved. */
  awsRegion: string;
  /** Mirrors {@link StackOutputs.ecsClusterName} — `ecs.cluster.name`. */
  ecsClusterName: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.ecsClusterArn} — `ecs.cluster.arn`. */
  ecsClusterArn: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.subnetIds} — every `network.publicSubnets` entry's `.id`, combined via `pulumi.all`. */
  subnetIds: pulumi.Output<string[]>;
  /** Mirrors {@link StackOutputs.securityGroupId} — `securityGroups.gameServers.id`. */
  securityGroupId: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.fileManagerSecurityGroupId} — `securityGroups.fileManager.id`. */
  fileManagerSecurityGroupId: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.efsFileSystemId} — `efs.fileSystem.id`. */
  efsFileSystemId: pulumi.Output<string>;
  /**
   * Mirrors {@link StackOutputs.efsAccessPoints} — game name → that game's
   * FIRST volume's access point id (`efs.gameAccessPoints["${game}-${firstVolumeName}"].id`),
   * matching `terraform/aws/outputs.tf`'s `efs_access_points` output exactly
   * (`aws_efs_access_point.game["${game}-${cfg.volumes[0].name}"].id`) — NOT
   * every `(game, volume)` access point `efs.gameAccessPoints` holds.
   */
  efsAccessPoints: pulumi.Output<Record<string, string>>;
  /** Mirrors {@link StackOutputs.domainName} — `terraform/aws/outputs.tf`'s `domain_name` output is a bare `var.hosted_zone_name` echo, so this is `config.hostedZoneName` directly. */
  domainName: string;
  /** Mirrors {@link StackOutputs.gameNames} — `Object.keys(config.gameServers)`, SORTED to match Terraform's `keys(map)` (always lexicographic, regardless of definition order). */
  gameNames: string[];
  /** Mirrors {@link StackOutputs.discordTableName} — `dynamoDb.discordTable.name`. */
  discordTableName: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.auditTableName} — `dynamoDb.auditTable.name` (the RESOLVED name, `dynamodb.ts`'s `resolveTableName` already applied — not `config.auditTableName`, which may be `""`). */
  auditTableName: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.runsTableName} — `dynamoDb.runsTable.name` (resolved, same caveat as {@link auditTableName}). */
  runsTableName: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.discordBotTokenSecretArn} — `secrets.discordBotTokenSecret.arn`. */
  discordBotTokenSecretArn: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.discordPublicKeySecretArn} — `secrets.discordPublicKeySecret.arn`. */
  discordPublicKeySecretArn: pulumi.Output<string>;
  /**
   * Mirrors {@link StackOutputs.interactionsInvokeUrl}. Per `discordDomain.ts`'s
   * file doc: `terraform/aws/outputs.tf`'s `interactions_invoke_url` output
   * resolves to the CUSTOM DOMAIN (`"https://discord.${var.hosted_zone_name}/"`),
   * NEVER the raw Lambda Function URL — so this reads
   * `discordDomain.aliasRecord.name` (the literal `discord.{hostedZoneName}`
   * input we passed that record, not its AWS-echoed `fqdn`, which would
   * carry a trailing dot), not `lambdas.interactionsFunctionUrl.functionUrl`.
   */
  interactionsInvokeUrl: pulumi.Output<string>;
  /**
   * Mirrors {@link StackOutputs.discordInteractionsUrl}. Per the same HCL
   * source (`terraform/aws/outputs.tf`'s `discord_interactions_url` output,
   * `"https://${local.discord_domain}/"`), this resolves to the IDENTICAL
   * value as {@link interactionsInvokeUrl} — both Terraform outputs already
   * overlap in the retired module; carried forward as-is for consumer parity
   * per `StackOutputs.discordInteractionsUrl`'s own doc, not resolved here.
   */
  discordInteractionsUrl: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.appliedGameServers} — `config.gameServers` directly (always populated once this program runs; the `| null` case is a `PulumiService`-side "never deployed yet" concern, not something this program itself ever produces). */
  appliedGameServers: Record<string, GameServerConfig>;
}

/**
 * Builds every {@link StackOutputValues} field off the resources
 * {@link defineAll} declared, field-by-field against `terraform/aws/outputs.tf`
 * — see {@link StackOutputValues}'s own doc for the full per-field mapping and
 * why resource-derived fields stay `pulumi.Output`-wrapped rather than
 * pre-resolved. `createInfraProgram`'s closure calls this immediately after
 * `defineAll` and returns the result as-is.
 *
 * @param resources - Every resource area {@link defineAll} returned.
 * @param config - The same `DeploymentConfig` {@link defineAll} was called
 *   with — several fields (`awsRegion`, `domainName`, `gameNames`,
 *   `appliedGameServers`) are bare config echoes with no resource
 *   round-trip, matching the HCL outputs they mirror.
 * @returns Every stack output, ready to return from the `PulumiFn` closure.
 */
export function buildStackOutputs(resources: InfraResources, config: DeploymentConfig): StackOutputValues {
  const gameAccessPointIds: Record<string, pulumi.Output<string>> = {};
  for (const [game, gameConfig] of Object.entries(config.gameServers)) {
    if (gameConfig.volumes.length === 0) {
      throw new Error(`buildStackOutputs: game "${game}" has no volumes configured — efs.gameAccessPoints has nothing to key off of.`);
    }
    const firstVolumeName = gameConfig.volumes[0].name;
    const key = `${game}-${firstVolumeName}`;
    const accessPoint = resources.efs.gameAccessPoints[key];
    if (!accessPoint) {
      throw new Error(
        `buildStackOutputs: no efs.gameAccessPoints entry for "${key}" — efs.gameAccessPoints and config.gameServers have drifted apart.`,
      );
    }
    gameAccessPointIds[game] = accessPoint.id;
  }

  // `interactionsInvokeUrl`/`discordInteractionsUrl` share the exact same
  // derivation — see both fields' doc on `StackOutputValues` for why they're
  // intentionally identical, matching the retired HCL's own overlap.
  const discordCustomDomainUrl = resources.discordDomain.aliasRecord.name.apply((name) => `https://${name}/`);

  return {
    awsRegion: config.awsRegion,
    ecsClusterName: resources.ecs.cluster.name,
    ecsClusterArn: resources.ecs.cluster.arn,
    subnetIds: pulumi.all(resources.network.publicSubnets.map((subnet) => subnet.id)),
    securityGroupId: resources.securityGroups.gameServers.id,
    fileManagerSecurityGroupId: resources.securityGroups.fileManager.id,
    efsFileSystemId: resources.efs.fileSystem.id,
    efsAccessPoints: pulumi.all(gameAccessPointIds),
    domainName: config.hostedZoneName,
    gameNames: Object.keys(config.gameServers).sort(),
    discordTableName: resources.dynamoDb.discordTable.name,
    auditTableName: resources.dynamoDb.auditTable.name,
    runsTableName: resources.dynamoDb.runsTable.name,
    discordBotTokenSecretArn: resources.secrets.discordBotTokenSecret.arn,
    discordPublicKeySecretArn: resources.secrets.discordPublicKeySecret.arn,
    interactionsInvokeUrl: discordCustomDomainUrl,
    discordInteractionsUrl: discordCustomDomainUrl,
    appliedGameServers: config.gameServers,
  };
}

/**
 * Builds the Pulumi inline-program closure for the Hyveon infrastructure
 * stack. Returns a {@link PulumiFn} — the Automation API runs this closure
 * in-process (no `pulumi` CLI subprocess for the program body itself) to
 * preview or apply the stack.
 *
 * `config` is captured by the returned closure at creation time; it flows in
 * as a plain typed object (`@hyveon/shared`'s {@link DeploymentConfig}), not
 * via `pulumi.Config` — the desktop app reads it from the JSON configuration
 * store and passes it straight in.
 *
 * Every resource declaration happens inside the returned closure, never at
 * module scope: an inline program's resource lifecycle is scoped to a
 * single closure invocation. The closure's entire body is a call to
 * {@link defineAll} followed by {@link buildStackOutputs} — see either
 * function's doc for how resource areas are wired together and how every
 * stack-output field is derived.
 *
 * ## Outputs mechanism
 *
 * The Automation API's inline `PulumiFn` type is
 * `() => Promise<Record<string, any> | void>` (`@pulumi/pulumi/automation`'s
 * `workspace.d.ts`) — a RETURN VALUE, not an `export`-style call. In
 * `@pulumi/pulumi`'s own runtime, `runtime/stack.js`'s `runInPulumiStack(init)`
 * constructs a root `Stack` resource and calls `stack.initialize({ init })`,
 * whose body awaits `args.init()`'s return value, `massage()`s it, then calls
 * `super.registerOutputs(outputs)` on the result — i.e. whatever object this
 * closure returns (the SAME closure the Automation API installs as its gRPC
 * language-runtime callback for both file-based and inline programs) is
 * exactly what becomes the stack's registered outputs, one top-level key per
 * output name. `massage()` recursively resolves `pulumi.Output`, `Promise`,
 * array, and plain-value entries anywhere in that returned tree, so
 * returning `Output`-wrapped fields (as {@link buildStackOutputs} does) is
 * not only valid but preferred — pre-resolving with `await`/`promiseOf`
 * before returning would only strip the dependency edges the engine tracks
 * for preview/diff purposes. There is no `pulumi.export(...)` function in
 * the Node.js SDK: `export const` at a Pulumi program's module top level is
 * the Node idiom for a FILE-BASED program (`cmd/run/run.js` captures a
 * CommonJS/ESM module's own exports as the stack's outputs), and
 * `pulumi.export(name, value)` is the Python/Go SDKs' idiom, not Node's —
 * neither applies here regardless, since an inline `PulumiFn` closure has no
 * module-scope top level for either mechanism to attach to. The return-value
 * path above is the one, and only, mechanism `LocalWorkspace`'s
 * inline-program `PulumiFn` contract exercises in this SDK — the mechanism
 * `PulumiService`'s `stack.outputs()` read-back relies on.
 *
 * @param config - The full deployment configuration to derive infrastructure
 *   from.
 * @param options - Machine-local inputs `DeploymentConfig` deliberately
 *   excludes, e.g. `lambdaBundlesDir` — see {@link InfraProgramOptions}.
 *   `PulumiService` resolves and supplies this at runtime.
 * @returns A `PulumiFn` suitable for `LocalWorkspace.createOrSelectStack`'s
 *   inline-program `program` option. Resolves to the {@link StackOutputValues}
 *   object {@link buildStackOutputs} built — the Automation API registers it
 *   as the stack's outputs (see "Outputs mechanism" above).
 */
export function createInfraProgram(config: DeploymentConfig, options: InfraProgramOptions): PulumiFn {
  return async () => {
    const resources = defineAll(config, options);
    return buildStackOutputs(resources, config);
  };
}
