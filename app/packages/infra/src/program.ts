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
 * Every resource area {@link defineAll} declares, keyed by module —
 * including the AWS provider itself, since it too is a real Pulumi resource
 * (`pulumi:providers:aws`) whose region/tags are worth asserting on
 * directly. This is the type `defineAll`'s tests hold real handles against;
 * `createInfraProgram`'s closure also binds this shape to a local variable
 * (even though it currently returns none of it — see that function's doc)
 * so later dispatches extending the closure body have downstream resources
 * (e.g. `securityGroups.gameServers.id` for an EFS mount target's security
 * group, once task 3.2 needs it) visibly in scope rather than needing to
 * re-derive them.
 */
export interface InfraResources {
  /** The AWS provider every resource below is declared against. */
  provider: aws.Provider;
  /** Networking resources (task 3.1) — see {@link NetworkResources}. */
  network: NetworkResources;
  /** Security-group resources (task 3.4) — see {@link SecurityGroupResources}. */
  securityGroups: SecurityGroupResources;
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
 * @returns Every declared resource area, keyed by module — see
 *   {@link InfraResources}.
 */
export function defineAll(config: DeploymentConfig): InfraResources {
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

  // TODO(task 3.6): wire in `./iam.js` in this order — the only order that
  // satisfies every dependency (see `iam.ts`'s file doc for the full
  // rationale, including why roles and policies are two separate functions,
  // not one):
  //   1. `defineIamRoles(...)` — needs nothing from any later task (every
  //      role's trust policy is a static literal); could be called here
  //      today, but is left for task 3.6 to wire in alongside the rest of
  //      this list rather than split across two commits.
  //   2. `defineLambdas(...)` (task 3.6) — creates the Lambda functions
  //      using each role's `.arn` from step 1 (e.g.
  //      `followupLambdaRole.arn` for the followup function's `role`).
  //   3. `defineIamPolicies(...)` — needs the roles from step 1 (by
  //      reference) plus every deferred ARN: `efsFileSystemArn` (task 3.2),
  //      `dynamodbDiscordTableArn` + `discordPublicKeySecretArn` (task 3.8),
  //      `followupLambdaArn` (the followup function's `.arn` from step 2),
  //      and `hostedZoneId` (task 3.9).
  return { provider, network, securityGroups };
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
 * @returns A `PulumiFn` suitable for `LocalWorkspace.createOrSelectStack`'s
 *   inline-program `program` option.
 */
export function createInfraProgram(config: DeploymentConfig): PulumiFn {
  return async () => {
    const resources = defineAll(config);
    void resources; // Bound for 3.11 to extend; no stack outputs exported yet.
  };
}
