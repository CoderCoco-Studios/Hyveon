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
import { defineNetwork } from './network.js';
import { defineSecurityGroups } from './securityGroups.js';

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
 * single closure invocation. Each resource area lives in its own
 * `defineX(...)` module (`network.ts`, `securityGroups.ts`, and — in later
 * dispatches — `efs.ts`, `ecs.ts`, `iam.ts`, `lambdas.ts`, ...), called from
 * here with the config and upstream resources it needs; no module holds
 * resource state of its own.
 *
 * The AWS provider is constructed once per closure invocation, with its
 * region taken from `config.awsRegion` (never an ambient env var) and
 * {@link DEFAULT_TAGS} applied via `defaultTags` — the mechanism Pulumi
 * provides for Terraform's provider-level `default_tags` block. It is
 * threaded explicitly into every `defineX(...)` call (as `provider` in each
 * function's args) rather than relying on Pulumi's implicit default-provider
 * resolution, so every resource's region/tags are traceably wired rather
 * than picked up ambiently.
 *
 * @param config - The full deployment configuration to derive infrastructure
 *   from.
 * @returns A `PulumiFn` suitable for `LocalWorkspace.createOrSelectStack`'s
 *   inline-program `program` option.
 */
export function createInfraProgram(config: DeploymentConfig): PulumiFn {
  return async () => {
    const provider = new aws.Provider('aws', {
      region: config.awsRegion,
      defaultTags: { tags: DEFAULT_TAGS },
    });

    const network = defineNetwork({
      projectName: config.projectName,
      vpcCidr: config.vpcCidr,
      provider,
    });

    defineSecurityGroups({
      projectName: config.projectName,
      gameServers: config.gameServers,
      vpcId: network.vpc.id,
      provider,
    });
  };
}
