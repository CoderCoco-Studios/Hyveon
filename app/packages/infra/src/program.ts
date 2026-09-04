/**
 * The Pulumi inline-program factory — the `@hyveon/infra` package's public
 * entry point (re-exported from `index.ts`). Establishes the pattern every
 * resource-area module (EFS, ECS, IAM, Lambdas, ...) follows: one
 * `defineX(...)` module per resource area, all wired together inside the
 * closure {@link createInfraProgram} returns.
 *
 * Two omissions from `defineAll` below are load-bearing and easy to miss
 * when reading the module list: the runs table is bootstrap-managed (see
 * `dynamodb.ts`'s file doc) rather than provisioned here, and
 * {@link StackOutputValues.appliedGameServers} is a plain config echo, not
 * `pulumi.secret(...)`, so anything that surfaces it downstream
 * (`PulumiService`, CLI-equivalent logging, `pulumi up` output) must apply
 * its own redaction — this program cannot provide it at the
 * `PulumiFn`-return-value layer.
 */

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import { resolveRunsTableName, type DeploymentConfig, type GameServerConfig, type StackOutputs } from '@hyveon/shared';
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
 * `defaultTags` — the `Project: hyveon` invariant CLAUDE.md documents.
 * Deliberately NOT derived from `config.projectName`: it is a fixed
 * resource-tagging value, independent of the renameable `projectName`.
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
 * applied via `defaultTags` — the mechanism Pulumi provides for the legacy
 * tool's provider-level `default_tags` block. It is threaded explicitly into every
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
  // `hostedZoneName` feeds both `aws.route53.getZoneOutput`'s `name` filter
  // (route53.ts) and `discordDomain.ts`'s `discord.${hostedZoneName}` FQDN.
  // An empty string passes TypeScript's `string` type but produces a
  // Route 53 "multiple hosted zones matched" error and an ACM "domain_name
  // cannot end with a period" error respectively — both surfaced deep in
  // the Pulumi preview with no indication the root cause is a blank config
  // field. Fail fast here instead.
  const hostedZoneName = config.hostedZoneName.trim();
  if (hostedZoneName.length === 0) {
    throw new Error(
      'defineAll: config.hostedZoneName is empty — set the hosted zone name in Settings before deploying.',
    );
  }

  const provider = new aws.Provider('aws', {
    region: config.awsRegion,
    defaultTags: { tags: DEFAULT_TAGS },
  });

  // CloudFront's ACM certificate must live in us-east-1 regardless of
  // `config.awsRegion`. Threaded ONLY into `discordDomain`'s certificate +
  // certificate-validation resources below; every other resource in this
  // program uses the regional `provider` above.
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
    hostedZoneName,
    gameServers: config.gameServers,
    efs,
    executionRoleArn: iamRoles.ecsTaskExecutionRole.arn,
    provider,
  });

  // NOTE: the seeder security group and the seeder-sourced ingress rule on
  // the `efs` security group are ALREADY wired in above, as part of
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
    provider,
  });

  const secrets = defineSecrets({
    projectName: config.projectName,
    provider,
  });

  // ── Route 53 hosted-zone lookup ────────────────────────────────────────────
  const route53 = defineRoute53({
    hostedZoneName,
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
    hostedZoneName,
    dnsTtl: config.dnsTtl,
    watchdogIntervalMinutes: config.watchdogIntervalMinutes,
    watchdogIdleChecks: config.watchdogIdleChecks,
    watchdogMinPackets: config.watchdogMinPackets,
    gameServers: config.gameServers,
    roles: iamRoles,
    publicSubnetIds: network.publicSubnets.map((subnet) => subnet.id),
    efsSeederSecurityGroupId: securityGroups.efsSeeder?.id,
    healthCheckSecurityGroupId: securityGroups.healthCheck?.id,
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
    hostedZoneName,
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
    ecsClusterName: ecs.cluster.name,
    gameServers: config.gameServers,
    healthCheckFunctionArn: lambdas.healthCheckFunction?.arn,
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
 * {@link appliedGameServers} — mirroring the four legacy-tool outputs
 * (`aws_region`, `domain_name`, `game_names`, `applied_game_servers`) whose
 * HCL `value` is a bare `var.*`/`keys(var.*)` expression, never a resource
 * attribute.
 *
 * `extends Record<keyof StackOutputs, unknown>` is a genuine compile-time
 * completeness check, not decoration: it fails to build if this interface
 * ever drops a field {@link StackOutputs} declares (or a future
 * {@link StackOutputs} field has no matching entry here), so every
 * `StackOutputs` field is guaranteed a matching entry here — though this
 * check is one-directional: it doesn't reject an extra field this interface
 * declares beyond what `StackOutputs` has.
 */
export interface StackOutputValues extends Record<keyof StackOutputs, unknown> {
  /** Mirrors {@link StackOutputs.awsRegion} — `config.awsRegion` directly, no resource involved. */
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
   * FIRST volume's access point id (`efs.gameAccessPoints["${game}-${firstVolumeName}"].id`)
   * — NOT every `(game, volume)` access point `efs.gameAccessPoints` holds.
   */
  efsAccessPoints: pulumi.Output<Record<string, string>>;
  /** Mirrors {@link StackOutputs.domainName} — `config.hostedZoneName` directly. */
  domainName: string;
  /** Mirrors {@link StackOutputs.gameNames} — `Object.keys(config.gameServers)`, SORTED so the value is deterministic regardless of definition order. */
  gameNames: string[];
  /** Mirrors {@link StackOutputs.discordTableName} — `dynamoDb.discordTable.name`. */
  discordTableName: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.auditTableName} — `dynamoDb.auditTable.name` (the RESOLVED name, `dynamodb.ts`'s `resolveTableName` already applied — not `config.auditTableName`, which may be `""`). */
  auditTableName: pulumi.Output<string>;
  /**
   * Mirrors {@link StackOutputs.runsTableName} — a plain `string`, not a
   * `pulumi.Output`: the runs table isn't Pulumi-managed (see `dynamodb.ts`'s
   * file doc). Computed via `@hyveon/shared`'s `resolveRunsTableName`, the
   * same resolution `BootstrapService.ensureRunsTable` uses at bootstrap — so
   * this field is correct as of a stack's first successful `apply()`, unlike
   * {@link auditTableName}.
   */
  runsTableName: string;
  /** Mirrors {@link StackOutputs.discordBotTokenSecretArn} — `secrets.discordBotTokenSecret.arn`. */
  discordBotTokenSecretArn: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.discordPublicKeySecretArn} — `secrets.discordPublicKeySecret.arn`. */
  discordPublicKeySecretArn: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.fileBrowserCredentialSecretArn} — `secrets.fileBrowserCredentialSecret.arn`. */
  fileBrowserCredentialSecretArn: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.fileBrowserSchedulerRoleArn} — `iamRoles.fileBrowserSchedulerRole.arn`. */
  fileBrowserSchedulerRoleArn: pulumi.Output<string>;
  /**
   * Mirrors {@link StackOutputs.interactionsInvokeUrl} — resolves to the
   * CUSTOM DOMAIN (`"https://discord.${hostedZoneName}/"`), NEVER the raw
   * Lambda Function URL: reads `discordDomain.aliasRecord.name` (the literal
   * `discord.{hostedZoneName}` input, not its AWS-echoed `fqdn`, which
   * carries a trailing dot), not `lambdas.interactionsFunctionUrl.functionUrl`.
   */
  interactionsInvokeUrl: pulumi.Output<string>;
  /**
   * Mirrors {@link StackOutputs.discordInteractionsUrl} — resolves to the
   * IDENTICAL value as {@link interactionsInvokeUrl}; carried forward as a
   * separate field for consumer parity per
   * `StackOutputs.discordInteractionsUrl`'s own doc, not resolved here.
   */
  discordInteractionsUrl: pulumi.Output<string>;
  /** Mirrors {@link StackOutputs.appliedGameServers} — `config.gameServers` directly (always populated once this program runs; the `| null` case is a `PulumiService`-side "never deployed yet" concern, not something this program itself ever produces). */
  appliedGameServers: Record<string, GameServerConfig>;
}

