/**
 * The Pulumi inline-program factory — the `@hyveon/infra` package's public
 * entry point (re-exported from `index.ts`). Establishes the pattern every
 * later Phase-3 dispatch (EFS, ECS, IAM, Lambdas, ...) follows: one
 * `defineX(...)` module per Terraform-file-shaped resource area, all wired
 * together inside the closure {@link createInfraProgram} returns.
 */

import * as aws from '@pulumi/aws';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import type { DeploymentConfig } from '@hyveon/shared';
import { defineNetwork, type NetworkResources } from './network.js';
import { defineSecurityGroups, type SecurityGroupResources } from './securityGroups.js';
import { defineIamRoles, type IamRoleResources } from './iam.js';
import { defineEfs, type EfsResources } from './efs.js';
import { defineEcs, type EcsResources } from './ecs.js';

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
 * (Phase 6) and is meant to be portable across whichever machine runs a
 * deploy, whereas a filesystem path is inherently tied to the machine it
 * was resolved on. Modeled as a separate, required second parameter rather
 * than folded into `DeploymentConfig` for exactly that reason.
 */
export interface InfraProgramOptions {
  /**
   * The directory every `@hyveon/lambda-*` package's prebuilt
   * `dist/handler.cjs` bundle is resolved against — `lambdas.ts`'s
   * `DefineLambdasArgs.lambdaBundlesDir`, threaded straight through once
   * `defineLambdas` is wired into {@link defineAll} (see the
   * `TODO(task 3.8/3.9)` comment there). See `lambdas.ts`'s file doc, "The
   * lambda-bundle path contract", for the full rationale (including why it
   * has no default anywhere in this package) and what Phase 7's
   * `PulumiService` must resolve and supply here at runtime.
   */
  lambdaBundlesDir: string;
}

/**
 * Every resource area {@link defineAll} declares, keyed by module —
 * including the AWS provider itself, since it too is a real Pulumi resource
 * (`pulumi:providers:aws`) whose region/tags are worth asserting on
 * directly. This is the type `defineAll`'s tests hold real handles against;
 * `createInfraProgram`'s closure also binds this shape to a local variable
 * (even though it currently returns none of it — see that function's doc)
 * so later dispatches extending the closure body have downstream resources
 * (e.g. `ecs.taskDefinitions` for a future Lambda's `RunTask` wiring, once
 * task 3.6 needs it) visibly in scope rather than needing to re-derive them.
 */
export interface InfraResources {
  /** The AWS provider every resource below is declared against. */
  provider: aws.Provider;
  /** Networking resources (task 3.1) — see {@link NetworkResources}. */
  network: NetworkResources;
  /**
   * Security-group resources (task 3.4), plus the EFS-seeder security group
   * and its conditional ingress rule on `efs` (task 3.6/3.7's ownership
   * item, folded into `defineSecurityGroups` — see that file's doc) — see
   * {@link SecurityGroupResources}.
   */
  securityGroups: SecurityGroupResources;
  /**
   * IAM roles + the ECS task-execution managed-policy attachment (task 3.5)
   * — see {@link IamRoleResources}. `defineIamPolicies`'s five inline
   * policies are NOT included here yet; see the `TODO(task 3.8/3.9)`
   * comment in {@link defineAll} for why they stay unwired.
   */
  iamRoles: IamRoleResources;
  /** EFS resources (task 3.2) — see {@link EfsResources}. */
  efs: EfsResources;
  /** ECS cluster, log groups, and task definitions (task 3.3) — see {@link EcsResources}. */
  ecs: EcsResources;
}

/**
 * Declares every resource this dispatch's phase covers and wires them
 * together: constructs the shared AWS provider, then calls each
 * `defineX(...)` module in dependency order, threading the provider and each
 * module's output into the next. This is the function
 * {@link createInfraProgram}'s closure delegates to — pulled out to a
 * separate, synchronously-returning function (rather than left inline in the
 * closure) specifically so tests get real resource handles to await
 * precisely with `promiseOf` (see `testing/pulumiMocks.ts`), instead of
 * having to infer completion from the closure's opaque
 * `Promise<Record<string, any> | void>` return.
 *
 * Every later Phase-3 dispatch (EFS, ECS, IAM, Lambdas, ...) adds its
 * `defineX(...)` call here, in the same pattern: construct/derive whatever
 * inputs it needs from `config` and the resources already returned above it,
 * append its result to the returned object, and extend {@link InfraResources}
 * to match.
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
 *   excludes — see {@link InfraProgramOptions}. Not yet consumed inside this
 *   function's body (`defineLambdas` isn't wired in yet — see the
 *   `TODO(task 3.8/3.9)` comment below), but threaded through now so the
 *   signature is already in place for that wiring.
 * @returns Every declared resource area, keyed by module — see
 *   {@link InfraResources}.
 */
