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
 * `lockTable` named this union until task 10.3: it was never a resource the
 * bootstrap step creates — nothing has bootstrapped a DynamoDB lock table
 * since task 5.1 removed `BootstrapService.ensureLockTable` — and the
 * bootstrap step never rendered a row for it. It survived only because the
 * now-deleted `terraform-init` step's `backendConfig.dynamodbTable` fed it
 * to the (also now-deleted) `terraform.init` call, which required a
 * non-empty string. Task 10.3 replaced that step with the Pulumi
 * stack-initialization step, which needs no lock-table name at all — so the
 * key is gone.
 */
export type BootstrapResourceKey = 'stateBucket' | 'configurationBucket';

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
    configurationBucket: `${projectName}-tfvars`,
  };
}
