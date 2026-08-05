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
 * Does not include a lock-table key: nothing bootstraps a DynamoDB lock
 * table, and the bootstrap step never renders a row for one.
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
 * matching `terraform/variables.tf`'s `project_name` default). These are
 * operator-editable rather than fixed — the defaults just save typing in the
 * common case.
 */
export function defaultBootstrapResourceNames(projectName = 'hyveon'): Record<BootstrapResourceKey, string> {
  return {
    stateBucket: `${projectName}-tfstate`,
    configurationBucket: `${projectName}-config`,
  };
}
