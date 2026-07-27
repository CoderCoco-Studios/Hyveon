import { homedir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parseKnownFiles } from '@smithy/shared-ini-file-loader';
import type { ParsedIniData } from '@smithy/types';
import { SafeStorageService } from './SafeStorageService.js';
import { ElectronStoreService } from './ElectronStoreService.js';

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

/** Default profile name used for the wizard's "paste keys instead" flow when the operator doesn't supply one. */
export const DEFAULT_PASTED_PROFILE_NAME = 'hyveon-pasted';

/** Plaintext input to {@link AwsProfileService.savePastedCredentials}. */
export interface SavePastedCredentialsInput {
  /** Defaults to {@link DEFAULT_PASTED_PROFILE_NAME} when omitted. */
  profileName?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/**
 * Thrown by {@link AwsProfileService.savePastedCredentials} when the OS
 * keychain (via `SafeStorageService`) is unavailable. Pasted credentials are
 * never persisted in plaintext, so this flow has no fallback — the caller
 * must surface the error and refuse to save rather than silently degrading
 * (unlike `ElectronStoreService`'s generic encrypted accessors, which
 * transparently degrade to plaintext outside Electron for convenience in
 * tests/CI).
 */
export class SafeStorageUnavailableError extends Error {
  constructor() {
    super(
      'Cannot save pasted AWS credentials: the OS keychain (safeStorage) is unavailable. ' +
        'Pasted keys are never stored in plaintext — pick an existing AWS CLI profile instead.',
    );
    this.name = 'SafeStorageUnavailableError';
  }
}

/**
 * Thrown by {@link AwsProfileService.savePastedCredentials} when
 * `accessKeyId` or `secretAccessKey` is blank/whitespace-only — nothing is
 * persisted in that case.
 */
export class InvalidPastedCredentialsError extends Error {
  constructor(field: 'accessKeyId' | 'secretAccessKey') {
    super(`Cannot save pasted AWS credentials: "${field}" must not be blank.`);
    this.name = 'InvalidPastedCredentialsError';
  }
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
  constructor(
    private readonly safeStorage: SafeStorageService,
    private readonly store: ElectronStoreService,
  ) {}

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
      .map((profileName) => {
        const region = parsed[profileName]?.['region'];
        return region ? { profileName, region } : { profileName };
      });
  }

  /**
   * Saves pasted AWS credentials from the wizard's "paste keys instead" flow.
   * Defaults `profileName` to {@link DEFAULT_PASTED_PROFILE_NAME} when
   * omitted. Throws {@link SafeStorageUnavailableError} — without writing
   * anything — when the OS keychain is unavailable, rather than falling
   * back to plaintext storage.
   *
   * @returns The profile name the credentials were saved under.
   */
  savePastedCredentials(input: SavePastedCredentialsInput): { profileName: string } {
    if (!this.safeStorage.isAvailable()) {
      throw new SafeStorageUnavailableError();
    }
    if (!input.accessKeyId.trim()) throw new InvalidPastedCredentialsError('accessKeyId');
    if (!input.secretAccessKey.trim()) throw new InvalidPastedCredentialsError('secretAccessKey');
    const profileName = input.profileName?.trim() || DEFAULT_PASTED_PROFILE_NAME;
    this.store.setPastedCredentials(profileName, {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      region: input.region,
    });
    return { profileName };
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
