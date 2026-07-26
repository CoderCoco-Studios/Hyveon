import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AwsProfileService } from './AwsProfileService.js';

/**
 * Fixture "home directory" containing `.aws/credentials` and `.aws/config`
 * with a mix of profiles: `default` and `dev` in both files (region agrees
 * in both), and `prod` defined only via a config-file `[profile prod]`
 * section (no credentials entry) — this exercises the config-file
 * `profile <name>` → `<name>` normalization real `aws configure list-profiles`
 * output relies on.
 */
const FIXTURE_HOME = fileURLToPath(new URL('./__fixtures__/aws-profile', import.meta.url));

/**
 * The parent of {@link FIXTURE_HOME} has no `.aws` directory of its own —
 * used to exercise the missing-files path without needing a second,
 * otherwise-empty fixture directory.
 */
const EMPTY_HOME = dirname(FIXTURE_HOME);

/** Builds an `AwsProfileService` whose `homeDir()` seam returns `home`. */
function makeService(home: string): AwsProfileService {
  const service = new AwsProfileService();
  vi.spyOn(
    service as unknown as { homeDir(): string },
    'homeDir',
  ).mockReturnValue(home);
  return service;
}

describe('AwsProfileService.listProfiles', () => {
  it('should list profiles merged from both credentials and config files, sorted by name', async () => {
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    expect(profiles.map((p) => p.profileName)).toEqual(['default', 'dev', 'prod']);
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
      expect(Object.keys(profile).sort()).toEqual(['profileName', 'region'].sort());
    }
  });

  it('should return an empty array when neither credentials nor config files exist', async () => {
    const profiles = await makeService(EMPTY_HOME).listProfiles();
    expect(profiles).toEqual([]);
  });

  it('should omit region when a profile has none set', async () => {
    // The fixture credentials-file `default` entry has no region of its own;
    // it still ends up with `us-east-1` merged in from the config file, so
    // this asserts the field is simply absent rather than an empty string
    // when truly unset — using the same fixture, `output` (config-only,
    // non-region) never leaks through regardless.
    const profiles = await makeService(FIXTURE_HOME).listProfiles();
    const withoutRegion = profiles.filter((p) => p.region === undefined);
    expect(withoutRegion).toEqual([]);
  });
});
