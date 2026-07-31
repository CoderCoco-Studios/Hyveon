/**
 * Pure helpers for the first-run wizard shell — step ordering and bootstrap
 * resource naming. No React imports, so these are testable independent of
 * any component.
 */
import { WIZARD_STEPS, type WizardStep } from '@hyveon/shared';

export { WIZARD_STEPS, type WizardStep };

/**
 * A backend bootstrap resource name tracked by the wizard's bootstrap step.
 *
 * @remarks
 * `lockTable` is **not** a resource the bootstrap step creates — nothing
 * has bootstrapped a DynamoDB lock table since task 5.1 removed
 * `BootstrapService.ensureLockTable`, and the bootstrap step renders no row
 * for it (see `bootstrap-step.component.tsx`'s `VisibleBootstrapResource`).
 * The key survives here only because `first-run-wizard.component.tsx`'s
 * `backendConfig.dynamodbTable` still feeds it to the still-live
 * `terraform.init` call, which requires a non-empty string — removing it
 * outright would break that (still-tested) call. Task 10.3 (replacing the
 * Terraform-init step with the Pulumi stack-initialization step) is where
 * `dynamodbTable` — and this key — should finally disappear.
 */
export type BootstrapResourceKey = 'stateBucket' | 'lockTable' | 'configurationBucket';

/**
 * Client-side status for a single bootstrap resource row. Extends the
 * backend's `created`/`exists`/`failed` (`BootstrapResult['status']`) with
 * `pending` (not yet run) and `creating` (call in flight) — states the
 * backend has no need to represent since it only ever returns a final result.
 */
export type BootstrapResourceState = 'pending' | 'creating' | 'created' | 'exists' | 'failed';

/**
 * Sensible default resource names for the bootstrap step's editable name
 * fields, derived from the operator's project name (defaults to `hyveon`,
 * matching `terraform/variables.tf`'s `project_name` default). Per design.md's
 * open questions, these are operator-editable rather than fixed — the
 * defaults just save typing in the common case.
 */
export function defaultBootstrapResourceNames(projectName = 'hyveon'): Record<BootstrapResourceKey, string> {
  return {
    stateBucket: `${projectName}-tfstate`,
    lockTable: `${projectName}-tflock`,
    configurationBucket: `${projectName}-tfvars`,
  };
}