/**
 * Builds every {@link StackOutputValues} field off the resources
 * {@link defineAll} declared, field-by-field against the legacy tool's
 * outputs file — see {@link StackOutputValues}'s own doc for the full per-field mapping and
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
    runsTableName: resolveRunsTableName(config.projectName, config.runsTableName),
    discordBotTokenSecretArn: resources.secrets.discordBotTokenSecret.arn,
    discordPublicKeySecretArn: resources.secrets.discordPublicKeySecret.arn,
    fileBrowserCredentialSecretArn: resources.secrets.fileBrowserCredentialSecret.arn,
    fileBrowserSchedulerRoleArn: resources.iamRoles.fileBrowserSchedulerRole.arn,
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
 * `config` is captured by the returned closure at creation time, as a plain
 * typed object (`@hyveon/shared`'s {@link DeploymentConfig}), not via
 * `pulumi.Config`. Every resource declaration happens inside the returned
 * closure, never at module scope — an inline program's resource lifecycle is
 * scoped to a single closure invocation. The closure's entire body is a call
 * to {@link defineAll} followed by {@link buildStackOutputs}.
 *
 * The closure's return value becomes the stack's registered outputs — the
 * Automation API's `massage()` step resolves `pulumi.Output`/`Promise`/plain
 * values recursively when registering them, so {@link buildStackOutputs}
 * returns `Output`-wrapped fields rather than pre-resolving them: doing so
 * would only strip the dependency edges the engine tracks for preview/diff.
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
