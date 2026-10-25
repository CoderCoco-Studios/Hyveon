import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pickFallbackRelease, resolveFallbackFeedUrl, type GithubRelease } from './updater-fallback.js';

/** Builds a release with the given feed assets; defaults to a published, non-prerelease release. */
function release(tag: string, assets: string[], overrides: Partial<GithubRelease> = {}): GithubRelease {
  return { tag_name: tag, draft: false, prerelease: false, assets: assets.map((name) => ({ name })), ...overrides };
}

describe('pickFallbackRelease', () => {
  it('should skip the newest release when it has zero assets (the v0.7.0 incident)', () => {
    const picked = pickFallbackRelease([release('v0.7.0', []), release('v0.6.0', ['latest.yml'])], 'win32');

    expect(picked?.tag_name).toBe('v0.6.0');
  });

  it('should skip drafts and prereleases even when they carry the feed asset', () => {
    const picked = pickFallbackRelease(
      [
        release('v0.9.0', ['latest.yml'], { draft: true }),
        release('v0.8.0-rc.1', ['latest.yml'], { prerelease: true }),
        release('v0.6.0', ['latest.yml']),
      ],
      'win32',
    );

    expect(picked?.tag_name).toBe('v0.6.0');
  });

  it('should pick the greatest published_at, not the first array position', () => {
    const picked = pickFallbackRelease(
      [
        release('v0.5.0', ['latest.yml'], { published_at: '2026-01-01T00:00:00Z' }),
        release('v0.6.0', ['latest.yml'], { published_at: '2026-03-01T00:00:00Z' }),
        release('v0.4.0', ['latest.yml'], { published_at: '2025-12-01T00:00:00Z' }),
      ],
      'win32',
    );

    expect(picked?.tag_name).toBe('v0.6.0');
  });

  it('should treat a missing or invalid published_at as oldest', () => {
    const picked = pickFallbackRelease(
      [
        release('v0.9.0', ['latest.yml'], { published_at: 'not-a-date' }),
        release('v0.8.0', ['latest.yml']),
        release('v0.5.0', ['latest.yml'], { published_at: '2026-01-01T00:00:00Z' }),
      ],
      'win32',
    );

    expect(picked?.tag_name).toBe('v0.5.0');
  });

  it.each([
    ['win32', 'latest.yml'],
    ['darwin', 'latest-mac.yml'],
    ['linux', 'latest-linux.yml'],
  ] as const)('should require %s feed asset %s', (platform, asset) => {
    const releases = [release('v2', ['latest-other.yml']), release('v1', [asset])];

    expect(pickFallbackRelease(releases, platform)?.tag_name).toBe('v1');
  });

  it('should not match a different platform feed file', () => {
    expect(pickFallbackRelease([release('v1', ['latest-mac.yml'])], 'linux')).toBeNull();
  });

  it('should return null for an unsupported platform or empty list', () => {
    expect(pickFallbackRelease([release('v1', ['latest.yml'])], 'freebsd')).toBeNull();
    expect(pickFallbackRelease([], 'win32')).toBeNull();
  });
});

describe('resolveFallbackFeedUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Replaces global `fetch` with a mock that returns `impl`'s result. */
  const stubFetch = (impl: () => unknown) => vi.stubGlobal('fetch', vi.fn(impl));

  it('should return the generic-provider download URL for the picked release tag', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([release('v0.7.0', []), release('v0.6.0', ['latest.yml'])]) }),
    );

    await expect(resolveFallbackFeedUrl('win32')).resolves.toBe(
      'https://github.com/CoderCoco-Studios/Hyveon/releases/download/v0.6.0',
    );
  });

  it('should query the releases API for the Hyveon repo', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

    await resolveFallbackFeedUrl('win32');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/CoderCoco-Studios/Hyveon/releases?per_page=10',
    );
  });

  it('should return null when no release qualifies', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve([release('v0.7.0', [])]) }));

    await expect(resolveFallbackFeedUrl('win32')).resolves.toBeNull();
  });

  it('should return null on a non-200 response', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve([]) }));

    await expect(resolveFallbackFeedUrl('win32')).resolves.toBeNull();
  });

  it('should return null when fetch rejects', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));

    await expect(resolveFallbackFeedUrl('win32')).resolves.toBeNull();
  });

  it('should return null when the body is not an array', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: 'rate limited' }) }));

    await expect(resolveFallbackFeedUrl('win32')).resolves.toBeNull();
  });
});
