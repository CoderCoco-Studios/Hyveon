import { writeFileSync } from 'node:fs';

/**
 * Scripted `terraform_version` every fixture's `version` entry resolves
 * `TerraformService`'s memoized binary/version resolution against — an
 * arbitrary but realistic-looking semver string, never compared against a
 * real Terraform release.
 */
export const FAKE_TERRAFORM_VERSION = '1.9.0';

/** ANSI red-foreground escape sequence, used by {@link ansiPlanEntry} to exercise byte-for-byte passthrough. */
export const ANSI_RED = '\u001b[31m';
/** ANSI reset escape sequence, paired with {@link ANSI_RED}. */
export const ANSI_RESET = '\u001b[0m';

/** A single scripted stdout/stderr line — mirrors `fake-terraform.mjs`'s fixture line shape. */
interface FixtureLine {
  stream: 'stdout' | 'stderr';
  text: string;
  delayMs?: number;
}

/** A single subcommand's scripted response — mirrors `fake-terraform.mjs`'s fixture entry shape. */
interface FixtureEntry {
  exitCode?: number;
  lines: FixtureLine[];
  outFileContent?: string;
}

/**
 * The `version` entry every fixture must include so `TerraformService`'s
 * `terraform version -json` resolution succeeds against the fake binary —
 * see `fake-terraform.mjs`'s TSDoc and the "Fake terraform binary injected
 * via PATH" requirement in this change's spec.
 */
export function versionEntry(): FixtureEntry {
  return {
    exitCode: 0,
    lines: [{ stream: 'stdout', text: JSON.stringify({ terraform_version: FAKE_TERRAFORM_VERSION }) }],
  };
}

/**
 * A successful `plan` entry: scripts Terraform's summary line (parsed by
 * `TerraformService`'s `PLAN_SUMMARY_PATTERN`) and `outFileContent` so the
 * `.tfplan` artifact `-out=` points at actually exists on disk for
 * `computePlanHash` to hash.
 */
export function successfulPlanEntry(
  opts: { add?: number; change?: number; destroy?: number; artifactContent?: string } = {},
): FixtureEntry {
  const { add = 1, change = 0, destroy = 0, artifactContent = 'scripted-plan-artifact-bytes' } = opts;
  return {
    exitCode: 0,
    lines: [
      { stream: 'stdout', text: 'Refreshing state...' },
      { stream: 'stdout', text: `Plan: ${add} to add, ${change} to change, ${destroy} to destroy.` },
    ],
    outFileContent: artifactContent,
  };
}

/** A failing `plan` entry: non-zero exit, no `outFileContent` (mirrors a real `terraform plan` that never reaches `-out=`). */
export function failedPlanEntry(): FixtureEntry {
  return {
    exitCode: 1,
    lines: [{ stream: 'stderr', text: 'Error: mock plan failure' }],
  };
}

/** A successful `apply` entry: scripts Terraform's summary line, parsed by `TerraformService`'s `APPLY_SUMMARY_PATTERN`. */
export function successfulApplyEntry(opts: { added?: number; changed?: number; destroyed?: number } = {}): FixtureEntry {
  const { added = 1, changed = 0, destroyed = 0 } = opts;
  return {
    exitCode: 0,
    lines: [
      { stream: 'stdout', text: 'Applying...' },
      { stream: 'stdout', text: `Apply complete! Resources: ${added} added, ${changed} changed, ${destroyed} destroyed.` },
    ],
  };
}

/** A successful `destroy` entry: scripts Terraform's summary line, parsed by `TerraformService`'s `DESTROY_SUMMARY_PATTERN`. */
export function successfulDestroyEntry(opts: { destroyed?: number } = {}): FixtureEntry {
  const { destroyed = 1 } = opts;
  return {
    exitCode: 0,
    lines: [
      { stream: 'stdout', text: 'Destroying...' },
      { stream: 'stdout', text: `Destroy complete! Resources: ${destroyed} destroyed.` },
    ],
  };
}

/** A successful `output` entry: scripts valid `terraform output -json` output for `TerraformService.output` to parse. */
export function successfulOutputEntry(outputs: Record<string, { value: unknown; type?: unknown }>): FixtureEntry {
  return { exitCode: 0, lines: [{ stream: 'stdout', text: JSON.stringify(outputs) }] };
}

/**
 * A successful `plan` entry whose stdout/stderr lines interleave ANSI escape
 * sequences ({@link ANSI_RED}/{@link ANSI_RESET}) — used by the streaming
 * spec to assert chunks and the persisted `terraform.log` preserve them
 * byte-for-byte.
 */
export function ansiPlanEntry(): FixtureEntry {
  return {
    exitCode: 0,
    lines: [
      { stream: 'stdout', text: `${ANSI_RED}Refreshing state...${ANSI_RESET}` },
      { stream: 'stderr', text: `${ANSI_RED}Warning: deprecated argument${ANSI_RESET}` },
      { stream: 'stdout', text: 'Plan: 1 to add, 0 to change, 0 to destroy.' },
    ],
    outFileContent: 'scripted-plan-artifact-bytes',
  };
}

/**
 * Serializes `entries` (keyed by subcommand — `version`/`plan`/`apply`/
 * `destroy`/`output`) to `scriptPath`, the path `fake-terraform.mjs` reads
 * via `FAKE_TERRAFORM_SCRIPT` (see `terraformFixture.scriptPath` from
 * `terraform-shim.ts`).
 */
export function writeFixture(scriptPath: string, entries: Record<string, FixtureEntry>): void {
  writeFileSync(scriptPath, JSON.stringify(entries, null, 2));
}
