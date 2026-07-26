/**
 * Pure helpers for the first-run wizard shell — step ordering, OS detection
 * for prerequisite install instructions, and the prerequisites-satisfied
 * gate. No React imports, so these are testable independent of any
 * component.
 */
import type { PrerequisitesReport } from '@hyveon/desktop-preload';

/**
 * Ordered wizard steps. Later PRs in this epic (#200/#203/#205 bootstrap,
 * #208 IAM check, #210 terraform-init) append to this array.
 */
export const WIZARD_STEPS = ['prerequisites', 'pick-cloud', 'credentials'] as const;

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
