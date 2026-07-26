import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { MINIMUM_TERRAFORM_VERSION } from '@hyveon/shared';
import { lookupCommandFor } from './TerraformService.js';

const execFileAsync = promisify(execFile);

/**
 * Timeout applied to every CLI probe (`which`/`where.exe` lookups and
 * `terraform`/`aws` version invocations). Without one, a hung subprocess
 * would leave {@link PrerequisiteService.check} pending indefinitely instead
 * of degrading to a reported status.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** Detection result for a single prerequisite binary. */
export interface PrerequisiteCheckResult {
  /** Whether the binary was located on `PATH`. */
  found: boolean;
  /** Absolute path to the binary, present only when `found` is `true`. */
  path?: string;
  /** Parsed semver string, present only when the version output was parseable. */
  version?: string;
}

/** Detection result for `terraform`, extending the base shape with a minimum-version flag. */
export interface TerraformPrerequisiteCheckResult extends PrerequisiteCheckResult {
  /**
   * Whether `version` satisfies {@link MINIMUM_TERRAFORM_VERSION}. `undefined`
   * when `version` itself could not be parsed, since there's nothing to
   * compare.
   */
  minimumVersionSatisfied?: boolean;
}

/** Combined report returned by {@link PrerequisiteService.check}. */
export interface PrerequisitesReport {
  terraform: TerraformPrerequisiteCheckResult;
  aws: PrerequisiteCheckResult;
}

/**
 * Probes for the `terraform` and `aws` CLI binaries on `PATH`, used by the
 * first-run wizard's blocking prerequisite-detection step (see
 * `openspec/changes/add-first-run-wizard`). Never attempts to install
 * anything — a missing or under-minimum-version binary is reported back to
 * the caller, which surfaces per-OS install instructions and a "Re-check"
 * action.
 *
 * Platform access is extracted into a `protected` seam so tests can
 * `vi.spyOn` it instead of stubbing the real `process.platform` global.
 */
@Injectable()
export class PrerequisiteService {
  /** Detects both `terraform` and `aws` in parallel and returns a combined report. */
  async check(): Promise<PrerequisitesReport> {
    const [terraform, aws] = await Promise.all([this.checkTerraform(), this.checkAws()]);
    return { terraform, aws };
  }

  private async checkTerraform(): Promise<TerraformPrerequisiteCheckResult> {
    const path = await this.locate('terraform');
    if (!path) return { found: false };
    const version = await this.readTerraformVersion(path);
    if (!version) return { found: true, path };
    return {
      found: true,
      path,
      version,
      minimumVersionSatisfied: PrerequisiteService.isVersionAtLeast(version, MINIMUM_TERRAFORM_VERSION),
    };
  }

  private async checkAws(): Promise<PrerequisiteCheckResult> {
    const path = await this.locate('aws');
    if (!path) return { found: false };
    const version = await this.readAwsVersion(path);
    return version ? { found: true, path, version } : { found: true, path };
  }

  /**
   * Locates `binary` on `PATH` via the platform's lookup command
   * (`which`/`where.exe`, from {@link lookupCommandFor}). Returns the first
   * non-empty stdout line, or `null` when the lookup command fails (binary
   * missing, lookup command itself missing, empty output).
   */
  protected async locate(binary: string): Promise<string | null> {
    const lookupCommand = lookupCommandFor(this.readPlatform());
    try {
      const { stdout } = await execFileAsync(lookupCommand, [binary], { timeout: PROBE_TIMEOUT_MS });
      const firstLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return firstLine ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Runs `terraform version -json` and extracts `terraform_version`, falling
   * back to parsing the plain-text `Terraform vX.Y.Z` line when `-json`
   * output is missing/unparseable (older Terraform releases). Returns
   * `undefined` — never throws — when neither form parses, since an
   * unparseable version is a degrade-gracefully case for the wizard, not a
   * hard failure.
   */
  protected async readTerraformVersion(binaryPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(binaryPath, ['version', '-json'], { timeout: PROBE_TIMEOUT_MS });
      const parsed = JSON.parse(stdout) as { terraform_version?: unknown };
      if (typeof parsed.terraform_version === 'string' && parsed.terraform_version.length > 0) {
        return parsed.terraform_version;
      }
    } catch {
      // `-json` output missing/unparseable — fall back to plain-text parsing below.
    }
    try {
      const { stdout } = await execFileAsync(binaryPath, ['version'], { timeout: PROBE_TIMEOUT_MS });
      const match = /Terraform\s+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(stdout);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  /**
   * Runs `aws --version` and extracts the semver from the `aws-cli/X.Y.Z ...`
   * banner (AWS CLI v1 and v2 both emit this prefix). Returns `undefined`
   * — never throws — when the output doesn't match, so an unrecognized
   * banner shape degrades to "found, version unknown" rather than failing
   * the whole prerequisite check.
   */
  protected async readAwsVersion(binaryPath: string): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], { timeout: PROBE_TIMEOUT_MS });
      const match = /aws-cli\/(\d+\.\d+\.\d+)/.exec(`${stdout}${stderr}`);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  /**
   * Returns `process.platform`. Extracted as a protected seam so tests can
   * `vi.spyOn` it instead of stubbing the real global.
   */
  protected readPlatform(): NodeJS.Platform {
    return process.platform;
  }

  /**
   * Lightweight `major.minor.patch` comparison — `true` when `version` is
   * greater than or equal to `minimum`. `minimum` is always a plain `X.Y.Z`
   * constant. When the numeric core is equal, a pre-release suffix on
   * `version` (e.g. `1.5.0-beta1`) does *not* satisfy the minimum — matching
   * SemVer precedence, where a pre-release sorts below the corresponding
   * stable release (`1.5.0-beta1 < 1.5.0`).
   */
  static isVersionAtLeast(version: string, minimum: string): boolean {
    const a = (version.split('-')[0] ?? '').split('.').map((n) => Number(n) || 0);
    const b = minimum.split('.').map((n) => Number(n) || 0);
    for (let i = 0; i < 3; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (av !== bv) return av > bv;
    }
    return !version.includes('-');
  }
}