export function defineAll(config: DeploymentConfig, options: InfraProgramOptions): InfraResources {
  void options; // TODO(task 3.8/3.9): becomes `defineLambdas`' `lambdaBundlesDir` once wired in below.

  const provider = new aws.Provider('aws', {
    region: config.awsRegion,
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

  // `defineIamRoles(...)` needs nothing from any later task (every role's
  // trust policy is a static literal) — wired in now because `defineEcs`
  // below consumes `iamRoles.ecsTaskExecutionRole.arn` for every task
  // definition's `execution_role_arn`.
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
  // doc). Neither depends on any deferred task-3.8/3.9 value or on
  // `defineLambdas`, unlike the two items in the TODO below.
  //
  // TODO(task 3.8/3.9): `defineLambdas` (`lambdas.ts`) is fully implemented
  // and tested (task 3.6/3.7) but NOT wired in here yet — same status
  // `defineIamPolicies` was already left in after task 3.5. Both share the
  // same blocker: each needs at least one deferred `pulumi.Input` this
  // dispatch has no real resource to supply (`dynamodbDiscordTableName`/
  // `dynamodbDiscordTableArn` + `discordPublicKeySecretArn`, task 3.8;
  // `hostedZoneId`, task 3.9) — see `lambdas.ts`'s file doc, "Why
  // `defineLambdas` is not wired into `defineAll` yet", for the full
  // rationale. Once tasks 3.8 and 3.9 land, wire both in this order — the
  // only order that satisfies every dependency:
  //
  //   1. `defineLambdas(...)` — needs `iamRoles` (already in scope; use
  //      `iamRoles.<x>LambdaRole.arn` for each function's `role`),
  //      `efs`/`ecs` (already in scope), `securityGroups.efsSeeder?.id` for
  //      `efsSeederSecurityGroupId` (already in scope — see the NOTE
  //      above), `options.lambdaBundlesDir` (already threaded through this
  //      function's own signature — see {@link InfraProgramOptions}), and
  //      the new deferred inputs from 3.8/3.9.
  //   2. `defineIamPolicies(...)` from `./iam.js` — needs `iamRoles` (by
  //      reference) plus every deferred ARN: `efsFileSystemArn` (already
  //      available: `efs.fileSystem.arn`), `dynamodbDiscordTableArn` +
  //      `discordPublicKeySecretArn` (task 3.8), `followupLambdaArn` (now
  //      real: `lambdas.followupFunction.arn`), and `hostedZoneId`
  //      (task 3.9).
  return { provider, network, securityGroups, iamRoles, efs, ecs };
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
 * store (Phase 6 of `migrate-iac-to-pulumi`) and passes it straight in.
 *
 * Every resource declaration happens inside the returned closure, never at
 * module scope: an inline program's resource lifecycle is scoped to a
 * single closure invocation. The closure's entire body is a call to
 * {@link defineAll} — see that function's doc for how resource areas are
 * wired together and why the declaration logic lives there rather than
 * inline here.
 *
 * The closure's result is bound to a local variable (not discarded) even
 * though it currently returns `void`: real stack-output export is task
 * 3.11's scope, not this dispatch's, but binding the result now means the
 * resources are already in scope, ready for that task to pick specific
 * fields off of rather than needing to re-plumb the call.
 *
 * @param config - The full deployment configuration to derive infrastructure
 *   from.
 * @param options - Machine-local inputs `DeploymentConfig` deliberately
 *   excludes, e.g. `lambdaBundlesDir` — see {@link InfraProgramOptions}.
 *   Phase 7's `PulumiService` resolves and supplies this at runtime.
 * @returns A `PulumiFn` suitable for `LocalWorkspace.createOrSelectStack`'s
 *   inline-program `program` option.
 */
export function createInfraProgram(config: DeploymentConfig, options: InfraProgramOptions): PulumiFn {
  return async () => {
    const resources = defineAll(config, options);
    void resources; // Bound for 3.11 to extend; no stack outputs exported yet.
  };
}
