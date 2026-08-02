/**
 * Unit tests for `resolveAwsCredentialSource` — the single decision
 * `BootstrapService` and `IamCheckService` would otherwise each duplicate
 * privately. `BootstrapService.test.ts`/`IamCheckService.test.ts` already
 * cover this decision indirectly (via `store.getPastedCredentials` call
 * assertions); this file tests it directly, once, as its own unit.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Builds an `ElectronStoreService` stub whose `aws.profile` and pasted-credentials lookup are controlled directly. */
function makeStore(
  profile: string | undefined,
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string; region?: string },
): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile } : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(pastedCredentials),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

describe('resolveAwsCredentialSource', () => {
  it('should resolve kind "none" when no profile is stored', () => {
    const store = makeStore(undefined);

    const source = resolveAwsCredentialSource(store);

    expect(source).toEqual({ kind: 'none' });
    expect(store.getPastedCredentials).not.toHaveBeenCalled();
  });

  it('should resolve kind "pasted" with decrypted keys when the profile matches a pasted-credentials entry', () => {
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    const source = resolveAwsCredentialSource(store);

    expect(source).toEqual({ kind: 'pasted', profile: 'hyveon-pasted', accessKeyId: 'AKID', secretAccessKey: 'SECRET' });
    expect(store.getPastedCredentials).toHaveBeenCalledWith('hyveon-pasted');
  });

  it('should resolve kind "profile" when the stored profile has no pasted-credentials entry', () => {
    const store = makeStore('default', undefined);

    const source = resolveAwsCredentialSource(store);

    expect(source).toEqual({ kind: 'profile', profile: 'default' });
  });

  it('should prefer the pasted-credentials entry over treating the same name as a real CLI profile', () => {
    // Same name could in principle collide with a real ~/.aws profile — the
    // pasted lookup must win, matching Bootstrap/IamCheckService's pre-existing behaviour.
    const store = makeStore('default', { accessKeyId: 'AKID', secretAccessKey: 'SECRET' });

    const source = resolveAwsCredentialSource(store);

    expect(source.kind).toBe('pasted');
  });
});
