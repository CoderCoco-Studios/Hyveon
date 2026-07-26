import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AwsProfileService } from './AwsProfileService.js';

/**
 * Fixture "home directory" containing `.aws/credentials` and `.aws/config`
 * with a mix of profiles: `default` and `dev` in both files (region agrees
 * in both), `prod` defined only via a config-file `[profile prod]` section
 * (no credentials entry) — this exercises the config-file `profile <name>` →
 * `<name>` normalization real `aws configure list-profiles` output relies
 * on — and `noregion`, a credentials-only profile with no region anywhere.
 */
const FIXTURE_HOME = fileURLToPath(new URL('./__fixtures__/aws-profile', import.meta.url));

/**
 * The parent of {@link FIXTURE_HOME} has no `.aws` directory of its own —
 * used to exercise the missing-files path without needing a second,
 * otherwise-empty fixture directory.
 */
const EMPTY_HOME = dirname(FIXTURE_HOME);

/**
 * Fixture-specific `AwsProfileService` subclass overriding the protected
 * `homeDir()` seam to return a fixed directory, avoiding a `vi.spyOn` +
 * `as unknown as` cast to reach a protected method.
 */
class FixtureAwsProfileService extends AwsProfileService {
  constructor(private readonly home: string) {
    super();
  }

  protected override homeDir(): string {
    return this.home;
  }
}

/** Builds an `AwsProfileService` whose `homeDir()` seam returns `home`. */
function makeService(home: string): AwsProfileService {
  return new FixtureAwsProfileService(home);
}

describe('AwsProfileService.listProfiles', () => {
  it('should list profiles merged from both credentials and config files, sorted by name', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    expect(profiles.map((p) => p.profileName)).toEqual(['default', 'dev', 'noregion', 'prod']);
  });

  it('should pick up region from the merged profile data', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const byName = Object.fromEntries(profiles.map((p) => [p.profileName, p]));
    expect(byName['default']?.region).toBe('us-east-1');
    expect(byName['dev']?.region).toBe('us-west-2');
  });

  it('should normalize a config-file "[profile <name>]" section to just "<name>"', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const prod = profiles.find((p) => p.profileName === 'prod');
    expect(prod).toEqual({ profileName: 'prod', region: 'eu-west-1' });
  });

  it('should include a profile defined only in the config file (no credentials entry)', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    expect(profiles.some((p) => p.profileName === 'prod')).toBe(true);
  });

  it('should never expose aws_access_key_id/aws_secret_access_key or other non-region fields', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    for (const profile of profiles) {
      expect(Object.keys(profile).every((key) => key === 'profileName' || key === 'region')).toBe(true);
    }
  });

  it('should return an empty array when neither credentials nor config files exist', async () => {
    const profiles = await makeService(EMPTY_HOME).listProfiles();
    expect(profiles).toEqual([]);
  });

  it('should omit the region property entirely when a profile has none set', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const noregion = profiles.find((p) => p.profileName === 'noregion');
    expect(noregion).toEqual({ profileName: 'noregion' });
    expect(noregion).not.toHaveProperty('region');
  });
});
