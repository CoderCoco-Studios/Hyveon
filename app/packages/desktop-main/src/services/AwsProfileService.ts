import { homedir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parseKnownFiles } from '@smithy/shared-ini-file-loader';
import type { ParsedIniData } from '@smithy/types';

/**
 * Summary of a single AWS CLI profile discovered in `~/.aws/credentials` or
 * `~/.aws/config`. Deliberately minimal — never carries
 * `aws_access_key_id`/`aws_secret_access_key` or any other sensitive field,
 * so this shape is safe to send over IPC to the renderer.
 */
export interface AwsProfileSummary {
  profileName: string;
  region?: string;
}

/**
 * Discovers AWS CLI profiles for the first-run wizard's credentials step
 * (see `openspec/changes/add-first-run-wizard`). Delegates parsing to
 * `@smithy/shared-ini-file-loader`'s `parseKnownFiles` — the same loader the
 * AWS SDK for JS itself uses to resolve profiles — rather than hand-rolling
 * INI parsing, so profile discovery matches `aws configure list-profiles`
 * semantics (config-file `[profile <name>]` sections normalized to
 * `<name>`, both files merged into one profile map).
 */
@Injectable()
export class AwsProfileService {
  /**
   * Lists every profile found across `~/.aws/credentials` and
   * `~/.aws/config`, sorted alphabetically by name. Only `profileName` and
   * `region` are read out of each profile's parsed fields — every other
   * field (including credential material) is left untouched.
   */
  async listProfiles(): Promise<AwsProfileSummary[]> {
    const parsed = await this.parseFiles();
    return Object.keys(parsed)
      .sort((a, b) => a.localeCompare(b))
      .map((profileName) => ({
        profileName,
        region: parsed[profileName]?.['region'],
      }));
  }

  /**
   * Parses `~/.aws/credentials` and `~/.aws/config` (merged the same way the
   * AWS CLI does). Missing files degrade to an empty map rather than
   * throwing — `parseKnownFiles` swallows `ENOENT` internally. `ignoreCache`
   * is always set so a profile added after the app started is picked up on
   * the next call rather than serving the loader's internal file cache.
   */
  protected async parseFiles(): Promise<ParsedIniData> {
    const home = this.homeDir();
    return parseKnownFiles({
      filepath: join(home, '.aws', 'credentials'),
      configFilepath: join(home, '.aws', 'config'),
      ignoreCache: true,
    });
  }

  /**
   * Returns the current user's home directory. Extracted as a protected
   * seam so tests can point at a fixture directory instead of the real
   * `~/.aws` files.
   */
  protected homeDir(): string {
    return homedir();
  }
}
