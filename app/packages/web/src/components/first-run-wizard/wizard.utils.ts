/**
 * Pure helpers for the first-run wizard shell — step ordering, OS detection
 * for prerequisite install instructions, and the prerequisites-satisfied
 * gate. No React imports, so these are testable independent of any
 * component.
 */
import type { PrerequisitesReport } from '@hyveon/desktop-preload';

/**
 * Ordered wizard steps.
 */
export const WIZARD_STEPS = ['prerequisites', 'pick-cloud', 'credentials', 'bootstrap', 'terraform-init'] as const;

/** A single step in {@link WIZARD_STEPS}. */
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Operating systems the prerequisites step can tailor install instructions for. */
export type DetectedOs = 'macos' | 'windows' | 'linux' | 'unknown';

/**
 * Detects the operating system from a user-agent string (defaults to
 * `navigator.userAgent`), used to pick which install instructions to show.
 */
export function detectOs(userAgent: string = navigator.userAgent): DetectedOs {
  const ua = userAgent.toLowerCase();
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

/**
 * True once both `terraform` and `aws` are found, and terraform's resolved
 * version (when parseable) meets the minimum. An unparseable version
 * (`minimumVersionSatisfied === undefined`) does not block progression —
 * only an explicit `false` does.
 */
export function arePrerequisitesSatisfied(report: PrerequisitesReport | null): boolean {
  if (!report) return false;
  return report.terraform.found && report.terraform.minimumVersionSatisfied !== false && report.aws.found;
}

/** A backend bootstrap resource the wizard's bootstrap step creates. */
export type BootstrapResourceKey = 'stateBucket' | 'lockTable' | 'tfvarsBucket';

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
    tfvarsBucket: `${projectName}-tfvars`,
  };
}
